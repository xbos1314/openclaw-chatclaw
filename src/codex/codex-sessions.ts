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
        messages.push({ ts: event.timestamp ?? "", role: role as CodexMessage["role"], text: part.text.trim() });
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
