"use client";

import axios, { type AxiosInstance } from "axios";

/**
 * 本机 ai-bridge 配置向导的接口。
 *
 * **刻意不走 `@/utils/axios`** —— 这是本控制台唯一的例外，因为那层封装的三件事在这里
 * 恰好全是错的：
 *   · baseURL 是 `/api`，请求会走 Next 代理打到 Go 服务端；这里要打的是**用户自己
 *     机器上**的那个进程，压根不经过平台。
 *   · 它自动注入 Galaxy 的登录 token。那是平台凭据，不该发给任何别的源 ——
 *     哪怕对面是用户自己的 bridge。
 *   · 它按 `{success, code, data}` 信封解包；bridge 吐的是裸 JSON，解出来是 undefined。
 *
 * 连接参数从当前页面的 **fragment** 里取（`#bridge=<端口>&t=<令牌>`）。那串是本机
 * 跑 `ai-bridge pool setup --console <控制台地址>` 时打印/打开的。
 *
 * 用 fragment 而不是 query：fragment 永远不发给服务器，所以令牌不会进本控制台
 * 服务器的访问日志、也不会出现在 Referer 里。令牌只在这台机器的浏览器和本机进程
 * 之间流转，不经过 Hub，向导退出后即失效。
 */

/** 本机 ai-bridge 的固定端口。常驻接口就挂在这儿，控制台靠它做探测。 */
export const BRIDGE_PORT = 39217;

/**
 * 一次本机连接。
 *
 * `token` **只有从向导地址进来时才有**（首次引导那一档，机器还没配对、Hub 还没锁定，
 * 所以必须有令牌闸）。配对之后常驻接口不发令牌 —— 那一档的凭据是配对码本身，
 * 这才使得「随时打开控制台就能重新配对」成为可能，不用回终端跑命令。
 */
export interface BridgeConn {
  port: number;
  token?: string;
  /** 常驻接口（已配对的机器）。为 false 表示是临时向导。 */
  resident: boolean;
}

/** /api/ping 的返回。只有布尔值，机器指纹（机器名、能力、配置路径、Hub 地址）在鉴权后面。 */
export interface BridgePing {
  running: boolean;
  resident: boolean;
  paired: boolean;
  nodeId?: string;
  /**
   * 本机 ai-bridge 连的是不是**调用方问的那个** Hub。只有传了 hubUrl 才有值。
   *
   * 刻意是布尔而不是地址：连错 Hub 的节点不会出现在任何列表里，控制台需要认出
   * 这种故障，但不需要（也不该）知道它连去了哪儿 —— 那是机器指纹，而这个端点
   * 不鉴权、对所有来源开放。老版本 bridge 不返回它，所以拿不到时不显示结论。
   */
  hubMatches?: boolean;
}

/** 本机探到的一种能力。available=false 时 detail 是人话原因，直接展示。 */
export interface BridgeCapability {
  kind: string;
  provider: string;
  available: boolean;
  detail: string;
  upstream?: string;
}

export interface BridgeResources {
  platform?: string;
  cpus?: number;
  totalMemMB?: number;
  freeMemMB?: number;
}

export interface BridgeState {
  configPath: string;
  hubURL: string;
  displayName: string;
  resources: BridgeResources;
  capabilities: BridgeCapability[];
  paired: boolean;
  nodeId?: string;
}

export interface BridgePairPayload {
  /** 常驻接口会忽略它并用启动时锁定的那个 Hub，所以那一档不用传。 */
  hubURL?: string;
  code: string;
  displayName?: string;
}

export interface BridgePairResult {
  nodeId: string;
  tokenFile: string;
  configPath: string;
  backup?: string;
  /** 临时向导：还剩几秒自动退出。 */
  closingInSec?: number;
  /** 常驻接口：进程会退出并由 supervisor 用新身份拉起。 */
  restarting?: boolean;
}

/**
 * 从当前地址里读连接参数。读不到就是「没从向导那条地址进来」，不是错误 ——
 * 调用方据此退回「给配对码 + 让用户去那台机器上跑命令」的老路子。
 */
export function readBridgeConn(): BridgeConn | null {
  if (typeof window === "undefined") return null;
  // 只认 fragment。刻意不兼容旧的 ?t= 写法 —— 留着它就等于留着那条会写进
  // 服务器日志的路径，而且没人会主动改用新的。
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const port = Number(params.get("bridge"));
  const token = params.get("t") ?? "";
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) return null;
  return { port, token, resident: false };
}

/**
 * 探一探本机有没有 ai-bridge 常驻接口在跑。
 *
 * 这是「不带任何 URL 参数也能配置本机」的入口 —— 没有它，控制台就只能等着
 * 被那条命令打印的地址触发，也就回到了「只有装插件那一次能配」。
 *
 * 探不到不是错误（没装、没跑、或者还没配对过），调用方据此退回「去那台机器上
 * 跑命令」的老路子。
 */
export async function pingBridge(options: { hubUrl?: string; port?: number } = {}): Promise<BridgePing | null> {
  const port = options.port ?? BRIDGE_PORT;
  try {
    const response = await axios.get<BridgePing>(`http://127.0.0.1:${port}/api/ping`, {
      timeout: 3_000,
      // 传了才问「你连的是不是这个」。bridge 那边没带就不答，所以不传等于旧行为。
      ...(options.hubUrl ? { params: { hub: options.hubUrl } } : {}),
    });
    return response.data?.running ? response.data : null;
  } catch {
    return null;
  }
}

