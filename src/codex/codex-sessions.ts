import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** Codex 会话读取工具。活动与归档目录必须由调用方显式选择。 */
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const ACTIVE_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const ARCHIVED_SESSIONS_DIR = path.join(CODEX_HOME, "archived_sessions");
const HEADER_BYTES = 64 * 1024;

export interface CodexMeta {
  session_id?: string;
  cwd?: string;
  originator?: string;
  [key: string]: unknown;
}

export interface CodexEvent {
  type: string;
  timestamp?: string;
  payload?: Record<string, any>;
  [key: string]: unknown;
}

export interface CodexMessage {
  ts: string;
  role: "user" | "assistant";
  text: string;
}

export interface CodexTaskStatus {
  completed: boolean;
  lastCompleteTs: string | null;
}

export type CodexActivityKind = "thinking" | "file_read" | "command" | "file_edit" | "tool";
export type CodexActivityStatus = "running" | "completed" | "failed";

/** 可安全展示的执行进度，不包含模型推理、命令输出或工具参数。 */
export interface CodexActivityStep {
  id: string;
  ts: string;
  kind: CodexActivityKind;
  status: CodexActivityStatus;
  text: string;
  call_id?: string;
}

/** 仅表示当前会话最新一轮任务的执行步骤。 */
export interface CodexTurnActivity {
  turn_id: string;
  status: "running" | "completed";
  latest: CodexActivityStep | null;
  activities: CodexActivityStep[];
}

async function sessionFilesIn(directory: string): Promise<string[]> {
	const files: string[] = [];
  const scan = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(file);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(file);
      }
    }));
  };
	await scan(directory);
	return files;
}

/** 只异步遍历活跃 sessions 目录；文件名本身包含时间，可用于最新优先排序。 */
export async function activeSessionFiles(): Promise<string[]> {
	const files = await sessionFilesIn(ACTIVE_SESSIONS_DIR);
	return files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

/** 归档会话仅在归档接口中读取，排序由归档时更新的文件 ctime 在 manager 层完成。 */
export async function archivedSessionFiles(): Promise<string[]> {
	return sessionFilesIn(ARCHIVED_SESSIONS_DIR);
}

/** 只读取 session_meta 所在的有限文件头，绝不为元数据载入整个 JSONL。 */
export async function readMeta(file: string): Promise<CodexMeta> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    if (!firstLine) return {};
    const parsed = JSON.parse(firstLine) as { payload?: unknown };
    return parsed.payload && typeof parsed.payload === "object" ? parsed.payload as CodexMeta : {};
  } catch {
    return {};
  } finally {
    await handle?.close();
  }
}

export async function fileStat(file: string) {
  return fs.stat(file);
}

/** 读取从 offset 开始、截至最后一个完整换行符的新增 JSONL 字节。 */
export async function readCompleteRange(
  file: string,
  offset: number,
  size: number,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<{ text: string; nextOffset: number }> {
  if (size <= offset) return { text: "", nextOffset: offset };
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, "r");
    const readSize = Math.min(size - offset, maxBytes);
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.lastIndexOf("\n");
    if (newline < 0) return { text: "", nextOffset: offset };
    return { text: text.slice(0, newline + 1), nextOffset: offset + Buffer.byteLength(text.slice(0, newline + 1)) };
  } finally {
    await handle?.close();
  }
}

/** 从文件尾部取得最多 maxBytes 的完整 JSONL 行，用于首次打开详情。 */
export async function readTail(
  file: string,
  size: number,
  maxBytes = 512 * 1024,
): Promise<{ text: string; nextOffset: number }> {
  const offset = Math.max(0, size - maxBytes);
  const range = await readCompleteRange(file, offset, size);
  if (!range.text) return range;
  // 截取尾部时首行可能从 JSON 中间开始，丢弃它。
  const firstNewline = range.text.indexOf("\n");
  if (offset > 0 && firstNewline >= 0) {
    const skipped = range.text.slice(0, firstNewline + 1);
    return { text: range.text.slice(firstNewline + 1), nextOffset: range.nextOffset };
  }
  return range;
}

export function parseEvents(text: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // 正在写入或历史损坏的行跳过，下一轮增量读取会再次尝试未完成行。
    }
  }
  return events;
}

