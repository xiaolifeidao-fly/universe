import { ApiError, apiUrl, authenticatedApiHeaders, request, upload } from "@/api/client";

export type CommandState = "pending" | "leased" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface CommandSummary {
  commandId: string;
  commandType: string;
  state: CommandState;
  programId: number;
  progress: number;
  errorMessage: string;
  cancelRequested: boolean;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type CommandDetail = CommandSummary;

export interface CommandEvent {
  id: number;
  kind: string;
  state: CommandState;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CommandAttachment {
  attachmentId: string;
  programId: number;
  itemKey: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface SubmitCommandInput {
  programId: number;
  commandType: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
}

interface CommandPage {
  total: number;
  data: CommandSummary[];
}

export function listCommands(programId?: number) {
  const query = new URLSearchParams({ limit: "40" });
  if (programId) query.set("programId", String(programId));
  return request<CommandPage>(`/commands?${query.toString()}`);
}

export function getCommand(commandId: string) {
  return request<CommandDetail>(`/commands/${encodeURIComponent(commandId)}`);
}

export function submitCommand(input: SubmitCommandInput) {
  return request<CommandDetail>("/commands", { method: "POST", body: input });
}

export function cancelCommand(commandId: string, message = "") {
  return request<CommandSummary>(`/commands/${encodeURIComponent(commandId)}/cancel`, {
    method: "POST",
    body: { message },
  });
}

export async function uploadCommandAttachments(programId: number, itemKey: string, files: File[]) {
  const form = new FormData();
  form.set("programId", String(programId));
  form.set("itemKey", itemKey);
  for (const file of files) form.append("files", file, file.name);
  const result = await upload<{ attachments: CommandAttachment[] }>("/commands/attachments", form);
  return result.attachments ?? [];
}

export async function streamCommandEvents(
  commandId: string,
  afterId: number,
  onEvent: (event: CommandEvent) => void,
  signal: AbortSignal,
) {
  const params = new URLSearchParams();
  if (afterId > 0) params.set("afterId", String(afterId));
  const headers = authenticatedApiHeaders({ Accept: "text/event-stream" });
  if (afterId > 0) headers.set("Last-Event-ID", String(afterId));
  let response: Response;
  try {
    response = await fetch(`${apiUrl(`/commands/${encodeURIComponent(commandId)}/events`)}?${params.toString()}`, {
      headers,
      signal,
      credentials: "omit",
    });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    throw new ApiError("活动流连接失败，请检查网络后重试。");
  }
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new ApiError(`活动流连接失败（${response.status}）`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventID = 0;
  let dataLines: string[] = [];
  const dispatch = () => {
    if (!dataLines.length) {
      eventID = 0;
      return;
    }
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as CommandEvent;
      if (parsed && typeof parsed.id === "number") {
        onEvent(eventID > 0 && eventID !== parsed.id ? { ...parsed, id: eventID } : parsed);
      }
    } catch {
      // A malformed activity record must not tear down snapshot recovery.
    }
    eventID = 0;
    dataLines = [];
  };
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
        buffer = buffer.slice(lineBreak + 1);
        if (!line) {
          dispatch();
        } else if (line.startsWith("id:")) {
          const value = Number(line.slice(3).trim());
          eventID = Number.isSafeInteger(value) && value > 0 ? value : 0;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        lineBreak = buffer.indexOf("\n");
      }
      if (done) break;
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

export function isTerminalCommand(state: CommandState) {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "timed_out";
}