/**
 * 把 fragment 里的 bridge/t 抹掉，但不动 query、不刷新页面。
 *
 * fragment 虽然不发给服务器，但仍然留在地址栏、浏览器历史和「复制当前网址」里。
 * 配完就擦掉 —— 页面状态已经在内存里，不需要它继续挂在 URL 上。
 */
export function clearBridgeConnFromUrl(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return;
  const params = new URLSearchParams(hash);
  if (!params.has("bridge") && !params.has("t")) return;
  params.delete("bridge");
  params.delete("t");
  const rest = params.toString();
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}${rest ? `#${rest}` : ""}`);
}

/** 每次调用现建：连接参数可能在一次会话里变（用户重新从向导进来一次）。 */
function client(conn: BridgeConn): AxiosInstance {
  return axios.create({
    baseURL: `http://127.0.0.1:${conn.port}`,
    // 令牌走自定义头，不走 cookie —— bridge 那边也刻意没开 Allow-Credentials。
    // 常驻接口没有令牌，这里就不发这个头。
    headers: conn.token ? { "x-setup-token": conn.token } : {},
    // 本机请求，慢只可能是探测在跑外部命令（ffmpeg -version 之类）。
    timeout: 20_000,
  });
}

/**
 * bridge 的错误体是 `{error: "人话"}`，而且那句人话通常直接告诉用户该敲哪条命令
 * （「请运行 claude auth login」），比任何前端兜底文案都准，原样抛出去。
 */
function toError(error: unknown, fallback: string): Error {
  if (axios.isAxiosError(error)) {
    const detail = (error.response?.data as { error?: string } | undefined)?.error;
    if (detail) return new Error(detail);
    // 连不上和被拒是两回事：前者多半是向导已经退出了（15 分钟无操作会自己关）。
    if (!error.response) return new Error(fallback);
  }
  return new Error((error as Error)?.message || fallback);
}

export async function fetchBridgeState(conn: BridgeConn): Promise<BridgeState> {
  try {
    const response = await client(conn).get<BridgeState>("/api/state");
    return response.data;
  } catch (error) {
    throw toError(error, "连不上本机的配置向导，它可能已经退出了");
  }
}

export async function pairWithBridge(conn: BridgeConn, payload: BridgePairPayload): Promise<BridgePairResult> {
  try {
    const response = await client(conn).post<BridgePairResult>("/api/join", payload);
    return response.data;
  } catch (error) {
    throw toError(error, "连不上本机的配置向导，它可能已经退出了");
  }
}

/** 告诉向导可以退出了。失败无所谓：它 15 分钟无操作也会自己关。 */
export async function finishBridge(conn: BridgeConn): Promise<void> {
  try {
    await client(conn).post("/api/finish", {});
  } catch {
    /* 忽略 */
  }
}

export interface UpstreamLoginResult {
  /** 该上游的登录命令，控制台在拉不起终端时显示出来让用户自己敲。 */
  command: string;
  /** 是否真的把终端窗口拉起来了。只有 macOS 会是 true。 */
  launched: boolean;
  /** 凭据本来就是好的，没必要重新登录。 */
  alreadyAuthorized?: boolean;
}

/**
 * 让本机拉起某个上游的登录流程（`claude auth login` / `codex login`）。
 *
 * 只传上游的名字，**命令由本机按自己配置里的 authMode 查固定表决定** ——
 * 请求体里传不进任何要执行的东西。
 *
 * 只对「这台机器自己」有意义：贡献可能属于别的机器，那种情况下浏览器根本
 * 够不到那台的 bridge，调用方要先比对 nodeId。
 */
export async function startUpstreamLogin(conn: BridgeConn, provider: string): Promise<UpstreamLoginResult> {
  try {
    const response = await client(conn).post<UpstreamLoginResult>("/api/upstream/login", { provider });
    return response.data;
  } catch (error) {
    throw toError(error, "连不上本机的 ai-bridge");
  }
}

export interface ToolStatus {
  name: string;
  /** 本机正在跑的版本。空串表示没装。 */
  current: string;
  /** 上游最新版。空串表示拿不到（网络不通等）。 */
  latest: string;
  /** 只有两边都拿得到、且不相等才为 true —— 拿不到时不催人升级。 */
  upgradable: boolean;
  installed: boolean;
}

/** 本机几个工具的版本与可升级状态。探不到 bridge 就返回空数组，调用方据此不显示面板。 */
export async function fetchTools(conn: BridgeConn): Promise<ToolStatus[]> {
  try {
    const response = await client(conn).get<{ tools: ToolStatus[] }>("/api/tools");
    return response.data?.tools ?? [];
  } catch {
    return [];
  }
}

/**
 * 拉起一次升级。**立刻返回**，不等它跑完 —— npm 全局安装动辄几十秒。
 * 跑完与否由下次查版本体现，所以调用方应该过一会儿再刷新。
 */
export async function upgradeTool(conn: BridgeConn, tool: string): Promise<{ command: string }> {
  try {
    const response = await client(conn).post<{ command: string }>("/api/tools/upgrade", { tool });
    return response.data;
  } catch (error) {
    throw toError(error, "连不上本机的 ai-bridge");
  }
}
