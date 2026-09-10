use super::{
    inline_json, local_resources, ArtifactRef, DoneEvent, ErrorClass, KindDecl, Metering,
    NamedArtifact, ProbeStatus, Provider, UnitEvent, UnitIo, WorkUnit,
};
use crate::log_debug;
use async_stream::stream;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// video.edit.render 的节点 provider：本机 ffmpeg 渲染一条时间线。
//
// 三段都不经 Hub：素材从 OSS 直取，产物直传 OSS，中间只有进度事件走通道。
// 这正是 job 原语的意义 —— GB 级文件让 Hub 转发一遍是纯粹的浪费。

#[derive(Debug, Clone, Deserialize)]
struct Clip {
    #[serde(default)]
    #[allow(dead_code)]
    src: Option<ArtifactRef>,
    #[serde(rename = "in", default)]
    start: Option<f64>,
    #[serde(default)]
    out: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct TimelineBody {
    clips: Vec<Clip>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct OutputSpec {
    #[serde(default)]
    codec: Option<String>,
    #[serde(default)]
    resolution: Option<String>,
    #[serde(default)]
    fps: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct Timeline {
    timeline: TimelineBody,
    #[serde(default)]
    output: Option<OutputSpec>,
}

pub struct FfmpegLocalProvider {
    name: String,
    /// 允许主人指定自己编的 ffmpeg（带硬件编码那种）。
    binary: String,
    extra_args: Vec<String>,
    client: reqwest::Client,
}

impl FfmpegLocalProvider {
    pub fn new(
        name: impl Into<String>,
        binary: Option<String>,
        extra_args: Vec<String>,
        client: reqwest::Client,
    ) -> Self {
        Self {
            name: name.into(),
            binary: binary.unwrap_or_else(|| "ffmpeg".into()),
            extra_args,
            client,
        }
    }
}

#[async_trait::async_trait]
impl Provider for FfmpegLocalProvider {
    fn kinds(&self) -> Vec<KindDecl> {
        vec![KindDecl { kind: "video.edit.render".into(), versions: vec![1], provider: self.name.clone() }]
    }

    async fn probe(&self) -> ProbeStatus {
        let resources = local_resources();
        let ok = tokio::process::Command::new(&self.binary)
            .arg("-version")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false);
        ProbeStatus {
            resources,
            upstream_ok: ok,
            detail: (!ok).then(|| "本机没有可用的 ffmpeg".to_string()),
        }
    }

    fn run(&self, unit: WorkUnit, io: UnitIo) -> BoxStream<'static, UnitEvent> {
        let binary = self.binary.clone();
        let extra_args = self.extra_args.clone();
        let client = self.client.clone();

        Box::pin(stream! {
            let spec: Option<Timeline> = serde_json::from_value(inline_json(&unit, "timeline", Value::Null)).ok();
            let Some(spec) = spec.filter(|s| !s.timeline.clips.is_empty()) else {
                yield UnitEvent::error(ErrorClass::InputFault, "invalid_body", false, "时间线为空");
                return;
            };
            let Some(work_dir) = io.work_dir.clone() else {
                yield UnitEvent::error(ErrorClass::NodeFault, "capability_mismatch", true, "缺少工作目录");
                return;
            };
            let Some(callbacks) = io.callbacks.clone() else {
                yield UnitEvent::error(ErrorClass::NodeFault, "capability_mismatch", true, "节点无法申请产物地址");
                return;
            };

            // NDJSON：job 的上行是事件流，进度与产物都走它。
            yield UnitEvent::Head {
                status: 200,
                headers: [("content-type".to_string(), "application/x-ndjson".to_string())].into(),
            };

            let started = Instant::now();
            if let Err(e) = create_private_dir(&work_dir).await {
                yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, e);
                return;
            }

            // 1. 取素材。信封里的 ref 带着 Hub 现签的短期地址，直连 OSS。
            let refs: Vec<&ArtifactRef> = unit.inputs.as_deref().unwrap_or(&[])
                .iter()
                .filter(|item| item.name == "clip")
                .filter_map(|item| item.reference.as_ref())
                .filter(|reference| reference.url.is_some())
                .collect();
            let mut locals: Vec<PathBuf> = vec![];
            for (index, reference) in refs.iter().enumerate() {
                let target = work_dir.join(format!("clip-{index}{}", extension_of(reference)));
                yield UnitEvent::ndjson(&json!({ "kind": "progress",
                    "data": { "pct": pct_of(index, refs.len(), 0, 30), "stage": "download" } }));
                if let Err(e) = download(&client, reference.url.as_deref().unwrap(), &target, &io).await {
                    if io.cancel.is_cancelled() {
                        yield UnitEvent::error(ErrorClass::Protocol, "unit_cancelled", false, "已取消");
                    } else {
                        yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, e);
                    }
                    return;
                }
                locals.push(target);
            }
            if locals.is_empty() {
                yield UnitEvent::error(ErrorClass::InputFault, "artifact_missing", false, "没有可用的素材");
                return;
            }

            // 2. 渲染。用 concat demuxer 而不是 filter_complex：
            //    前者不重编码就能拼接同规格素材，快一个数量级。
            let list_file = work_dir.join("concat.txt");
            let list_body = locals.iter()
                .map(|path| format!("file '{}'", path.to_string_lossy().replace('\'', "'\\''")))
                .collect::<Vec<_>>()
                .join("\n") + "\n";
            if let Err(e) = tokio::fs::write(&list_file, list_body).await {
                yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, e.to_string());
                return;
            }
            let output_path = work_dir.join("output.mp4");
            let args = build_args(&extra_args, &list_file, &output_path, spec.output.as_ref());

            log_debug!("ffmpeg_start", "unitId": io.unit_id, "clips": locals.len(), "args": args.len());
            let cpu_start = children_cpu_seconds();
            let mut render = Box::pin(run_ffmpeg(binary.clone(), args, io.cancel.clone()));
            loop {
                match render.next().await {
                    Some(Ok(pct)) => {
                        yield UnitEvent::ndjson(&json!({ "kind": "progress", "data": {
                            "pct": pct_of(0, 1, 30, 90) + (pct * 60.0).round() as i64, "stage": "render" } }));
                    }
                    Some(Err(message)) => {
                        if io.cancel.is_cancelled() {
                            yield UnitEvent::error(ErrorClass::Protocol, "unit_cancelled", false, "已取消");
                        } else {
                            yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, message);
                        }
                        return;
                    }
                    None => break,
                }
            }
            let cpu = (children_cpu_seconds() - cpu_start).max(0.0);

