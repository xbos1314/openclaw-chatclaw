import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as codexSessions from "./codex-sessions.js";
import * as filesDB from "../db/files.js";
import * as fileStorage from "../media/fileStorage.js";
import * as codexQueue from "../db/codex-queue.js";
import { CodexAppServerRunner, type CodexExecution } from "./app-server-runner.js";

export const CODEX_BIN = process.env.CODEX_BIN ?? "/Users/xbos1314/.nvm/versions/node/v22.19.0/bin/codex";
const EXEC_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 2000;
const PAGE_SIZE = 20;
const PAGE_SCAN_LIMIT = 60;
const MAX_UPDATE_BYTES = 512 * 1024;
const SESSION_SUMMARY_TAIL_BYTES = 128 * 1024;
const SESSION_SUMMARY_MAX_LENGTH = 120;
const SESSION_SUMMARY_CONCURRENCY = 4;
const ARCHIVE_INDEX_TTL_MS = 60_000;
const ARCHIVE_STAT_CONCURRENCY = 8;

export interface CodexProject { name: string; path: string; sessions: number; last_active: string; summary: string; }
export interface CodexSessionItem { id: string; project: string; origin: string; last_active: string; summary: string; archived_at?: string; }
export interface CodexMessage { ts: string; role: "user" | "assistant"; text: string; }
export interface CodexLastMessage { ts: string; role: "user" | "assistant"; text: string; }
export interface CodexStatus { session_id: string; project: string; status: "running" | "completed"; last_write_sec: number; last_complete_at: string | null; last_message: CodexLastMessage | null; }
export interface CodexPage<T> { items: T[]; has_more: boolean; next_cursor: string | null; }
export interface CodexQueueItem { id: string; content: string; attachments: unknown[]; full_auto: boolean; created_at: number; }
export interface CodexSnapshot { session_id: string; project: string; messages: CodexMessage[]; cursor: string; history_has_more: boolean; history_before: string | null; status: CodexStatus; activity: codexSessions.CodexTurnActivity | null; execution: CodexExecution; queue: CodexQueueItem[]; }
export interface CodexUpdates { session_id: string; messages: CodexMessage[]; cursor: string; reset: boolean; status: CodexStatus; activity: codexSessions.CodexTurnActivity | null; execution: CodexExecution; queue: CodexQueueItem[]; }
export interface CodexHistoryPage { session_id: string; messages: CodexMessage[]; has_more: boolean; next_before: string | null; }
export interface CodexRunResult { exit_code: number; output: string; stderr: string; timed_out: boolean; }
export interface CodexExecOptions { fullAuto?: boolean; timeoutMs?: number; }
export interface CodexSendAttachmentInput {
  type: "image" | "video" | "voice" | "audio" | "file" | "path";
  file_id?: string;
  file_path?: string;
  duration?: number;
}
export interface CodexSendOptions extends CodexExecOptions {
  accountId?: string;
  attachments?: CodexSendAttachmentInput[];
}

interface CachedSession { file: string; meta: codexSessions.CodexMeta; archived: boolean; }
interface RuntimeState { status: CodexStatus; activity: codexSessions.CodexTurnActivity | null; }
interface ArchiveFileEntry { file: string; archivedAtMs: number; }
const sessionCache = new Map<string, CachedSession>();
const runtimeCache = new Map<string, RuntimeState>();
const runners = new Map<string, CodexAppServerRunner>();
const runnerAccounts = new Map<string, string>();
let archiveIndex: { expiresAt: number; entries: ArchiveFileEntry[] } | null = null;

export class CodexNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "CodexNotFoundError"; }
}

function encodeCursor(file: string): string { return Buffer.from(file).toString("base64url"); }
function decodeCursor(cursor?: string): string | null {
  if (!cursor) return null;
  try { return Buffer.from(cursor, "base64url").toString("utf8"); } catch { return null; }
}
function clampLimit(limit?: number): number { return Math.max(1, Math.min(Number(limit) || PAGE_SIZE, 50)); }
function remember(file: string, meta: codexSessions.CodexMeta, archived = false): CachedSession {
	const id = String(meta.session_id ?? "");
	const entry = { file, meta, archived };
	if (id) sessionCache.set(id, entry);
	return entry;
}