const INTERNAL_CONTEXT_TAGS = [
  "environment_context",
  "app-context",
  "permissions instructions",
  "developer",
  "system",
  "system_context",
  "developer_instructions",
];
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 删除 Codex 写入 JSONL 的内部运行环境块，保留真正的对话正文。 */
export function stripInternalContext(text: string): string {
  let output = String(text ?? "");
  for (const tag of INTERNAL_CONTEXT_TAGS) {
    const escaped = escapeRegExp(tag);
    output = output.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
    output = output.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?\\s*\\/>`, "gi"), "");
  }
  return output.trim();
}

/** 标准 Markdown 文件链接，使用尖括号目的地以保留绝对路径中的空格。 */
export function formatLocalFileLink(fileName: string, filePath: string): string {
  const label = String(fileName || path.basename(filePath) || "文件").replace(/([\\[\]])/g, "\\$1");
  const destination = String(filePath || "").replace(/([\\>])/g, "\\$1");
  return `[${label}](<${destination}>)`;
}

/** Codex 的输入格式：附件是标准 Markdown 链接行，后续仅保留用户正文。 */
export function serializeChatClawMessage(files: Array<{ fileName: string; filePath: string }>, body: string): string {
  const links = files.map((file) => formatLocalFileLink(file.fileName, file.filePath));
  const text = String(body ?? "").trim();
  return [...links, text].filter(Boolean).join("\n\n");
}

export function extractMessages(events: CodexEvent[]): CodexMessage[] {
  const messages: CodexMessage[] = [];
  for (const event of events) {
    if (event.type !== "response_item") continue;
    const payload = event.payload;
    if (!payload) continue;
    const role = String(payload.role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const content = payload.content;
    const items = Array.isArray(content) ? content : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (
        (part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string" &&
        part.text.trim()
      ) {
        const cleaned = stripInternalContext(part.text);
        if (!cleaned) continue;
        messages.push({
          ts: event.timestamp ?? "",
          role: role as CodexMessage["role"],
          text: cleaned,
        });
      }
    }
  }
  return messages;
}

export function taskStatus(events: CodexEvent[]): CodexTaskStatus {
  let completed = false;
  let lastCompleteTs: string | null = null;
  for (const event of events) {
    if (event.type !== "event_msg") continue;
    if (event.payload?.type === "task_complete") {
      completed = true;
      lastCompleteTs = event.timestamp ?? null;
    } else if (event.payload?.type === "task_started") {
      completed = false;
    }
  }
  return { completed, lastCompleteTs };
}

const MAX_ACTIVITY_STEPS = 24;

function asObject(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function cloneTurnActivity(activity?: CodexTurnActivity | null): CodexTurnActivity | null {
  if (!activity) return null;
  return {
    turn_id: activity.turn_id,
    status: activity.status,
    latest: activity.latest ? { ...activity.latest } : null,
    activities: activity.activities.map((step) => ({ ...step })),
  };
}

function activityStep(event: CodexEvent, index: number, kind: CodexActivityKind, text: string, callId?: string): CodexActivityStep {
  return {
    id: String(callId || `${event.timestamp ?? ""}:${event.type}:${index}`),
    ts: event.timestamp ?? "",
    kind,
    status: "running",
    text,
    ...(callId ? { call_id: callId } : {}),
  };
}

function refreshLatest(activity: CodexTurnActivity): void {
  activity.latest = [...activity.activities].reverse().find((step) => step.status === "running")
    ?? activity.activities[activity.activities.length - 1]
    ?? null;
}

function appendActivity(activity: CodexTurnActivity, step: CodexActivityStep): void {
  const last = activity.activities[activity.activities.length - 1];
  // 连续的思考事件通常只是流式推理分片，合并以避免无意义的重复步骤。
  if (step.kind === "thinking" && last?.kind === "thinking" && last.status === "running") {
    last.ts = step.ts || last.ts;
    last.text = step.text;
    refreshLatest(activity);
    return;
  }
  activity.activities.push(step);
  if (activity.activities.length > MAX_ACTIVITY_STEPS) activity.activities.splice(0, activity.activities.length - MAX_ACTIVITY_STEPS);
  refreshLatest(activity);
}

function completeStep(step: CodexActivityStep, failed = false): void {
  step.status = failed ? "failed" : "completed";
  if (step.kind === "file_read") step.text = failed ? "查看文件失败" : step.text.replace(/^正在查看 /, "已查看 ");
  else if (step.kind === "command") step.text = failed ? "命令执行失败" : "已执行命令";
  else if (step.kind === "tool") step.text = failed ? step.text.replace(/^正在调用工具：/, "工具调用失败：") : step.text.replace(/^正在调用工具：/, "已完成工具调用：");
  else if (step.kind === "thinking") step.text = failed ? "思考中断" : "已完成思考";
}

function finishCall(activity: CodexTurnActivity, callId: string, failed = false): void {
  const step = [...activity.activities].reverse().find((item) => item.call_id === callId && item.status === "running");
  if (!step) return;
  completeStep(step, failed);
  refreshLatest(activity);
}

function completeRunningThinking(activity: CodexTurnActivity): void {
  for (const step of activity.activities) {
    if (step.kind === "thinking" && step.status === "running") completeStep(step);
  }
  refreshLatest(activity);
}

function visiblePathFromCommand(command: string): string {
  const normalized = String(command || "").replace(/\\\\/g, "/");
  const match = normalized.match(/(?:^|\s)((?:docs?|documents|src|components|pages|services)\/[A-Za-z0-9_./-]+)/i);
  return match?.[1] ?? "";
}

function describeToolCall(payload: Record<string, any>): { kind: CodexActivityKind; text: string; callId?: string } {
  const name = String(payload.name ?? payload.tool_name ?? "");
  const callId = String(payload.call_id ?? payload.id ?? "");
  const input = asObject(payload.input ?? payload.arguments ?? payload.params);
  if (name === "exec" || name === "exec_command") {
    const filePath = visiblePathFromCommand(String(input.cmd ?? input.command ?? ""));
    return { kind: filePath ? "file_read" : "command", text: filePath ? `正在查看 ${filePath}` : "正在执行命令", ...(callId ? { callId } : {}) };
  }
  if (name === "apply_patch" || name === "write_file" || name === "edit_file") {
    return { kind: "file_edit", text: "正在编辑文件", ...(callId ? { callId } : {}) };
  }
  if (name === "read_file" || name === "read_mcp_resource") {
    const filePath = String(input.path ?? input.file_path ?? input.uri ?? "");
    return { kind: "file_read", text: filePath ? `正在查看 ${filePath}` : "正在查看文件", ...(callId ? { callId } : {}) };
  }
  return { kind: "tool", text: `正在调用工具：${name || "未知工具"}`, ...(callId ? { callId } : {}) };
}

function outputFailed(payload: Record<string, any>): boolean {
  if (payload.is_error === true || payload.error === true || payload.failed === true) return true;
  const output = asObject(payload.output);
  return output.isError === true || output.is_error === true || output.error === true;
}

/**
 * 从事件增量中归纳当前最新 turn 的可展示进度。调用方可传入上次轮询缓存，
 * 这样增量不包含 task_started 时仍能持续补齐同一轮步骤。
 */
export function extractLatestTurnActivity(events: CodexEvent[], previous?: CodexTurnActivity | null): CodexTurnActivity | null {
  let activity = cloneTurnActivity(previous);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const payload = event.payload ?? {};
    if (event.type === "event_msg" && payload.type === "task_started") {
      activity = {
        turn_id: String(payload.turn_id ?? event.timestamp ?? `turn:${index}`),
        status: "running",
        latest: null,
        activities: [],
      };
      appendActivity(activity, activityStep(event, index, "thinking", "正在思考"));
      continue;
    }
    if (!activity) continue;
    if (event.type === "event_msg" && payload.type === "task_complete") {
      activity.status = "completed";
      for (const step of activity.activities) if (step.status === "running") completeStep(step);
      refreshLatest(activity);
      continue;
    }
    if ((event.type === "event_msg" && payload.type === "agent_reasoning") || (event.type === "response_item" && payload.type === "reasoning")) {
      appendActivity(activity, activityStep(event, index, "thinking", "正在思考"));
      continue;
    }
    if (event.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
      const description = describeToolCall(payload);
      completeRunningThinking(activity);
      appendActivity(activity, activityStep(event, index, description.kind, description.text, description.callId));
      continue;
    }
    if (event.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
      const callId = String(payload.call_id ?? "");
      if (callId) finishCall(activity, callId, outputFailed(payload));
      continue;
    }
    if (event.type === "event_msg" && payload.type === "patch_apply_end") {
      const callId = String(payload.call_id ?? "");
      const changed = Array.isArray(payload.changes) ? payload.changes.length : Number(payload.files_changed ?? payload.changed_files ?? 1) || 1;
      const target = callId ? [...activity.activities].reverse().find((step) => step.call_id === callId) : null;
      if (target) {
        target.kind = "file_edit";
        target.status = payload.success === false ? "failed" : "completed";
        target.text = target.status === "failed" ? "编辑文件失败" : `已编辑 ${changed} 个文件`;
        refreshLatest(activity);
      } else {
        const step = activityStep(event, index, "file_edit", payload.success === false ? "编辑文件失败" : `已编辑 ${changed} 个文件`, callId || undefined);
        step.status = payload.success === false ? "failed" : "completed";
        appendActivity(activity, step);
      }
      continue;
    }
    if (event.type === "event_msg" && payload.type === "web_search_end") {
      const callId = String(payload.call_id ?? "");
      if (callId) finishCall(activity, callId, false);
      else {
        const step = activityStep(event, index, "tool", "已完成工具调用：web_search");
        step.status = "completed";
        appendActivity(activity, step);
      }
    }
  }
  return activity;
}

export function formatTime(iso: string | undefined | null, withSeconds = false): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false };
  if (withSeconds) options.second = "2-digit";
  return date.toLocaleString("zh-CN", options);
}

export function truncateText(text: string, maxLength = 400): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}