            // 3. 直传 OSS。产物字节同样不经 Hub。
            let size = match tokio::fs::metadata(&output_path).await {
                Ok(info) => info.len(),
                Err(e) => {
                    yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, e.to_string());
                    return;
                }
            };
            yield UnitEvent::ndjson(&json!({ "kind": "progress", "data": { "pct": 92, "stage": "upload" } }));
            let reference = match callbacks.sign_artifact(&unit.id, "output.mp4", "video/mp4", size).await {
                Ok(reference) => reference,
                Err(message) => {
                    yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, message);
                    return;
                }
            };
            let Some(url) = reference.url.clone() else {
                yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, "Hub 没有返回上传地址");
                return;
            };
            if let Err(e) = upload(&client, &url, &output_path, size, "video/mp4", &io).await {
                if io.cancel.is_cancelled() {
                    yield UnitEvent::error(ErrorClass::Protocol, "unit_cancelled", false, "已取消");
                } else {
                    yield UnitEvent::error(ErrorClass::NodeFault, "node_offline", true, e);
                }
                return;
            }

            let mut usage = Metering::new();
            usage.insert("video.output_seconds".into(), json!(duration_of(&spec).round() as i64));
            usage.insert("cpu.seconds".into(), json!(cpu.round() as i64));
            usage.insert("storage.bytes".into(), json!(size));
            // 上传地址是一次性的，不随产物引用交出去。
            let clean = ArtifactRef { url: None, ..reference };
            yield UnitEvent::ndjson(&json!({ "kind": "artifact", "data": clean }));
            yield UnitEvent::ndjson(&json!({ "kind": "progress", "data": { "pct": 100, "stage": "done" } }));
            log_debug!("ffmpeg_done", "unitId": io.unit_id, "ms": started.elapsed().as_millis() as u64, "bytes": size);
            yield UnitEvent::Done(Box::new(DoneEvent {
                usage,
                outputs: Some(vec![NamedArtifact { name: "output.mp4".into(), reference: clean }]),
                ..Default::default()
            }));
        })
    }
}

async fn create_private_dir(dir: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).await;
    }
    Ok(())
}

fn build_args(extra: &[String], list_file: &Path, output: &Path, spec: Option<&OutputSpec>) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1",
        "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"]
        .iter().map(|s| s.to_string()).collect();
    args.push(list_file.to_string_lossy().into_owned());

    let mut filters: Vec<String> = vec![];
    if let Some(resolution) = spec.and_then(|s| s.resolution.as_ref()) {
        filters.push(format!("scale={}", resolution.replace('x', ":")));
    }
    if let Some(fps) = spec.and_then(|s| s.fps) {
        filters.push(format!("fps={}", trim_number(fps)));
    }
    if filters.is_empty() {
        // 没有任何转换时直接拷流：拼接不需要重编码，这是 concat demuxer 的全部意义。
        args.push("-c".into());
        args.push("copy".into());
    } else {
        args.push("-vf".into());
        args.push(filters.join(","));
        args.push("-c:v".into());
        args.push(codec_of(spec.and_then(|s| s.codec.as_deref())).into());
    }
    args.extend(extra.iter().cloned());
    args.push(output.to_string_lossy().into_owned());
    args
}