async function activeEntries(cursor?: string, limit = PAGE_SIZE, project?: string): Promise<CodexPage<{ file: string; meta: codexSessions.CodexMeta; mtimeMs: number; size: number }>> {
  const files = await codexSessions.activeSessionFiles();
  const after = decodeCursor(cursor);
  const start = after ? Math.max(0, files.indexOf(after) + 1) : 0;
  const items: { file: string; meta: codexSessions.CodexMeta; mtimeMs: number; size: number }[] = [];
  let lastIndex = start - 1;
  for (let index = start; index < files.length && items.length < clampLimit(limit) && index - start < PAGE_SCAN_LIMIT; index += 1) {
    const file = files[index];
    lastIndex = index;
    const [meta, stats] = await Promise.all([codexSessions.readMeta(file), codexSessions.fileStat(file)]);
    const cwd = String(meta.cwd ?? "");
    if (project && !cwd.includes(project)) continue;
    remember(file, meta);
    items.push({ file, meta, mtimeMs: stats.mtimeMs, size: stats.size });
  }
  const lastFile = lastIndex >= start ? files[lastIndex] : null;
	return { items, has_more: lastIndex < files.length - 1, next_cursor: lastFile ? encodeCursor(lastFile) : null };
}

/**
 * 归档目录只在归档接口访问时扫描。ctime 会在会话移入 archived_sessions 时更新，
 * 因此可作为归档时间；短时缓存避免滚动分页反复 stat 全部历史文件。
 */
async function archivedFileIndex(): Promise<ArchiveFileEntry[]> {
	if (archiveIndex && archiveIndex.expiresAt > Date.now()) return archiveIndex.entries;
	const files = await codexSessions.archivedSessionFiles();
	const entries = await mapWithConcurrency(files, ARCHIVE_STAT_CONCURRENCY, async (file) => {
		const stats = await codexSessions.fileStat(file);
		return { file, archivedAtMs: stats.ctimeMs };
	});
	entries.sort((a, b) => b.archivedAtMs - a.archivedAtMs || path.basename(b.file).localeCompare(path.basename(a.file)));
	archiveIndex = { entries, expiresAt: Date.now() + ARCHIVE_INDEX_TTL_MS };
	return entries;
}

async function archivedEntries(cursor?: string, limit = PAGE_SIZE): Promise<CodexPage<{ file: string; meta: codexSessions.CodexMeta; mtimeMs: number; size: number; archivedAtMs: number }>> {
	const files = await archivedFileIndex();
	const after = decodeCursor(cursor);
	const start = after ? Math.max(0, files.findIndex((entry) => entry.file === after) + 1) : 0;
	const items: { file: string; meta: codexSessions.CodexMeta; mtimeMs: number; size: number; archivedAtMs: number }[] = [];
	let lastIndex = start - 1;
	for (let index = start; index < files.length && items.length < clampLimit(limit) && index - start < PAGE_SCAN_LIMIT; index += 1) {
		const entry = files[index];
		lastIndex = index;
		const [meta, stats] = await Promise.all([codexSessions.readMeta(entry.file), codexSessions.fileStat(entry.file)]);
		remember(entry.file, meta, true);
		items.push({ file: entry.file, meta, mtimeMs: stats.mtimeMs, size: stats.size, archivedAtMs: entry.archivedAtMs });
	}
	const lastFile = lastIndex >= start ? files[lastIndex]?.file : null;
	return { items, has_more: lastIndex < files.length - 1, next_cursor: lastFile ? encodeCursor(lastFile) : null };
}

/** 最近活跃项目；sessions 是当前页中出现的会话数，不代表历史总数。 */
export async function listProjects(cursor?: string, limit?: number, keyword?: string): Promise<CodexPage<CodexProject>> {
  const page = await activeEntries(cursor, limit);
  const seen = new Map<string, { project: CodexProject; latestFile: string; latestFileSize: number }>();
  const kw = keyword?.toLowerCase().trim();
  for (const entry of page.items) {
    const cwd = String(entry.meta.cwd ?? "(未知)");
    const name = cwd === "(未知)" ? cwd : path.basename(cwd);
    if (kw && !cwd.toLowerCase().includes(kw) && !name.toLowerCase().includes(kw)) continue;
    const current = seen.get(cwd);
    if (current) { current.project.sessions += 1; continue; }
    seen.set(cwd, {
      project: { name, path: cwd, sessions: 1, last_active: codexSessions.formatTime(new Date(entry.mtimeMs).toISOString()), summary: "" },
      latestFile: entry.file,
      latestFileSize: entry.size,
    });
  }
  const items = await mapWithConcurrency([...seen.values()], SESSION_SUMMARY_CONCURRENCY, async (item) => ({
    ...item.project,
    summary: await readLastTextSummary(item.latestFile, item.latestFileSize),
  }));
  return { items, has_more: page.has_more, next_cursor: page.next_cursor };
}

