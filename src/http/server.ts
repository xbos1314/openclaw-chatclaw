import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { logger } from "../util/logger.js";
import { generateAuthToken, getAccountIdFromAuth, generateDownloadToken, verifyDownloadToken } from "../auth/token.js";
import { authenticateUser, updateChatClawAccountAvatar, loadChatClawAccount, resolveChatClawStateDir, listAllowedAgentIds } from "../auth/accounts.js";
import * as messageDB from "../db/message.js";
import * as filesDB from "../db/files.js";
import { getChatClawRuntime } from "../runtime.js";
import { buildChatClawDirectSessionKey, CHATCLAW_CHANNEL_ID } from "../session/routing.js";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";
import * as fileStorage from "../media/fileStorage.js";
import { getAccountTypingStates } from "../typing/state.js";
import { handleMemoVoice, handleMemoList, handleMemoGet, handleMemoSend, handleMemoUpdate, handleMemoDelete, handleVoiceDownload } from "./memo-handlers.js";
import {
  handleDocumentCreate,
  handleDocumentDelete,
  handleDocumentFile,
  handleDocumentGet,
  handleDocumentList,
  handleDocumentSend,
  handleDocumentTasks,
  handleDocumentUpdate,
} from "./document-handlers.js";
import {
  handleMiniprogramCreate,
  handleMiniprogramBuild,
  handleMiniprogramCustomApiRequest,
  handleMiniprogramDelete,
  handleMiniprogramFileDelete,
  handleMiniprogramFileRead,
  handleMiniprogramFileUpload,
  handleMiniprogramGet,
  handleMiniprogramList,
  handleMiniprogramPublic,
  handleMiniprogramProjectFiles,
  handleMiniprogramReload,
  handleMiniprogramRevise,
  handleMiniprogramSend,
  handleMiniprogramTasks,
} from "./miniprogram-handlers.js";

// ============ Types ============

interface HttpServerOptions {
  port: number;
  log?: (...args: unknown[]) => void;
}

export interface ParsedUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

export interface RequestContext {
  accountId: string;
  username: string;
}

// ============ HTTP Server ============

