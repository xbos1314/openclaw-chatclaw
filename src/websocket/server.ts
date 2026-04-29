import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import type net from "node:net";

import { logger } from "../util/logger.js";
import { getChatClawRuntime } from "../runtime.js";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { verifyTokenGetAccount } from "../auth/token.js";
import { canAccountAccessAgent } from "../auth/accounts.js";
import { downloadAndSaveFile } from "../media/download.js";
import { uploadFile, uploadFileAs, deleteFile } from "../media/upload.js";
import * as fileStorage from "../media/fileStorage.js";
import { shouldSkipFilesDbRecord } from "../media/filePolicy.js";
import * as messageDB from "../db/message.js";
import * as filesDB from "../db/files.js";
import { updateTypingState } from "../typing/state.js";
import { buildChatClawDirectSessionKey, CHATCLAW_CHANNEL_ID } from "../session/routing.js";

interface WsServerOptions {
  server: http.Server;
  maxConnections: number;
  heartbeatInterval: number;
  path?: string;
  log?: (...args: unknown[]) => void;
}

interface ConnectedClient {
  ws: WebSocket;
  accountId: string;
  connectedAt: string;
}

export let wss: WebSocketServer | null = null;
export let wssClosed = false;
export const clients = new Map<string, ConnectedClient>();
const authenticatedSocketAccounts = new WeakMap<WebSocket, { accountId: string }>();
let upgradeServer: http.Server | null = null;
let upgradePath = "/ws";
let maxWsConnections = 100;

// ============ Server Start/Stop ============

export async function startChatClawWsServer(options: WsServerOptions): Promise<void> {
  const { log } = options;
  upgradeServer = options.server;
  upgradePath = options.path ?? "/ws";
  maxWsConnections = options.maxConnections;

  wss = new WebSocketServer({
    noServer: true,
  });

  upgradeServer.on("upgrade", handleUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    const clientId = randomUUID();
    const account = authenticatedSocketAccounts.get(ws);
    if (!account) {
      logger.warn(`Rejected unauthenticated WebSocket connection: ${clientId}`);
      ws.close();
      return;
    }

    clients.set(clientId, { ws, accountId: account.accountId, connectedAt: new Date().toISOString() });
    logger.info(`Client connected: ${clientId}, accountId=${account.accountId}`);
    let isAlive = true;

    const heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!isAlive) {
        logger.warn(`Client heartbeat timed out: ${clientId}`);
        cleanupClient(clientId, heartbeatTimer);
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, options.heartbeatInterval);

    ws.on("pong", () => {
      isAlive = true;
    });

    ws.on("message", async (data: Buffer) => {
      isAlive = true;
      try {
        const json = JSON.parse(data.toString());
        await handleClientMessage(clientId, ws, json);
      } catch (err) {
        logger.error(`Failed to parse message: ${err}`);
        send(ws, { type: "error", error: "Invalid JSON" });
      }
    });

    ws.on("close", () => {
      authenticatedSocketAccounts.delete(ws);
      cleanupClient(clientId, heartbeatTimer);
      logger.info(`Client disconnected: ${clientId}`);
    });

    ws.on("error", (err: Error) => {
      authenticatedSocketAccounts.delete(ws);
      logger.error(`WebSocket error: ${err.message}`);
      cleanupClient(clientId, heartbeatTimer);
    });
  });

  wss.on("error", (err: Error) => {
    logger.error(`WebSocketServer error: ${err.message}`);
  });

  log?.(`ChatClaw WebSocket server attached on path ${upgradePath}`);
}

function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  if (!wss) {
    rejectUpgrade(socket, 503, "Service Unavailable");
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== upgradePath) {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token");
  if (!token) {
    rejectUpgrade(socket, 401, "Missing token");
    return;
  }

  const accountInfo = verifyTokenGetAccount(token);
  if (!accountInfo) {
    rejectUpgrade(socket, 401, "Invalid or expired token");
    return;
  }

  if (clients.size >= maxWsConnections) {
    rejectUpgrade(socket, 503, "Too many connections");
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    authenticatedSocketAccounts.set(ws, { accountId: accountInfo.accountId });
    wss?.emit("connection", ws, req);
  });
}

function rejectUpgrade(socket: net.Socket, statusCode: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message
  );
  socket.destroy();
}

function cleanupClient(clientId: string, heartbeatTimer: NodeJS.Timeout): void {
  clearInterval(heartbeatTimer);
  clients.delete(clientId);
}