export async function listSessions(project?: string, cursor?: string, limit?: number): Promise<CodexPage<CodexSessionItem>> {
  const page = await activeEntries(cursor, limit, project);
  const items = await mapWithConcurrency(page.items, SESSION_SUMMARY_CONCURRENCY, async (entry) => ({
    id: String(entry.meta.session_id ?? ""),
    project: String(entry.meta.cwd ?? "").split("/").pop() ?? "",
    origin: String(entry.meta.originator ?? ""),
    last_active: codexSessions.formatTime(new Date(entry.mtimeMs).toISOString()),
    summary: await readLastTextSummary(entry.file, entry.size),
  }));
  return {
    items: items.filter((item) => item.id),
    has_more: page.has_more,
    next_cursor: page.next_cursor,
	};
}

/** 归档会话列表：仅访问 archived_sessions，并按归档时间倒序分页。 */
export async function listArchivedSessions(cursor?: string, limit?: number): Promise<CodexPage<CodexSessionItem>> {
	const page = await archivedEntries(cursor, limit);
	const items = await mapWithConcurrency(page.items, SESSION_SUMMARY_CONCURRENCY, async (entry) => ({
		id: String(entry.meta.session_id ?? ""),
		project: String(entry.meta.cwd ?? ""),
		origin: String(entry.meta.originator ?? ""),
		last_active: codexSessions.formatTime(new Date(entry.mtimeMs).toISOString()),
		archived_at: codexSessions.formatTime(new Date(entry.archivedAtMs).toISOString(), true),
		summary: await readLastTextSummary(entry.file, entry.size),
	}));
	return {
		items: items.filter((item) => item.id),
		has_more: page.has_more,
		next_cursor: page.next_cursor,
	};
}

