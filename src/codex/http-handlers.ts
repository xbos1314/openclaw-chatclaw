import http from "node:http";
import { requireAuth, sendJson, parseBody } from "../http/server.js";
import type { ParsedUrl, RequestContext } from "../http/server.js";
import * as manager from "../codex/manager.js";
import { logger } from "../util/logger.js";

/**
 * Codex 管理 HTTP API（供 ChatClaw APP 端调用）
 * 全部路由需要 Bearer Token 鉴权（requireAuth）
 */

interface SendMessageBody {
  message?: string;
  attachments?: manager.CodexSendAttachmentInput[];
  full_auto?: boolean;
}

interface NewSessionBody {
  project?: string;
  message?: string;
  full_auto?: boolean;
}
interface ApprovalBody { decision?: "accept" | "decline"; }
interface QueueBody { content?: string; }

/** 从 /codex/sessions/:id/xxx 中提取会话 id */
function extractSessionId(parsedUrl: ParsedUrl): string {
  const segments = (parsedUrl.pathname ?? "").split("/").filter(Boolean);
  // ["codex", "sessions", ":id", "action"]
  return decodeURIComponent(segments[2] ?? "");
}

function handleError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof manager.CodexNotFoundError) {
    sendJson(res, 200, { code: 1, error: err.message });
    return;
  }
  logger.error(`codex API failed: ${err}`);
  sendJson(res, 200, { code: 1, error: err instanceof Error ? err.message : "Internal error" });
}

/** GET /codex/projects — 项目列表 */
export async function handleCodexProjects(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  _parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  requireAuth(ctx);
  try {
    const cursor = _parsedUrl.searchParams.get("cursor") ?? undefined;
    const limit = parseInt(_parsedUrl.searchParams.get("limit") ?? "20", 10);
    const page = await manager.listProjects(cursor, Number.isFinite(limit) ? limit : 20);
    sendJson(res, 200, { code: 0, data: { projects: page.items, has_more: page.has_more, next_cursor: page.next_cursor } });
  } catch (err) {
    handleError(res, err);
  }
}

/** GET /codex/projects/find?keyword=xxx — 搜索项目 */
export async function handleCodexFind(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  requireAuth(ctx);
  try {
    const keyword = (parsedUrl.searchParams.get("keyword") ?? "").trim();
    if (!keyword) {
      sendJson(res, 200, { code: 1, error: "keyword is required" });
      return;
    }
    const cursor = parsedUrl.searchParams.get("cursor") ?? undefined;
    const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10);
    const page = await manager.listProjects(cursor, Number.isFinite(limit) ? limit : 20, keyword);
    sendJson(res, 200, { code: 0, data: { projects: page.items, has_more: page.has_more, next_cursor: page.next_cursor } });
  } catch (err) {
    handleError(res, err);
  }
}

/** GET /codex/sessions?project=xxx — 会话列表（可按项目过滤） */
export async function handleCodexSessions(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  requireAuth(ctx);
  try {
    const project = parsedUrl.searchParams.get("project")?.trim() || undefined;
    const cursor = parsedUrl.searchParams.get("cursor") ?? undefined;
    const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10);
    const page = await manager.listSessions(project, cursor, Number.isFinite(limit) ? limit : 20);
    sendJson(res, 200, { code: 0, data: { sessions: page.items, has_more: page.has_more, next_cursor: page.next_cursor } });
  } catch (err) {
    handleError(res, err);
  }
}

/** GET /codex/archived-sessions — 归档会话，按归档时间倒序分页。 */
export async function handleCodexArchivedSessions(
	res: http.ServerResponse,
	_req: http.IncomingMessage,
	parsedUrl: ParsedUrl,
	ctx: RequestContext,
): Promise<void> {
	requireAuth(ctx);
	try {
		const cursor = parsedUrl.searchParams.get("cursor") ?? undefined;
		const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10);
		const page = await manager.listArchivedSessions(cursor, Number.isFinite(limit) ? limit : 20);
		sendJson(res, 200, { code: 0, data: { sessions: page.items, has_more: page.has_more, next_cursor: page.next_cursor } });
	} catch (err) {
		handleError(res, err);
	}
}

/** GET /codex/sessions/:id/snapshot?limit=50 — 首次进入详情的尾部快照 */
export async function handleCodexSnapshot(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  requireAuth(ctx);
  try {
    const sessionId = extractSessionId(parsedUrl);
    const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10);
    const result = await manager.getSnapshot(sessionId, Number.isFinite(limit) ? limit : 50, ctx.accountId);
    sendJson(res, 200, { code: 0, data: result });
  } catch (err) {
    handleError(res, err);
  }
}

/** GET /codex/archived-sessions/:id/snapshot — 归档会话只读快照。 */
export async function handleCodexArchivedSnapshot(
	res: http.ServerResponse,
	_req: http.IncomingMessage,
	parsedUrl: ParsedUrl,
	ctx: RequestContext,
): Promise<void> {
	requireAuth(ctx);
	try {
		const sessionId = extractSessionId(parsedUrl);
		const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10);
		const result = await manager.getArchivedSnapshot(sessionId, Number.isFinite(limit) ? limit : 50, ctx.accountId);
		sendJson(res, 200, { code: 0, data: result });
	} catch (err) {
		handleError(res, err);
	}
}