export async function stopChatClawWsServer(): Promise<void> {
  return new Promise((resolve) => {
    for (const [clientId, client] of clients) {
      client.ws.close();
      clients.delete(clientId);
    }
    if (upgradeServer) {
      upgradeServer.off("upgrade", handleUpgrade);
      upgradeServer = null;
    }
    if (wss) {
      wss.close(() => {
        wss = null;
        wssClosed = true;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function resolveInboundMediaType(params: {
  messageType: string;
}): string {
  if (params.messageType === "send_image") {
    return "image";
  }

  if (params.messageType === "send_audio") {
    return "audio";
  }

  if (params.messageType === "send_video") {
    return "video";
  }

  if (params.messageType === "send_voice") {
    return "voice";
  }

  return "file";
}

// ============ Message Handlers ============

async function handleClientMessage(clientId: string, ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
  const type = msg.type as string;

  switch (type) {
    case "send_text": {
      const client = clients.get(clientId);
      if (!client) {
        send(ws, { type: "error", error: "Not authenticated" });
        return;
      }
      const text = msg.text as string;
      if (!text) {
        send(ws, { type: "error", error: "Missing text" });
        return;
      }
      const agentId = (msg.agent_id as string) || CHATCLAW_AGENT_ID;
      const requestId = (msg.request_id as string) || String(Date.now());
      if (!(await canAccountAccessAgent(client.accountId, agentId))) {
        send(ws, { type: "error", error: "Agent not allowed", request_id: requestId });
        return;
      }

      // 保存消息到数据库，获取消息 ID
      const savedMsg = await messageDB.createMessage({
        accountId: client.accountId,
        agentId,
        direction: 'inbound',
        contentType: 'text',
        content: text,
        requestId,
      });

      await dispatchToAgent(clientId, client.accountId, text, requestId, agentId);
      sendToClientByAccountId(client.accountId, { type: "message_sent", request_id: requestId, message_id: savedMsg.id });
      break;
    }

    case "send_image":
    case "send_audio":
    case "send_voice":
    case "send_video":
    case "send_file": {
      const client = clients.get(clientId);
      if (!client) {
        send(ws, { type: "error", error: "Not authenticated" });
        return;
      }
      const fileUrl = msg.file_url as string;
      const agentId = (msg.agent_id as string) || CHATCLAW_AGENT_ID;
      const requestId = (msg.request_id as string) || String(Date.now());
      const fileName = (msg.file_name as string) || path.basename(fileUrl || '');
      const fileSize = (msg.file_size as number) || 0;
      const duration = (msg.duration as number) || 0;
      let coverUrl = msg.cover_url as string | undefined;
      if (!(await canAccountAccessAgent(client.accountId, agentId))) {
        send(ws, { type: "error", error: "Agent not allowed", request_id: requestId });
        return;
      }

      if (!fileUrl) {
        send(ws, { type: "error", error: "Missing file_url", request_id: requestId });
        return;
      }

      try {
        // 判断文件URL是否是本地存储的URL
        let filePath: string;
        if (fileUrl.startsWith('/files/download/')) {
          // 本地文件URL，直接使用本地路径
          // 格式: /files/download/accountId/fileId
          const parts = fileUrl.replace('/files/download/', '').split('/');
          const fileId = parts.pop();
          const accountId = parts.join('/');
          if (fileId && accountId) {
            filePath = fileStorage.getFilePath(fileId, accountId);
            if (type === 'send_video') {
              await fileStorage.ensureVideoCover(fileId, accountId);
              coverUrl = fileStorage.getVideoCoverUrlPath(fileId, accountId);
            }
          } else {
            throw new Error('Invalid file URL');
          }
        } else {
          // 第三方URL，下载到本地
          filePath = await downloadAndSaveFile(fileUrl, client.accountId);
          if (type === 'send_video') {
            const localFileId = path.basename(filePath);
            await fileStorage.ensureVideoCover(localFileId, client.accountId);
            coverUrl = fileStorage.getVideoCoverUrlPath(localFileId, client.accountId);
          }
        }

        const mediaType = resolveInboundMediaType({ messageType: type });

        // 保存消息到数据库，获取消息 ID
        const savedMsg = await messageDB.createMessage({
          accountId: client.accountId,
          agentId,
          direction: 'inbound',
          contentType: mediaType,
          content: `[${mediaType}: ${fileName}]`,
          fileUrl,
          coverUrl,
          fileName,
          fileSize,
          duration,
          requestId,
        });

        await dispatchToAgent(clientId, client.accountId, `[${mediaType}: ${fileName}]`, requestId, agentId, { type: mediaType, fileName, filePath });
        sendToClientByAccountId(client.accountId, { type: "message_sent", request_id: requestId, message_id: savedMsg.id });
      } catch (err) {
        logger.error(`Failed to process media: ${err}`);
        sendToClientByAccountId(client.accountId, { type: "error", error: "Failed to process media", request_id: requestId });
      }
      break;
    }

    case "ping": {
      send(ws, { type: "pong" });
      break;
    }

    default:
      send(ws, { type: "error", error: `Unknown type: ${type}` });
  }
}

// ============ Dispatch to Agent ============

const CHATCLAW_AGENT_ID = "nova";

function getMimeTypeFromExt(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  const map: Record<string, string> = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'm4a': 'audio/mp4',
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg',
    'wav': 'audio/wav',
  };
  return map[ext || ''] || 'application/octet-stream';
}

async function dispatchToAgent(clientId: string, accountId: string, text: string, requestId: string, agentId?: string, media?: { type: string; fileName: string; filePath: string }): Promise<void> {
  const runtime = getChatClawRuntime();
  if (!runtime?.channel) {
    logger.error(`dispatchToAgent: channelRuntime not available`);
    sendToClientByAccountId(accountId, { type: "error", error: "Channel not available" });
    return;
  }

  const log = logger.withAccount(accountId);

  const cfg = runtime.config.loadConfig();
  const resolvedAgentId = agentId || CHATCLAW_AGENT_ID;
  const channel = CHATCLAW_CHANNEL_ID;
  const sessionKey = buildChatClawDirectSessionKey(accountId, resolvedAgentId);

  const ctx: any = {
    Body: text,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: accountId,
    To: resolvedAgentId,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: "direct" as const,
    Timestamp: Date.now(),
    Provider: CHATCLAW_CHANNEL_ID,
    Surface: CHATCLAW_CHANNEL_ID,
    OriginatingChannel: CHATCLAW_CHANNEL_ID,
    OriginatingTo: accountId,
    SenderName: accountId,
    SenderId: accountId,
  };

  if (media) {
    ctx.MediaPath = media.filePath;
    ctx.MediaType = getMimeTypeFromExt(media.fileName);
    ctx.MediaFileName = media.fileName;
  }

  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: resolvedAgentId });
  const finalized = runtime.channel.reply.finalizeInboundContext(ctx);

  try {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionKey,
      ctx: finalized,
      updateLastRoute: {
        sessionKey: `agent:${resolvedAgentId}:main`,
        channel: channel,
        to: accountId,
        accountId,
      },
      onRecordError: (err: unknown) => log.error(`recordInboundSession: ${String(err)}`),
    });
  } catch (err) {
    log.error(`recordInboundSession failed: ${err}`);
  }

  const humanDelay = runtime.channel.reply.resolveHumanDelayConfig(cfg, resolvedAgentId);

  // 创建 deliver 回调 - 保存消息并推送
  const deliver = async (payload: OutboundReplyPayload): Promise<void> => {
    const replyText = payload.text ?? "";
    const message: any = {
      type: "message",
      agent_id: resolvedAgentId,
      timestamp: Date.now(),
    };

    const payloadAny = payload as any;
    if (payloadAny.attachments && payloadAny.attachments.length > 0) {
      const attachment = payloadAny.attachments[0];

      try {
        const finalFileName = await filesDB.resolveAvailableFileName(accountId, attachment.fileName || 'file');
        // 上传文件并获取完整的上传结果
        const uploadResult = await uploadFileAs(attachment.filePath, accountId, finalFileName);

        // 解析文件大小（从字符串转换为数字）
        const fileSize = uploadResult.fileSize ? parseInt(uploadResult.fileSize, 10) : 0;
        const resolvedDuration = uploadResult.duration;

        // 保存到数据库，获取消息 ID
        const savedMsg = await messageDB.createMessage({
          accountId,
          agentId: resolvedAgentId,
          direction: 'outbound',
          contentType: attachment.type || 'file',
          content: replyText || `[${attachment.type || 'file'}: ${uploadResult.fileName}]`,
          fileUrl: uploadResult.fileUrl,
          coverUrl: uploadResult.coverUrl,
          fileName: uploadResult.fileName,
          fileSize: isNaN(fileSize) ? 0 : fileSize,
          duration: resolvedDuration,
          fileId: uploadResult.id,
        });

        // 保存文件记录到独立数据库
        if (uploadResult.id && !shouldSkipFilesDbRecord({
          contentType: attachment.type || 'file',
          fileName: uploadResult.fileName,
          fileUrl: uploadResult.fileUrl,
          mimeType: uploadResult.fileType,
        })) {
          await filesDB.createFileRecord({
            fileId: uploadResult.id,
            fileUrl: uploadResult.fileUrl,
            coverUrl: uploadResult.coverUrl,
            fileName: uploadResult.fileName,
            fileSize: isNaN(fileSize) ? 0 : fileSize,
            duration: resolvedDuration,
            contentType: attachment.type || 'file',
            accountId,
            agentId: resolvedAgentId,
          });
        }

        // 推送格式与数据库格式一致
        message.id = savedMsg.id;
        message.contentType = attachment.type || 'file';
        message.content = replyText || `[${attachment.type || 'file'}: ${uploadResult.fileName}]`;
        message.fileUrl = uploadResult.fileUrl;
        message.coverUrl = uploadResult.coverUrl;
        message.fileName = uploadResult.fileName;
        message.fileSize = savedMsg.fileSize;
        message.duration = savedMsg.duration;
        message.read = savedMsg.read;
      } catch (err) {
        logger.error(`Failed to upload file: ${err}`);
        // 抛出错误给智能体处理
        throw new Error(`文件上传失败: ${attachment.fileName}`);
      }
    } else {
      // 保存到数据库，获取消息 ID
      const savedMsg = await messageDB.createMessage({
        accountId,
        agentId: resolvedAgentId,
        direction: 'outbound',
        contentType: 'text',
        content: replyText,
      });

      // 推送格式与数据库格式一致
      message.id = savedMsg.id;
      message.contentType = 'text';
      message.content = replyText;
      message.read = savedMsg.read;
    }

    // 推送给客户端
    // 使用 accountId 查找当前活跃的客户端连接，而不是 clientId
    // 这样即使客户端断开重连，只要账号在线，消息就能正确送达
    sendToClientByAccountId(accountId, message);
  };

  // 创建真实的 typing callbacks - 使用 accountId 查找当前活跃连接
  // 这样即使客户端断开重连，只要账号在线，typing 状态就能正确送达
  const realTypingCallbacks = createTypingCallbacks({
    start: async () => {
      // 更新状态缓存
      updateTypingState(accountId, resolvedAgentId, true);
      sendToClientByAccountId(accountId, { type: "typing_start", agent_id: resolvedAgentId });
    },
    stop: async () => {
      // 更新状态缓存
      updateTypingState(accountId, resolvedAgentId, false);
      sendToClientByAccountId(accountId, { type: "typing_stop", agent_id: resolvedAgentId });
    },
    onStartError: (err) => log.error(`typing start error: ${String(err)}`),
    onStopError: (err) => log.error(`typing stop error: ${String(err)}`),
  });

  const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
    humanDelay,
    typingCallbacks: realTypingCallbacks,
    deliver,
    onError: (err: unknown, info: { kind: string }) => {
      log.error(`Reply error [${info.kind}]: ${String(err)}`);
    },
  });

  try {
    await runtime.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => markDispatchIdle(),
      run: () =>
        runtime.channel.reply.dispatchReplyFromConfig({
          ctx: finalized,
          cfg,
          dispatcher,
          replyOptions: { ...replyOptions, disableBlockStreaming: false },
        }),
    });
  } finally {
    markDispatchIdle();
  }
}

// ============ Send to Client ============

export function sendToClient(clientId: string, msg: Record<string, unknown>): void {
  const client = clients.get(clientId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

export function sendToClientByAccountId(accountId: string, msg: Record<string, unknown>): void {
  let sent = false;
  for (const [clientId, client] of clients) {
    if (client.accountId === accountId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
      sent = true;
    }
  }

  // 消息仅保存到数据库，不做离线缓存
  // APP 通过 pull_messages 或 sync_messages 主动拉取
  if (!sent) {
    logger.info(`Client offline, message saved to DB for account ${accountId}`);
  }
}
