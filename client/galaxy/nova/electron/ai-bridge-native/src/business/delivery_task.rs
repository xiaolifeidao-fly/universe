use super::{
    inline_json, local_resources, ErrorClass, KindDecl, Metering, ProbeStatus, Provider, UnitEvent,
    UnitIo, WorkUnit, WorkspaceRef,
};
use crate::config::schema::PoolExec;
use crate::core::paths::expand_home;
use crate::log_debug;
use async_stream::stream;
use futures_util::stream::BoxStream;
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// delivery.task 的节点 provider：把一个回合交给本机的 agent 执行器跑。
//
// 它刻意不认识 delivery-task-planner 的内部结构，只约定一套进程协议：
//   stdin  收到一个 JSON（回合入参 + 续接上下文）
//   stdout 吐 NDJSON 事件流，每行一个 { kind, data?, usage? }
//   最后一行 kind=done 时带 usage 与 contextDelta
// 这样换执行器只要换命令，不用改这里；而 agent 在主人机器上跑命令、写文件，
// 这条边界由节点自己守，不信任 Hub（原则 8）。

pub struct PlannerBridgeProvider {
    name: String,
    exec: PoolExec,
}

impl PlannerBridgeProvider {
    pub fn new(name: impl Into<String>, exec: PoolExec) -> Self {
        Self { name: name.into(), exec }
    }
}

fn command_for(exec: &PoolExec) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(&exec.command);
    command.args(&exec.args);
    if let Some(cwd) = &exec.cwd {
        command.current_dir(expand_home(cwd));
    }
    if let Some(env) = &exec.env {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    command
}

#[async_trait::async_trait]
impl Provider for PlannerBridgeProvider {
    fn kinds(&self) -> Vec<KindDecl> {
        vec![KindDecl { kind: "delivery.task".into(), versions: vec![1], provider: self.name.clone() }]
    }

    async fn probe(&self) -> ProbeStatus {
        let resources = local_resources();
        // 只确认执行器起得来，不真的跑一个回合：探测不该在主人的工作区里留下痕迹。
        let mut command = tokio::process::Command::new(&self.exec.command);
        command.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match command.status().await {
            Ok(_) => ProbeStatus { resources, upstream_ok: true, detail: None },
            Err(_) => ProbeStatus {
                resources,
                upstream_ok: false,
                detail: Some(format!("执行器不可用：{}", self.exec.command)),
            },
        }
    }

    fn run(&self, unit: WorkUnit, io: UnitIo) -> BoxStream<'static, UnitEvent> {
        let exec = self.exec.clone();
        Box::pin(stream! {
            // TurnPayload 是交给执行器的东西。字段名与服务端 dto 对齐，
            // 执行器只读它，不需要知道共享池的存在。
            let mut payload = json!({
                "unitId": unit.id,
                "sid": unit.sid.clone().unwrap_or_default(),
                "seq": unit.seq.unwrap_or(0),
                "op": unit.op.map(|op| serde_json::to_value(op).unwrap_or(Value::Null))
                    .and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "turn".into()),
                "turn": inline_json(&unit, "turn", json!({})),
            });
            // 续接上下文只在跨节点那一次才有：同节点续跑时执行器手里还有 thread。
            let resume = inline_json(&unit, "resume", Value::Null);
            if !resume.is_null() {
                payload["resume"] = resume;
            }

            // NDJSON 而不是原始字节：session 的上行是事件流，Hub 收进日志供消费者随时订阅。
            yield UnitEvent::Head {
                status: 200,
                headers: [("content-type".to_string(), "application/x-ndjson".to_string())].into(),
            };

            let mut command = command_for(&exec);
            command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(e) => {
                    yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", false,
                        format!("执行器起不来：{e}"));
                    return;
                }
            };

            if let Some(mut stdin) = child.stdin.take() {
                let line = payload.to_string() + "\n";
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
            // stderr 只进本机日志，不上行：它可能带主人的路径与环境变量。
            if let Some(stderr) = child.stderr.take() {
                let unit_id = io.unit_id.clone();
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        log_debug!("planner_stderr", "unitId": unit_id, "bytes": line.len());
                    }
                });
            }

            let stdout = child.stdout.take();
            // 取消与超时都是「把执行器杀掉」，走同一条路。
            let killer = child.id();
            let cancel = io.cancel.clone();
            let timeout = exec.timeout_ms;
            let guard = tokio::spawn(async move {
                let deadline = async {
                    match timeout {
                        Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    () = cancel.cancelled() => {}
                    () = deadline => {}
                }
                if let Some(pid) = killer {
                    kill_process(pid);
                }
            });

            let mut usage = Metering::new();
            let mut context_delta: Option<Value> = None;
            let mut workspace_ref: Option<WorkspaceRef> = None;
            let mut saw_done = false;

            if let Some(stdout) = stdout {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let text = line.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let Ok(event) = serde_json::from_str::<Value>(text) else {
                        // 执行器吐了不合规的一行：当成一条日志事件送上去，别整段丢掉 ——
                        // 排障时要能看出是执行器的问题。
                        let clipped: String = text.chars().take(512).collect();
                        yield UnitEvent::ndjson(&json!({ "kind": "malformed", "data": { "line": clipped } }));
                        continue;
                    };
                    if let Some(reported) = event.get("usage").and_then(Value::as_object) {
                        for (key, value) in reported {
                            usage.insert(key.clone(), value.clone());
                        }
                    }
                    if let Some(delta) = event.get("contextDelta") {
                        if !delta.is_null() {
                            context_delta = Some(delta.clone());
                        }
                    }
                    if let Some(reference) = event.get("workspaceRef") {
                        if let Ok(parsed) = serde_json::from_value::<WorkspaceRef>(reference.clone()) {
                            workspace_ref = Some(parsed);
                        }
                    }
                    if event.get("kind").and_then(Value::as_str) == Some("done") {
                        saw_done = true;
                        continue;
                    }
                    yield UnitEvent::ndjson(&event);
                }
            }

            let code = child.wait().await.ok().and_then(|status| status.code()).unwrap_or(-1);
            guard.abort();
            if io.cancel.is_cancelled() {
                yield UnitEvent::error(ErrorClass::Protocol, "unit_cancelled", false, "已取消");
                return;
            }
            if code != 0 && !saw_done {
                yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", false,
                    format!("执行器以 {code} 退出"));
                return;
            }
            yield UnitEvent::Done(Box::new(super::DoneEvent {
                usage, context_delta, workspace_ref, ..Default::default()
            }));
        })
    }
}

/// SIGTERM 而不是 kill()：执行器可能要收尾（写 checkpoint、关子进程）。
pub fn kill_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
}