export async function startHttpServer(options: HttpServerOptions): Promise<http.Server> {
  const { port, log } = options;

  serverInstance = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const parsedUrl = parseUrl(req.url || "/");
      const ctx = await authenticateRequest(req);

      // Route handling
      if (parsedUrl.pathname === "/health") {
        handleHealth(res);
      } else if (parsedUrl.pathname === "/auth" && req.method === "POST") {
        await handleAuth(res, req, ctx);
      } else if (parsedUrl.pathname === "/files/refresh-download-token" && req.method === "POST") {
        await handleRefreshDownloadToken(res, req, ctx);
      } else if (parsedUrl.pathname === "/agents" && req.method === "GET") {
        await handleGetAgents(res, req, ctx);
      } else if (parsedUrl.pathname === "/messages/unread-count" && req.method === "GET") {
        await handleGetUnreadCount(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname === "/messages/sync" && req.method === "GET") {
        await handleSyncMessages(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname === "/messages/read" && req.method === "POST") {
        await handleMarkRead(res, req, ctx);
      } else if (parsedUrl.pathname.startsWith("/messages") && req.method === "GET") {
        await handleGetMessages(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname === "/messages" && req.method === "DELETE") {
        await handleClearMessages(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname.match(/^\/messages\/[^/]+$/) && req.method === "DELETE") {
        await handleDeleteMessage(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname.match(/^\/messages\/[^/]+$/) && req.method === "PATCH") {
        await handleUpdateMessage(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname === "/files" && req.method === "GET") {
        await handleGetFiles(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname === "/files/upload" && req.method === "POST") {
        await handleUploadFile(res, req, ctx);
      } else if (parsedUrl.pathname.match(/^\/files\/download\/[^/]+\/[^/]+$/) && req.method === "GET") {
        await handleDownloadFile(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname.match(/^\/files\/[^/]+$/) && req.method === "DELETE") {
        await handleDeleteFile(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname === "/users/avatar" && req.method === "POST") {
        await handleUpdateAvatar(res, req, ctx);
      } else if (parsedUrl.pathname === "/users/info" && req.method === "GET") {
        await handleGetUserInfo(res, req, ctx);
      } else if (parsedUrl.pathname === "/memo/voice" && req.method === "POST") {
        await handleMemoVoice(res, req, ctx!);
      } else if (parsedUrl.pathname === "/memo/list" && req.method === "GET") {
        await handleMemoList(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/memo\/[^/]+$/) && req.method === "GET") {
        await handleMemoGet(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/memo\/[^/]+\/send$/) && req.method === "POST") {
        await handleMemoSend(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/memo\/[^/]+$/) && req.method === "PUT") {
        await handleMemoUpdate(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/memo\/[^/]+$/) && req.method === "DELETE") {
        await handleMemoDelete(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname === "/document" && req.method === "POST") {
        await handleDocumentCreate(res, req, ctx!);
      } else if (parsedUrl.pathname === "/document/list" && req.method === "GET") {
        await handleDocumentList(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/document\/[^/]+$/) && req.method === "GET") {
        await handleDocumentGet(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/document\/[^/]+\/send$/) && req.method === "POST") {
        await handleDocumentSend(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/document\/[^/]+\/tasks$/) && req.method === "GET") {
        await handleDocumentTasks(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/document\/[^/]+\/file$/) && (req.method === "GET" || req.method === "PUT")) {
        await handleDocumentFile(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/document\/[^/]+$/) && req.method === "PUT") {
        await handleDocumentUpdate(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/document\/[^/]+$/) && req.method === "DELETE") {
        await handleDocumentDelete(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname === "/api/miniprogram/create" && req.method === "POST") {
        await handleMiniprogramCreate(res, req, ctx!);
      } else if (parsedUrl.pathname === "/api/miniprogram/list" && req.method === "GET") {
        await handleMiniprogramList(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+$/) && req.method === "GET") {
        await handleMiniprogramGet(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/send$/) && req.method === "POST") {
        await handleMiniprogramSend(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+$/) && req.method === "DELETE") {
        await handleMiniprogramDelete(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/build$/) && req.method === "POST") {
        await handleMiniprogramBuild(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/reload$/) && req.method === "POST") {
        await handleMiniprogramReload(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/revise$/) && req.method === "POST") {
        await handleMiniprogramRevise(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/tasks$/) && req.method === "GET") {
        await handleMiniprogramTasks(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/project-files$/) && (req.method === "GET" || req.method === "PUT")) {
        await handleMiniprogramProjectFiles(res, req, parsedUrl, ctx!);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/file\/upload$/) && req.method === "POST") {
        await handleMiniprogramFileUpload(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/file\/[^/]+$/) && req.method === "GET") {
        await handleMiniprogramFileRead(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/file\/[^/]+$/) && req.method === "DELETE") {
        await handleMiniprogramFileDelete(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname.match(/^\/api\/miniprogram\/[^/]+\/.+$/)) {
        await handleMiniprogramCustomApiRequest(res, req, parsedUrl, ctx);
      } else if (parsedUrl.pathname.startsWith("/miniprogram/") && req.method === "GET") {
        await handleMiniprogramPublic(res, req, parsedUrl);
      } else if (parsedUrl.pathname.startsWith("/voices/download/") && req.method === "GET") {
        await handleVoiceDownload(res, req, parsedUrl, ctx!);
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.statusCode, { error: err.message });
      } else {
        logger.error(`HTTP request error: ${err}`);
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  });

  return new Promise((resolve) => {
    serverInstance!.listen(port, () => {
      log?.(`HTTP server listening on port ${port}`);
      resolve(serverInstance!);
    });
  });
}

// ============ URL Parsing ============

function parseUrl(urlStr: string): ParsedUrl {
  const [pathname, search] = urlStr.split("?");
  return {
    pathname: pathname || "/",
    searchParams: new URLSearchParams(search || ""),
  };
}

// ============ Authentication ============

async function authenticateRequest(req: http.IncomingMessage): Promise<RequestContext | null> {
  const authHeader = req.headers.authorization;
  const accountId = getAccountIdFromAuth(authHeader);

  if (!accountId) {
    return null;
  }

  // In a full implementation, you'd look up the username from the account
  // For now, we'll return a minimal context
  return {
    accountId,
    username: accountId,
  };
}

export function requireAuth(ctx: RequestContext | null): RequestContext {
  if (!ctx) {
    throw new HttpError(401, "Unauthorized");
  }
  return ctx;
}

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// ============ Request Body Parsing ============

export async function parseBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        if (body) {
          resolve(JSON.parse(body));
        } else {
          resolve({} as T);
        }
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ============ Response Helpers ============

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ============ MIME Type Helper ============

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
};

export function getMimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

// ============ Route Handlers ============

function handleHealth(res: http.ServerResponse): void {
  sendJson(res, 200, { status: "ok", timestamp: Date.now() });
}

async function handleAuth(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  _ctx: RequestContext | null,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await parseBody<{ username: string; password: string }>(req);

  if (!body.username || !body.password) {
    sendJson(res, 400, { error: "Missing username or password" });
    return;
  }

  const account = await authenticateUser(body.username, body.password);

  if (!account) {
    sendJson(res, 401, { error: "Invalid username or password" });
    return;
  }

  const { token, expiresAt } = generateAuthToken(account.accountId, account.username);
  const downloadToken = generateDownloadToken(account.accountId);

  sendJson(res, 200, {
    token,
    expires_at: expiresAt,
    account_id: account.accountId,
    username: account.username,
    avatar_url: account.avatarUrl || "",
    download_token: downloadToken,
    download_token_expires_in: 3600,
  });
}

async function handleRefreshDownloadToken(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const newToken = generateDownloadToken(authCtx.accountId);
  sendJson(res, 200, {
    download_token: newToken,
    expires_in: 3600,
  });
}

async function handleGetAgents(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  const runtime = getChatClawRuntime();
  if (!runtime?.channel) {
    sendJson(res, 500, { error: "Channel not available" });
    return;
  }

  try {
    let cfg;
    try {
      cfg = runtime.config.loadConfig();
    } catch {
      const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
      const rawConfig = fs.readFileSync(configPath, "utf-8");
      cfg = JSON.parse(rawConfig);
    }

    // 读取智能体头像配置
    const avatarConfig = loadAgentAvatarConfig();
    const typingStates = getAccountTypingStates(authCtx.accountId);

    const allAgents = (cfg.agents?.list || []).map((agent: { id?: string; name?: string; description?: string }) => ({
      id: agent.id || "",
      name: agent.name || agent.id || "",
      description: agent.description || `Agent: ${agent.id}`,
      avatar: avatarConfig[agent.id || ""] || "",
      is_typing: Boolean(agent.id && typingStates[agent.id]),
    }));

    const allowedAgentIds = await listAllowedAgentIds(authCtx.accountId);
    const agentsList = allowedAgentIds.length === 0
      ? allAgents
      : allAgents.filter((agent: { id: string }) => allowedAgentIds.includes(agent.id));

    sendJson(res, 200, { agents: agentsList });
  } catch (err) {
    logger.error(`get_agents failed: ${err}`);
    sendJson(res, 500, { error: `Failed to get agents: ${err}` });
  }
}

// 加载智能体头像配置
function loadAgentAvatarConfig(): Record<string, string> {
  try {
    // 放在 openclaw-chatclaw 状态目录下，与账号管理文件同一位置
    const configPath = path.join(resolveChatClawStateDir(), "agent-avatars.json");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (err) {
    logger.warn(`Failed to load agent avatar config: ${err}`);
  }
  return {};
}

async function handleGetMessages(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  const agentId = parsedUrl.searchParams.get("agent_id") || "nova";
  const page = parseInt(parsedUrl.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(parsedUrl.searchParams.get("page_size") || "20", 10);

  try {
    const result = await messageDB.queryMessages({
      accountId: authCtx.accountId,
      agentId,
      page,
      pageSize,
    });

    sendJson(res, 200, {
      data: result.data,
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
      total_pages: result.totalPages,
    });
  } catch (err) {
    logger.error(`get_messages failed: ${err}`);
    sendJson(res, 500, { error: "Failed to get messages" });
  }
}

async function handleSyncMessages(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  const agentId = parsedUrl.searchParams.get("agent_id") || "nova";
  const since = parsedUrl.searchParams.get("since");
  const sinceTs = since ? parseInt(since, 10) : undefined;

  try {
    const messages = await messageDB.syncMessages({
      accountId: authCtx.accountId,
      agentId,
      since: sinceTs,
    });

    sendJson(res, 200, {
      agent_id: agentId,
      data: messages,
    });
  } catch (err) {
    logger.error(`sync_messages failed: ${err}`);
    sendJson(res, 500, { error: "Failed to sync messages" });
  }
}

async function handleClearMessages(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  if (req.method !== "DELETE") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const agentId = parsedUrl.searchParams.get("agent_id");
  
  if( !agentId ) {
    sendJson(res, 500, { error: "Missing parameters" });
    return;
  }

  try {
    await messageDB.clearMessages(authCtx.accountId, agentId);

    // 发起新的会话 将/new发送给对应的智能体
    const runtime = getChatClawRuntime();
    if (!runtime?.channel) {
      logger.error(`clear_messages: channelRuntime not available`);
    } else {
      const cfg = runtime.config.loadConfig();
      const channel = CHATCLAW_CHANNEL_ID;
      const sessionKey = buildChatClawDirectSessionKey(authCtx.accountId, agentId);

      const ctx: any = {
        Body: '/new',
        BodyForAgent: '/new',
        RawBody: '/new',
        CommandBody: '/new',
        From: authCtx.accountId,
        To: agentId,
        SessionKey: sessionKey,
        AccountId: authCtx.accountId,
        ChatType: 'direct' as const,
        Timestamp: Date.now(),
        Provider: CHATCLAW_CHANNEL_ID,
        Surface: CHATCLAW_CHANNEL_ID,
        OriginatingChannel: CHATCLAW_CHANNEL_ID,
        OriginatingTo: authCtx.accountId,
        SenderName: authCtx.accountId,
        SenderId: authCtx.accountId,
      };

      const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId });
      const finalized = runtime.channel.reply.finalizeInboundContext(ctx);

      try {
        await runtime.channel.session.recordInboundSession({
          storePath,
          sessionKey: sessionKey,
          ctx: finalized,
          updateLastRoute: {
            sessionKey: `agent:${agentId}:main`,
            channel: channel,
            to: authCtx.accountId,
            accountId: authCtx.accountId,
          },
          onRecordError: (err: unknown) => logger.error(`recordInboundSession: ${String(err)}`),
        });
      } catch (err) {
        logger.error(`clear_messages: recordInboundSession failed: ${err}`);
      }

      // 触发智能体处理/new命令（不等待回复）
      const humanDelay = runtime.channel.reply.resolveHumanDelayConfig(cfg, agentId);
      const emptyCallbacks = createTypingCallbacks({
        start: async () => {},
        stop: async () => {},
        onStartError: () => {},
        onStopError: () => {},
      });

      const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
        humanDelay,
        typingCallbacks: emptyCallbacks,
        deliver: async () => {},
        onError: () => {},
      });

      runtime.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => markDispatchIdle(),
        run: () =>
          runtime.channel.reply.dispatchReplyFromConfig({
            ctx: finalized,
            cfg,
            dispatcher,
            replyOptions: { ...replyOptions, disableBlockStreaming: false },
          }),
      }).catch((err) => logger.error(`dispatchReplyFromConfig failed: ${err}`));
    }

    sendJson(res, 200, { agent_id: agentId, cleared: true });
  } catch (err) {
    logger.error(`clear_messages failed: ${err}`);
    sendJson(res, 500, { error: "Failed to clear messages" });
  }
}

async function handleDeleteMessage(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  requireAuth(ctx);

  if (req.method !== "DELETE") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const messageId = path.basename(parsedUrl.pathname);

  if (!messageId) {
    sendJson(res, 400, { error: "Missing message_id" });
    return;
  }

  try {
    await messageDB.deleteMessage(messageId);
    sendJson(res, 200, { message_id: messageId, deleted: true });
  } catch (err) {
    logger.error(`delete_message failed: ${err}`);
    sendJson(res, 500, { error: "Failed to delete message" });
  }
}

async function handleUpdateMessage(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  requireAuth(ctx);

  if (req.method !== "PATCH") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const messageId = path.basename(parsedUrl.pathname);
  const body = await parseBody<{ duration?: number }>(req);

  if (!messageId) {
    sendJson(res, 400, { error: "Missing message_id" });
    return;
  }

  try {
    const updates: messageDB.UpdateMessageParams = {};
    if (body.duration !== undefined) {
      updates.duration = body.duration;
    }
    await messageDB.updateMessage(messageId, updates);
    sendJson(res, 200, { message_id: messageId, updated: true });
  } catch (err) {
    logger.error(`update_message failed: ${err}`);
    sendJson(res, 500, { error: "Failed to update message" });
  }
}

async function handleMarkRead(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await parseBody<{ message_id?: string; agent_id?: string }>(req);

  try {
    if (body.message_id) {
      await messageDB.markAsRead(body.message_id);
      sendJson(res, 200, { message_id: body.message_id, read: true });
    } else if (body.agent_id) {
      await messageDB.markAllAsRead(authCtx.accountId, body.agent_id);
      sendJson(res, 200, { agent_id: body.agent_id, all_read: true });
    } else {
      sendJson(res, 400, { error: "Missing message_id or agent_id" });
    }
  } catch (err) {
    logger.error(`mark_read failed: ${err}`);
    sendJson(res, 500, { error: "Failed to mark as read" });
  }
}

async function handleGetUnreadCount(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  const agentId = parsedUrl.searchParams.get("agent_id") || undefined;

  try {
    const count = await messageDB.getUnreadCount(authCtx.accountId, agentId || undefined);
    sendJson(res, 200, {
      agent_id: agentId || null,
      count,
    });
  } catch (err) {
    logger.error(`get_unread_count failed: ${err}`);
    sendJson(res, 500, { error: "Failed to get unread count" });
  }
}

async function handleGetFiles(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  const agentId = parsedUrl.searchParams.get("agent_id") || undefined;
  const contentType = parsedUrl.searchParams.get("content_type") || undefined;
  const page = parseInt(parsedUrl.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(parsedUrl.searchParams.get("page_size") || "20", 10);

  try {
    const result = await filesDB.queryFiles({
      accountId: authCtx.accountId,
      agentId,
      contentType,
      page,
      pageSize,
    });

    sendJson(res, 200, {
      data: result.data,
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
      total_pages: result.totalPages,
    });
  } catch (err) {
    logger.error(`get_files failed: ${err}`);
    sendJson(res, 500, { error: "Failed to get files" });
  }
}

async function handleDeleteFile(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  if (req.method !== "DELETE") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const fileId = path.basename(parsedUrl.pathname);

  if (!fileId) {
    sendJson(res, 400, { error: "Missing file_id" });
    return;
  }

  try {
    // Get file record to check ownership
    const fileRecord = await filesDB.getFileRecordByFileId(fileId);
    if (!fileRecord) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }
    if (fileRecord.accountId !== authCtx.accountId) {
      sendJson(res, 403, { error: "Not authorized" });
      return;
    }

    // 直接删除本地文件和记录，不管消息是否引用
    fileStorage.deleteLocalFile(fileId, fileRecord.accountId);
    await filesDB.deleteFileRecordByFileId(fileId);

    sendJson(res, 200, { file_id: fileId, deleted: true });
  } catch (err) {
    logger.error(`delete_file failed: ${err}`);
    sendJson(res, 500, { error: "Failed to delete file" });
  }
}

async function handleUploadFile(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  interface UploadBody {
    file_name?: string;
    content_type?: string;
    data?: string; // base64 encoded file content
    agent_id?: string;
  }

  const body = await parseBody<UploadBody>(req);

  if (!body.data) {
    sendJson(res, 400, { error: "Missing file data (base64)" });
    return;
  }

  if (!body.file_name) {
    sendJson(res, 400, { error: "Missing file_name" });
    return;
  }

  try {
    // 解码 base64 文件内容
    const fileBuffer = Buffer.from(body.data, 'base64');
    const contentType = body.content_type || 'application/octet-stream';

    // 保存文件到本地存储
    const finalFileName = await filesDB.resolveAvailableFileName(authCtx.accountId, body.file_name);
    const fileInfo = await fileStorage.saveFile(
      fileBuffer,
      authCtx.accountId,
      finalFileName,
      contentType
    );

    // 创建文件记录
    await filesDB.createFileRecord({
      fileId: fileInfo.id,
      fileUrl: fileInfo.fileUrl,
      coverUrl: fileInfo.coverUrl,
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
      contentType: fileInfo.contentType,
      accountId: authCtx.accountId,
      agentId: body.agent_id,
    });

    sendJson(res, 200, {
      id: fileInfo.id,
      file_name: fileInfo.fileName,
      file_url: fileInfo.fileUrl,
      cover_url: fileInfo.coverUrl,
      file_size: fileInfo.fileSize,
      content_type: fileInfo.contentType,
      created_at: fileInfo.createdAt,
    });
  } catch (err) {
    logger.error(`upload_file failed: ${err}`);
    sendJson(res, 500, { error: "Failed to upload file" });
  }
}

async function handleDownloadFile(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  _ctx: RequestContext | null,
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const pathname = parsedUrl.pathname!;

  // 公开文件下载：/files/download/public/fileId
  if (pathname.startsWith('/files/download/public/')) {
    const fileId = decodeURIComponent(pathname.replace('/files/download/public/', ''));
    if (!fileId) {
      sendJson(res, 400, { error: "Missing file_id" });
      return;
    }

    try {
      const fileBuffer = fileStorage.readPublicFile(fileId);
      if (!fileBuffer) {
        sendJson(res, 404, { error: "File not found" });
        return;
      }

      const fileSize = fileBuffer.length;
      const range = req.headers.range;
      const contentType = fileStorage.getContentTypeFromFileId(fileId);
      const fileName = fileStorage.getFileNameFromFileId(fileId);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=31536000");
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        res.setHeader("Content-Length", chunkSize);
        res.writeHead(206);
        res.end(fileBuffer.slice(start, end + 1));
      } else {
        res.setHeader("Content-Length", fileSize);
        res.writeHead(200);
        res.end(fileBuffer);
      }
    } catch (err) {
      logger.error(`download_public_file failed: ${err}`);
      sendJson(res, 500, { error: "Failed to download file" });
    }
    return;
  }

  // 受保护文件下载：/files/download/accountId/fileId
  const pathParts = pathname.replace('/files/download/', '').split('/');
  const accountId = decodeURIComponent(pathParts[0]);
  const fileId = decodeURIComponent(pathParts[1]);

  if (!fileId || !accountId) {
    sendJson(res, 400, { error: "Missing file_id or account_id" });
    return;
  }

  // 验证下载 Token
  const token = parsedUrl.searchParams.get("token");
  if (!token || !verifyDownloadToken(token, accountId)) {
    sendJson(res, 401, { error: "Invalid or expired download token" });
    return;
  }

  try {
    // 直接读取本地文件，不再查询数据库
    const fileBuffer = fileStorage.readFile(fileId, accountId);
    if (!fileBuffer) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }

    const fileSize = fileBuffer.length;
    const range = req.headers.range;

    // 根据文件扩展名推断正确的 MIME 类型
    const contentType = fileStorage.getContentTypeFromFileId(fileId);
    const fileName = fileStorage.getFileNameFromFileId(fileId);

    // 通用响应头
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // 支持 Range 请求
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", chunkSize);
      res.writeHead(206);
      res.end(fileBuffer.slice(start, end + 1));
    } else {
      res.setHeader("Content-Length", fileSize);
      res.writeHead(200);
      res.end(fileBuffer);
    }
  } catch (err) {
    logger.error(`download_file failed: ${err}`);
    sendJson(res, 500, { error: "Failed to download file" });
  }
}

async function handleUpdateAvatar(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await parseBody<{ avatar_url: string }>(req);

  if (!body.avatar_url) {
    sendJson(res, 400, { error: "Missing avatar_url" });
    return;
  }

  try {
    const updated = updateChatClawAccountAvatar(authCtx.accountId, body.avatar_url);
    if (!updated) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }
    sendJson(res, 200, { avatar_url: body.avatar_url, updated: true });
  } catch (err) {
    logger.error(`update_avatar failed: ${err}`);
    sendJson(res, 500, { error: "Failed to update avatar" });
  }
}

async function handleGetUserInfo(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);

  const account = loadChatClawAccount(authCtx.accountId);
  if (!account) {
    sendJson(res, 404, { error: "Account not found" });
    return;
  }

  sendJson(res, 200, {
    account_id: account.accountId,
    username: account.username,
    avatar_url: account.avatarUrl || "",
  });
}

// ============ Server Lifecycle ============

let serverInstance: http.Server | null = null;

export async function stopHttpServer(): Promise<void> {
  if (serverInstance) {
    await new Promise<void>((resolve) => {
      serverInstance!.close(() => resolve());
    });
    serverInstance = null;
  }
}