fn trim_number(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

fn codec_of(codec: Option<&str>) -> &'static str {
    match codec {
        Some("h265") | Some("hevc") => "libx265",
        Some("vp9") => "libvpx-vp9",
        _ => "libx264",
    }
}

/// 解析 -progress 的键值输出，产出 0..1 的完成度。
/// ffmpeg 不报总时长，所以这里只按「还在动」推进，不谎报具体百分比。
fn run_ffmpeg(
    binary: String,
    args: Vec<String>,
    cancel: crate::core::request::Cancel,
) -> impl futures_util::Stream<Item = Result<f64, String>> {
    stream! {
        let mut command = tokio::process::Command::new(&binary);
        command.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => { yield Err(format!("ffmpeg 起不来：{e}")); return; }
        };
        if let Some(pid) = child.id() {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                cancel.cancelled().await;
                super::delivery_task::kill_process(pid);
            });
        }
        let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = std::sync::Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut buffer = tail.lock().unwrap();
                    buffer.push_str(&line);
                    buffer.push('\n');
                    let overflow = buffer.chars().count().saturating_sub(2048);
                    if overflow > 0 {
                        *buffer = buffer.chars().skip(overflow).collect();
                    }
                }
            });
        }

        let mut last_pct = 0.0f64;
        if let Some(stdout) = child.stdout.take() {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim() == "progress=end" {
                    yield Ok(1.0);
                    continue;
                }
                last_pct = (last_pct + 0.02).min(0.95);
                yield Ok(last_pct);
            }
        }
        match child.wait().await {
            Ok(status) if status.success() => {}
            Ok(status) => {
                let tail = stderr_tail.lock().unwrap().clone();
                let tail: String = tail.chars().rev().take(512).collect::<Vec<_>>().into_iter().rev().collect();
                yield Err(format!("ffmpeg 以 {} 退出：{tail}", status.code().unwrap_or(-1)));
            }
            Err(e) => yield Err(e.to_string()),
        }
    }
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    io: &UnitIo,
) -> Result<(), String> {
    let response = tokio::select! {
        biased;
        () = io.cancel.cancelled() => return Err("已取消".into()),
        result = client.get(url).send() => result.map_err(|e| e.without_url().to_string())?,
    };
    if !response.status().is_success() {
        return Err(format!("取素材失败：{}", response.status().as_u16()));
    }
    let mut file = tokio::fs::File::create(target).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            biased;
            () = io.cancel.cancelled() => return Err("已取消".into()),
            chunk = stream.next() => chunk,
        };
        match next {
            Some(Ok(chunk)) => file.write_all(&chunk).await.map_err(|e| e.to_string())?,
            Some(Err(e)) => return Err(e.without_url().to_string()),
            None => break,
        }
    }
    file.flush().await.map_err(|e| e.to_string())
}

async fn upload(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    size: u64,
    content_type: &str,
    io: &UnitIo,
) -> Result<(), String> {
    let file = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
    let response = tokio::select! {
        biased;
        () = io.cancel.cancelled() => return Err("已取消".into()),
        result = client.put(url)
            .header("content-type", content_type)
            .header("content-length", size.to_string())
            .body(body)
            .send() => result.map_err(|e| e.without_url().to_string())?,
    };
    if !response.status().is_success() {
        return Err(format!("上传产物失败：{}", response.status().as_u16()));
    }
    Ok(())
}

fn duration_of(spec: &Timeline) -> f64 {
    spec.timeline.clips.iter().fold(0.0, |total, clip| {
        let span = clip.out.unwrap_or(0.0) - clip.start.unwrap_or(0.0);
        total + if span > 0.0 { span } else { 0.0 }
    })
}

fn extension_of(reference: &ArtifactRef) -> String {
    match reference.key.rfind('.') {
        Some(dot) if dot > 0 => reference.key[dot..].to_string(),
        _ => ".mp4".into(),
    }
}

fn pct_of(index: usize, total: usize, from: i64, to: i64) -> i64 {
    if total == 0 {
        return from;
    }
    from + (((index + 1) as f64 / total as f64) * (to - from) as f64).round() as i64
}

/// 子进程累计 CPU 时间（秒）。
///
/// TS 侧用的是 `process.cpuUsage()` —— 那只统计 Node 自己，ffmpeg 跑在子进程里，
/// 所以算出来一直接近 0。这里用 RUSAGE_CHILDREN，报的是真的被消耗掉的 CPU。
fn children_cpu_seconds() -> f64 {
    #[cfg(unix)]
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) == 0 {
            let user = usage.ru_utime.tv_sec as f64 + usage.ru_utime.tv_usec as f64 / 1e6;
            let system = usage.ru_stime.tv_sec as f64 + usage.ru_stime.tv_usec as f64 / 1e6;
            return user + system;
        }
    }
    0.0
}