/** GET /codex/(archived-)sessions/:id/history?before=byteOffset&limit=50 — 向前分页读取历史消息。 */
export async function handleCodexHistory(
	res: http.ServerResponse,
	_req: http.IncomingMessage,
	parsedUrl: ParsedUrl,
	ctx: RequestContext,
	archived = false,
): Promise<void> {
	requireAuth(ctx);
	try {
		const sessionId = extractSessionId(parsedUrl);
		const before = parsedUrl.searchParams.get("before") ?? undefined;
		const limit = parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10);
		const result = await manager.getMessageHistory(sessionId, before, Number.isFinite(limit) ? limit : 50, ctx.accountId, archived);
		sendJson(res, 200, { code: 0, data: result });
	} catch (err) {
		handleError(res, err);
	}
}

/** GET /codex/sessions/:id/updates?cursor=byteOffset — 仅返回文件追加内容 */
export async function handleCodexUpdates(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  requireAuth(ctx);
  try {
    const sessionId = extractSessionId(parsedUrl);
    const cursor = parsedUrl.searchParams.get("cursor") ?? "";
    const result = await manager.getUpdates(sessionId, cursor, ctx.accountId);
    sendJson(res, 200, { code: 0, data: result });
  } catch (err) {
    handleError(res, err);
  }
}

export async function handleCodexInterrupt(res: http.ServerResponse, _req: http.IncomingMessage, parsedUrl: ParsedUrl, ctx: RequestContext): Promise<void> {
  requireAuth(ctx); try { await manager.interruptSession(extractSessionId(parsedUrl), ctx.accountId); sendJson(res, 200, { code: 0, data: {} }); } catch (err) { handleError(res, err); }
}
export async function handleCodexApproval(res: http.ServerResponse, req: http.IncomingMessage, parsedUrl: ParsedUrl, ctx: RequestContext): Promise<void> {
  requireAuth(ctx); try { const body = await parseBody<ApprovalBody>(req); const id = decodeURIComponent((parsedUrl.pathname ?? "").split("/").filter(Boolean)[4] ?? ""); if (!id || (body.decision !== "accept" && body.decision !== "decline")) throw new Error("审批参数无效"); await manager.decideApproval(extractSessionId(parsedUrl), ctx.accountId, id, body.decision === "accept"); sendJson(res, 200, { code: 0, data: {} }); } catch (err) { handleError(res, err); }
}
export async function handleCodexQueueUpdate(res: http.ServerResponse, req: http.IncomingMessage, parsedUrl: ParsedUrl, ctx: RequestContext): Promise<void> {
  requireAuth(ctx); try { const body = await parseBody<QueueBody>(req); const id = decodeURIComponent((parsedUrl.pathname ?? "").split("/").filter(Boolean)[4] ?? ""); await manager.updateQueuedMessage(extractSessionId(parsedUrl), ctx.accountId, id, String(body.content ?? "")); sendJson(res, 200, { code: 0, data: {} }); } catch (err) { handleError(res, err); }
}
export async function handleCodexQueueRemove(res: http.ServerResponse, _req: http.IncomingMessage, parsedUrl: ParsedUrl, ctx: RequestContext): Promise<void> {
  requireAuth(ctx); try { const id = decodeURIComponent((parsedUrl.pathname ?? "").split("/").filter(Boolean)[4] ?? ""); await manager.removeQueuedMessage(extractSessionId(parsedUrl), ctx.accountId, id); sendJson(res, 200, { code: 0, data: {} }); } catch (err) { handleError(res, err); }
}

/** POST /codex/sessions/:id/send — 向会话发消息（续跑） */
export async function handleCodexSend(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  requireAuth(ctx);
  try {
    const body = await parseBody<SendMessageBody>(req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!message && !attachments.length) {
      sendJson(res, 200, { code: 1, error: "message or attachments is required" });
      return;
    }
    const sessionId = extractSessionId(parsedUrl);
    const result = await manager.sendMessage(sessionId, message, {
      fullAuto: body.full_auto ?? false,
      accountId: ctx.accountId,
      attachments,
    });
    sendJson(res, 200, {
      code: 0,
      data: { ...result, full_auto: body.full_auto ?? false },
    });
  } catch (err) {
    handleError(res, err);
  }
}

/** POST /codex/archived-sessions/:id/unarchive — 显式取消归档。 */
export async function handleCodexUnarchive(
	res: http.ServerResponse,
	_req: http.IncomingMessage,
	parsedUrl: ParsedUrl,
	ctx: RequestContext,
): Promise<void> {
	requireAuth(ctx);
	try {
		const result = await manager.unarchiveSession(extractSessionId(parsedUrl));
		sendJson(res, 200, { code: 0, data: result });
	} catch (err) {
		handleError(res, err);
	}
}

/** POST /codex/projects/new — 开新会话跑任务 */
export async function handleCodexNew(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  _parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  requireAuth(ctx);
  try {
    const body = await parseBody<NewSessionBody>(req);
    const project = (body.project ?? "").trim();
    const message = (body.message ?? "").trim();
    if (!project || !message) {
      sendJson(res, 200, { code: 1, error: "project and message are required" });
      return;
    }
    const result = await manager.newSession(project, message, {
      fullAuto: body.full_auto ?? false,
    });
    sendJson(res, 200, {
      code: 0,
      data: { ...result, full_auto: body.full_auto ?? false },
    });
  } catch (err) {
    handleError(res, err);
  }
}