/** 仅查阅有限的文件尾部，避免列表页为摘要读取完整 JSONL。 */
async function readLastTextSummary(file: string, size: number): Promise<string> {
  try {
    const tail = await codexSessions.readTail(file, size, SESSION_SUMMARY_TAIL_BYTES);
    const messages = codexSessions.extractMessages(codexSessions.parseEvents(tail.text));
    const lastMessage = [...messages].reverse().find((message) => message.text.trim());
    return lastMessage ? codexSessions.truncateText(lastMessage.text.replace(/\s+/g, " "), SESSION_SUMMARY_MAX_LENGTH) : "";
  } catch {
    return "";
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveSession(sessionId: string, archived = false): Promise<CachedSession> {
	const exact = sessionCache.get(sessionId);
	if (exact && exact.archived === archived) return exact;
	for (const [id, entry] of sessionCache) if (entry.archived === archived && id.startsWith(sessionId)) return entry;
	const files = archived
		? (await archivedFileIndex()).map((entry) => entry.file)
		: await codexSessions.activeSessionFiles();
	for (let index = 0; index < files.length; index += 1) {
		const meta = await codexSessions.readMeta(files[index]);
		const id = String(meta.session_id ?? "");
		if (id.startsWith(sessionId) || path.basename(files[index]).includes(sessionId)) return remember(files[index], meta, archived);
		if (index % PAGE_SIZE === PAGE_SIZE - 1) await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new CodexNotFoundError(`找不到${archived ? "归档" : "活跃"}会话: ${sessionId}`);
}

function formatMessages(events: codexSessions.CodexEvent[], _accountId?: string): CodexMessage[] {
  return codexSessions.extractMessages(events).map((message) => ({
    ts: codexSessions.formatTime(message.ts, true),
    role: message.role,
    text: message.text,
  }));
}

function idleExecution(): CodexExecution { return { status: "idle", turn_id: null, full_auto: true, approval: null }; }
function publicQueue(items: codexQueue.CodexQueueItem[]): CodexQueueItem[] { return items.map((item) => ({ id: item.id, content: item.content, attachments: JSON.parse(item.attachments || "[]"), full_auto: item.fullAuto, created_at: item.createdAt })); }
function getRunner(sessionId: string, cwd: string, accountId: string): CodexAppServerRunner {
  let runner = runners.get(sessionId);
  if (!runner) { runner = new CodexAppServerRunner(CODEX_BIN, sessionId, cwd); runners.set(sessionId, runner); runner.onCompleted((interrupted) => { if (!interrupted) void drainQueue(sessionId, cwd, runnerAccounts.get(sessionId) || accountId); }); }
  runnerAccounts.set(sessionId, accountId);
  return runner;
}
async function drainQueue(sessionId: string, cwd: string, accountId: string): Promise<void> {
  const runner = getRunner(sessionId, cwd, accountId);
  if (runner.execution.status !== "idle") return;
  const item = (await codexQueue.listQueue(accountId, sessionId))[0];
  if (!item) return;
  await runner.start(item.content, item.fullAuto);
  await codexQueue.removeQueueItem(accountId, sessionId, item.id);
}
async function sessionRuntime(sessionId: string, accountId?: string): Promise<{ execution: CodexExecution; queue: CodexQueueItem[] }> {
  const runner = runners.get(sessionId);
  const queue = accountId ? publicQueue(await codexQueue.listQueue(accountId, sessionId)) : [];
  return { execution: runner ? { ...runner.execution, approval: runner.execution.approval ? { ...runner.execution.approval } : null } : idleExecution(), queue };
}

function buildStatus(sessionId: string, project: string, mtimeMs: number, events: codexSessions.CodexEvent[], fallback?: CodexStatus): CodexStatus {
  const lifecycle = codexSessions.taskStatus(events);
  const messages = formatMessages(events);
  const lastMessage = messages.length ? messages[messages.length - 1] : fallback?.last_message ?? null;
  const hasLifecycleEvent = events.some((event) => event.type === "event_msg" && (event.payload?.type === "task_started" || event.payload?.type === "task_complete"));
  const completed = hasLifecycleEvent ? lifecycle.completed : fallback?.status === "completed";
  return {
    session_id: sessionId,
    project,
    status: completed ? "completed" : "running",
    last_write_sec: Math.max(0, Math.round((Date.now() - mtimeMs) / 1000)),
    last_complete_at: codexSessions.formatTime(lifecycle.lastCompleteTs, true) || fallback?.last_complete_at || null,
    last_message: lastMessage,
  };
}

/** 首次进入详情页：仅读取当前活跃会话的尾部。 */
async function getSnapshotFromEntry(sessionId: string, archived: boolean, limit = 50, accountId?: string): Promise<CodexSnapshot & { archived: boolean; archived_at: string | null }> {
	const entry = await resolveSession(sessionId, archived);
	const stats = await codexSessions.fileStat(entry.file);
	const tail = await codexSessions.readTail(entry.file, stats.size);
  const events = codexSessions.parseEvents(tail.text);
	const history = await codexSessions.readMessageHistory(entry.file, stats.size, undefined, clampLimit(limit));
  const id = String(entry.meta.session_id ?? sessionId);
	const project = String(entry.meta.cwd ?? "");
	const status = buildStatus(id, project, stats.mtimeMs, events, runtimeCache.get(id)?.status);
	const runtime = await sessionRuntime(id, accountId);
	const activity = runtime.execution.status === "interrupted" ? null : codexSessions.extractLatestTurnActivity(events, runtimeCache.get(id)?.activity);
	runtimeCache.set(id, { status, activity });
	return {
		session_id: id,
		project,
		messages: formatMessages(history.events, accountId),
		cursor: String(tail.nextOffset),
		history_has_more: history.has_more,
		history_before: history.next_before,
		status,
		activity,
		execution: runtime.execution,
		queue: runtime.queue,
		archived,
		archived_at: archived ? codexSessions.formatTime(new Date(stats.ctimeMs).toISOString(), true) : null,
	};
}

/** 首次进入详情页：仅读取当前活跃会话的尾部。 */
export async function getSnapshot(sessionId: string, limit = 50, accountId?: string): Promise<CodexSnapshot> {
	const snapshot = await getSnapshotFromEntry(sessionId, false, limit, accountId);
	return snapshot;
}

/** 归档详情只读取一次有限尾部快照，不启动轮询。 */
export async function getArchivedSnapshot(sessionId: string, limit = 50, accountId?: string): Promise<CodexSnapshot & { archived: true; archived_at: string | null }> {
	return getSnapshotFromEntry(sessionId, true, limit, accountId) as Promise<CodexSnapshot & { archived: true; archived_at: string | null }>;
}

export async function getMessageHistory(sessionId: string, before?: string, limit = 50, accountId?: string, archived = false): Promise<CodexHistoryPage> {
	const entry = await resolveSession(sessionId, archived);
	const stats = await codexSessions.fileStat(entry.file);
	const history = await codexSessions.readMessageHistory(entry.file, stats.size, before, clampLimit(limit));
	return {
		session_id: String(entry.meta.session_id ?? sessionId),
		messages: formatMessages(history.events, accountId),
		has_more: history.has_more,
		next_before: history.next_before,
	};
}

/** 详情页轮询：无变化只 stat；有变化只读取此前游标之后的完整 JSONL 行。 */
export async function getUpdates(sessionId: string, cursor: string, accountId?: string): Promise<CodexUpdates> {
  const entry = await resolveSession(sessionId);
  const stats = await codexSessions.fileStat(entry.file);
  const previous = Number(cursor);
  if (!Number.isFinite(previous) || previous < 0 || stats.size < previous) {
    const snapshot = await getSnapshot(sessionId, 50, accountId);
    return { session_id: snapshot.session_id, messages: snapshot.messages, cursor: snapshot.cursor, reset: true, status: snapshot.status, activity: snapshot.activity, execution: snapshot.execution, queue: snapshot.queue };
  }
  const id = String(entry.meta.session_id ?? sessionId);
  const project = String(entry.meta.cwd ?? "");
  if (stats.size === previous) {
    const cached = runtimeCache.get(id);
    const status = cached?.status ?? buildStatus(id, project, stats.mtimeMs, []);
    const runtime = await sessionRuntime(id, accountId);
    return { session_id: id, messages: [], cursor, reset: false, status: { ...status, last_write_sec: Math.max(0, Math.round((Date.now() - stats.mtimeMs) / 1000)) }, activity: runtime.execution.status === "interrupted" ? null : cached?.activity ?? null, execution: runtime.execution, queue: runtime.queue };
  }
  const range = await codexSessions.readCompleteRange(entry.file, previous, stats.size, MAX_UPDATE_BYTES);
  const events = codexSessions.parseEvents(range.text);
  const cached = runtimeCache.get(id);
  const status = buildStatus(id, project, stats.mtimeMs, events, cached?.status);
  const runtime = await sessionRuntime(id, accountId);
  const activity = runtime.execution.status === "interrupted" ? null : codexSessions.extractLatestTurnActivity(events, cached?.activity);
  runtimeCache.set(id, { status, activity });
  return { session_id: id, messages: formatMessages(events, accountId), cursor: String(range.nextOffset), reset: false, status, activity, execution: runtime.execution, queue: runtime.queue };
}

/**
 * 归档会话必须显式取消归档后才允许续跑。命令完成后清除索引与缓存，
 * 后续请求将只从活动 sessions 路径读取该会话。
 */
export async function unarchiveSession(sessionId: string, options: CodexExecOptions = {}): Promise<{ session_id: string; project: string }> {
	const { meta } = await resolveSession(sessionId, true);
	const fullSessionId = String(meta.session_id ?? sessionId);
	const cwd = String(meta.cwd ?? process.cwd());
	const result = await runCodex(["unarchive", fullSessionId], cwd, options.timeoutMs ?? 30_000);
	if (result.exit_code !== 0) {
		throw new Error(codexSessions.truncateText(result.stderr.trim() || result.output.trim() || "取消归档失败", MAX_OUTPUT));
	}
	sessionCache.delete(fullSessionId);
	runtimeCache.delete(fullSessionId);
	archiveIndex = null;
	return { session_id: fullSessionId, project: String(meta.cwd ?? "") };
}

/**
 * 将空闲会话移入 Codex 归档目录。运行中的会话必须先停止，避免归档
 * 正在写入的 JSONL 文件；归档完成后关闭本地 runner 并清除各级缓存。
 */
export async function archiveSession(sessionId: string, options: CodexExecOptions = {}): Promise<{ session_id: string; project: string }> {
	const { meta } = await resolveSession(sessionId);
	const fullSessionId = String(meta.session_id ?? sessionId);
	const runner = runners.get(fullSessionId);
	if (runner && runner.execution.status !== "idle" && runner.execution.status !== "interrupted") {
		throw new Error("正在执行的会话不能归档，请先停止任务");
	}
	const cwd = String(meta.cwd ?? process.cwd());
	const result = await runCodex(["archive", fullSessionId], cwd, options.timeoutMs ?? 30_000);
	if (result.exit_code !== 0) {
		throw new Error(codexSessions.truncateText(result.stderr.trim() || result.output.trim() || "归档失败", MAX_OUTPUT));
	}
	runner?.close();
	runners.delete(fullSessionId);
	runnerAccounts.delete(fullSessionId);
	sessionCache.delete(fullSessionId);
	runtimeCache.delete(fullSessionId);
	archiveIndex = null;
	return { session_id: fullSessionId, project: String(meta.cwd ?? "") };
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMediaTypeCompatible(type: CodexSendAttachmentInput["type"], contentType: string): boolean {
  if (type === "file") return true;
  if (type === "image") return contentType.startsWith("image/");
  if (type === "video") return contentType.startsWith("video/");
  if (type === "voice" || type === "audio") return contentType.startsWith("audio/");
  return false;
}

async function resolveAttachments(
  inputs: CodexSendAttachmentInput[] | undefined,
  accountId: string | undefined,
): Promise<Array<{ fileName: string; filePath: string }>> {
  const attachments = inputs ?? [];
  if (!attachments.length) return [];
  if (!accountId) throw new Error("附件发送需要认证账号");
  const resolved: Array<{ fileName: string; filePath: string }> = [];
  const homeDir = await fs.realpath(os.homedir()).catch(() => "");
  if (!homeDir) throw new Error("本机文件存储不可用");
  let accountStorageDir = "";

  for (const input of attachments) {
    if (input.type === "path") {
      const requested = String(input.file_path ?? "").trim();
      if (!requested) throw new Error("路径不能为空");
      const realPath = await fs.realpath(requested).catch(() => "");
      if (!realPath || !isSameOrChildPath(realPath, homeDir)) throw new Error("路径不存在或超出 home 目录");
      await fs.access(realPath).catch(() => { throw new Error("路径不可读取"); });
      resolved.push({ fileName: path.basename(realPath) || realPath, filePath: realPath });
      continue;
    }

    const fileId = String(input.file_id ?? "").trim();
    if (!fileId) throw new Error("文件标识不能为空");
    const record = await filesDB.getFileRecordByFileId(fileId);
    if (!record || record.accountId !== accountId) throw new Error("文件不存在或无权访问");
    if (!isMediaTypeCompatible(input.type, record.contentType)) throw new Error("附件类型与文件类型不匹配");
    if (!accountStorageDir) accountStorageDir = await fs.realpath(fileStorage.getUserStorageDir(accountId)).catch(() => "");
    if (!accountStorageDir) throw new Error("本机文件存储不可用");
    const expectedPath = fileStorage.getFilePath(record.fileId, accountId);
    const realPath = await fs.realpath(expectedPath).catch(() => "");
    if (!realPath || !isSameOrChildPath(realPath, accountStorageDir)) throw new Error("上传文件不可用");
    const stats = await fs.stat(realPath).catch(() => null);
    if (!stats?.isFile()) throw new Error("上传文件不可用");
    resolved.push({ fileName: record.fileName, filePath: realPath });
  }
  return resolved;
}

export async function sendMessage(sessionId: string, message: string, options: CodexSendOptions = {}): Promise<{ session_id: string; reply: string; content: string; exit_code: number; queued: boolean }> {
  const { meta } = await resolveSession(sessionId);
  const cwd = String(meta.cwd ?? process.cwd());
  const fullSessionId = String(meta.session_id ?? sessionId);
  const attachments = await resolveAttachments(options.attachments, options.accountId);
  const input = codexSessions.serializeChatClawMessage(attachments, message);
  if (!input) throw new Error("消息或附件不能为空");
  const accountId = options.accountId;
  if (!accountId) throw new Error("发送消息需要认证账号");
  const runner = getRunner(fullSessionId, cwd, accountId);
  if (runner.execution.status !== "idle" && runner.execution.status !== "interrupted") {
    await codexQueue.enqueue(accountId, fullSessionId, input, JSON.stringify(options.attachments ?? []), Boolean(options.fullAuto));
    return { session_id: fullSessionId, reply: "消息已加入队列", content: input, exit_code: 0, queued: true };
  }
  await runner.start(input, Boolean(options.fullAuto));
  return { session_id: fullSessionId, reply: "续跑已启动", content: input, exit_code: 0, queued: false };
}

export async function interruptSession(sessionId: string, accountId: string): Promise<CodexExecution> { const entry = await resolveSession(sessionId); const id = String(entry.meta.session_id ?? sessionId); const runner = runners.get(id); if (!runner || runnerAccounts.get(id) !== accountId) throw new Error("没有可停止的任务"); await runner.interrupt(); return { ...runner.execution, approval: runner.execution.approval ? { ...runner.execution.approval } : null }; }
export async function decideApproval(sessionId: string, accountId: string, approvalId: string, accept: boolean): Promise<void> { const entry = await resolveSession(sessionId); const id = String(entry.meta.session_id ?? sessionId); const runner = runners.get(id); if (!runner || runnerAccounts.get(id) !== accountId) throw new Error("审批请求不存在或已失效"); await runner.decide(approvalId, accept); }
export async function updateQueuedMessage(sessionId: string, accountId: string, queueId: string, content: string): Promise<void> { const entry = await resolveSession(sessionId); const id = String(entry.meta.session_id ?? sessionId); if (!content.trim()) throw new Error("排队内容不能为空"); if (!await codexQueue.updateQueueItem(accountId, id, queueId, content.trim())) throw new CodexNotFoundError("找不到排队消息"); }
export async function removeQueuedMessage(sessionId: string, accountId: string, queueId: string): Promise<void> { const entry = await resolveSession(sessionId); const id = String(entry.meta.session_id ?? sessionId); if (!await codexQueue.removeQueueItem(accountId, id, queueId)) throw new CodexNotFoundError("找不到排队消息"); }

export async function newSession(projectDir: string, message: string, options: CodexExecOptions = {}): Promise<{ session_id: string; project: string; output: string; exit_code: number }> {
  const resolved = path.resolve(projectDir);
  const projectStats = await fs.stat(resolved).catch(() => null);
  if (!projectStats?.isDirectory()) throw new Error(`项目目录不存在: ${projectDir}`);
  const before = new Set(await codexSessions.activeSessionFiles());
  const args = ["exec"];
  if (options.fullAuto) args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push("--skip-git-repo-check", message);
  const child = spawn(CODEX_BIN, args, { cwd: resolved, detached: true, stdio: "ignore" });
  child.on("error", (err) => console.error(`[codex] spawn failed: ${err.message}`));
  child.unref();
  const sessionId = await waitForNewSessionFile(before, 10_000);
  return { session_id: sessionId, project: resolved, output: sessionId ? "任务已在后台启动，可通过会话详情查看进度" : "任务已在后台启动，可从最新会话中查看", exit_code: 0 };
}

async function waitForNewSessionFile(before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await codexSessions.activeSessionFiles();
    const newFile = files.find((file) => !before.has(file));
    if (newFile) {
      const meta = await codexSessions.readMeta(newFile);
      if (meta.session_id) return String(remember(newFile, meta).meta.session_id);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

/** 启动续跑后立即脱离 HTTP 请求，任务执行时长不会影响发送接口。 */
function startCodexDetached(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { cwd, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function runCodex(args: string[], cwd: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<CodexRunResult> {
  return new Promise((resolve) => execFile(CODEX_BIN, args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
    const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
    if (err && (err.killed || err.signal)) return resolve({ exit_code: 124, output: stdout ?? "", stderr: stderr ?? "", timed_out: true });
    if (err) return resolve({ exit_code: typeof err.code === "number" ? err.code : 1, output: stdout ?? "", stderr: stderr ?? "", timed_out: false });
    resolve({ exit_code: 0, output: stdout ?? "", stderr: stderr ?? "", timed_out: false });
  }));
}
