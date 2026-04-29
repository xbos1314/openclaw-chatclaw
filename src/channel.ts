import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import path from "path";

import {
  registerChatClawAccountId,
  loadChatClawAccount,
  saveChatClawAccount,
  listChatClawAccountIds,
  resolveChatClawAccount,
} from "./auth/accounts.js";
import type { ResolvedChatClawAccount } from "./auth/accounts.js";
import { logger } from "./util/logger.js";
import {
  startChatClawWsServer,
  stopChatClawWsServer,
  sendToClientByAccountId,
} from "./websocket/server.js";
import * as messageDB from "./db/message.js";
import * as filesDB from "./db/files.js";
import { shouldSkipFilesDbRecord } from "./media/filePolicy.js";
import { parseAgentIdFromSessionKey } from "./session/routing.js";

export {};

function resolveOutboundAccountId(
  cfg: OpenClawConfig,
  to: string,
): string {
  const allIds = listChatClawAccountIds(cfg);

  if (allIds.length === 0) {
    throw new Error(`chatclaw: no accounts registered`);
  }

  if (allIds.length === 1) {
    logger.info(`resolveOutboundAccountId: single account, using ${allIds[0]}`);
    return allIds[0];
  }

  if (allIds.includes(to)) {
    return to;
  }

  const matched = allIds.find(id => to.includes(id) || id.includes(to));
  if (matched) {
    return matched;
  }

  logger.warn(`resolveOutboundAccountId: no match for to=${to}, using first account ${allIds[0]}`);
  return allIds[0];
}

function resolveOutboundAgentId(ctx: { sessionKey?: string | null; to: string }, extras: Record<string, unknown>): string | undefined {
  return readStringParam(extras, ["agentId", "fromAgentId", "agent_id"])
    || parseAgentIdFromSessionKey(ctx.sessionKey ?? null)
    || undefined;
}

function getMissingAgentIdError(context: string): Error {
  return new Error(
    `${context}: missing agentId. Pass the current agent explicitly when using the message tool, for example {"action":"send","target":"<accountId>","accountId":"<accountId>","agentId":"<agentId>","message":"..."}.`,
  );
}

async function sendChatClawOutbound(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
  agentId?: string;
  media?: { filePath: string; fileName?: string; type?: string; fileSize?: number; duration?: number };
}): Promise<{ channel: string; messageId: string }> {
  const account = resolveChatClawAccount(params.cfg, params.accountId);
  const aLog = logger.withAccount(account.accountId);

  if (!account.configured) {
    aLog.error(`sendChatClawOutbound: account not configured`);
    throw new Error("chatclaw not configured");
  }

  const agentId = params.agentId?.trim();
  if (!agentId) {
    throw getMissingAgentIdError("ChatClaw outbound send");
  }
  const messageId = `msg_${Date.now()}`;

  if (params.media) {
    const { uploadFileAs } = await import("./media/upload.js");
    try {
      const finalFileName = await filesDB.resolveAvailableFileName(account.accountId, params.media.fileName || 'file');
      const uploadResult = await uploadFileAs(params.media.filePath, account.accountId, finalFileName);
      const resolvedDuration = params.media.duration ?? uploadResult.duration;

      // 保存消息到数据库，获取消息 ID
      const savedMsg = await messageDB.createMessage({
        accountId: account.accountId,
        agentId,
        direction: 'outbound',
        contentType: params.media.type || 'file',
        content: params.text || `[${params.media.type || 'file'}: ${uploadResult.fileName}]`,
        fileUrl: uploadResult.fileUrl,
        coverUrl: uploadResult.coverUrl,
        fileName: uploadResult.fileName,
        fileSize: uploadResult.fileSize ? parseInt(uploadResult.fileSize, 10) : 0,
        duration: resolvedDuration,
      });

      sendToClientByAccountId(account.accountId, {
        type: "message",
        id: savedMsg.id,
        agent_id: agentId,
        contentType: params.media.type || 'file',
        content: params.text || `[${params.media.type || 'file'}: ${uploadResult.fileName}]`,
        fileUrl: uploadResult.fileUrl,
        coverUrl: uploadResult.coverUrl,
        fileName: uploadResult.fileName,
        duration: resolvedDuration,
        timestamp: Date.now(),
      });

      // 保存文件记录到独立数据库
      const fileSize = uploadResult.fileSize ? parseInt(uploadResult.fileSize, 10) : 0;
      if (uploadResult.id && !shouldSkipFilesDbRecord({
        contentType: params.media.type || 'file',
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
          contentType: params.media.type || 'file',
          accountId: account.accountId,
          agentId,
        });
      }
    } catch (err) {
      aLog.error(`Failed to upload file: ${err}`);
      // 抛出错误给智能体处理
      throw new Error(`文件上传失败: ${params.media.fileName}`);
    }
  } else if( params.text != null && params.text != '' ) {
    // 保存文字消息到数据库，获取消息 ID
    const savedMsg = await messageDB.createMessage({
      accountId: account.accountId,
      agentId,
      direction: 'outbound',
      contentType: 'text',
      content: params.text,
    });

    sendToClientByAccountId(account.accountId, {
      type: "message",
      id: savedMsg.id,
      agent_id: agentId,
      contentType: 'text',
      content: params.text,
      timestamp: Date.now(),
    });
  }

  return { channel: "openclaw-chatclaw", messageId };
}

function getFileTypeOnMessage(url: any): string {
  let type = 'file';
  if (url.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
    type = 'image';
  } else if (url.match(/\.(mp4|mov|avi|mkv|webm)$/)) {
    type = 'video';
  } else if (url.match(/\.(mp3|wav|ogg|m4a)$/)) {
    type = 'audio';
  }
  return type;
}

function readStringParam(
  params: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function readMediaParam(params: Record<string, unknown>): string | undefined {
  const direct = readStringParam(params, ['media', 'mediaUrl', 'filePath', 'path']);
  if (direct) {
    return direct;
  }

  const mediaUrls = params.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    const first = mediaUrls.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (typeof first === 'string') {
      return first.trim();
    }
  }

  return undefined;
}

export const chatclawPlugin: ChannelPlugin<ResolvedChatClawAccount> = {
  id: "openclaw-chatclaw",
  meta: {
    id: "openclaw-chatclaw",
    label: "openclaw-chatclaw",
    selectionLabel: "openclaw-chatclaw (WebSocket)",
    docsPath: "/channels/openclaw-chatclaw",
    docsLabel: "openclaw-chatclaw",
    blurb: "ChatClaw APP channel via WebSocket",
    order: 80,
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        port: { type: "number", default: 9788 },
        maxConnections: { type: "number", default: 100 },
        heartbeatInterval: { type: "number", default: 30000 },
      },
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 200,
      idleMs: 3000,
    },
  },
  messaging: {
    targetResolver: {
      looksLikeId: (raw) => raw.includes("chatclaw_") || raw.includes("@chatclaw"),
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "To send a message to the ChatClaw user, use the message tool with action='send', a real ChatClaw accountId, and the current agentId.",
      "IMPORTANT: When outputting a MEDIA: directive to send a file, the MEDIA: tag MUST be on its own line.",
    ],
  },
  actions: {
    describeMessageTool: () => ({
      actions: ["send"],
    }),
    supportsAction: ({ action }) => action === "send",
    extractToolSend: ({ args }) => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action !== "send") {
        return null;
      }

      const target = readStringParam(args, ["target", "to"]);
      if (!target) {
        return null;
      }

      const accountId = readStringParam(args, ["accountId"]);
      const threadId = readStringParam(args, ["threadId"]);
      return {
        to: target,
        ...(accountId ? { accountId } : {}),
        ...(threadId ? { threadId } : {}),
      };
    },
    handleAction: async ({ action, params, cfg, accountId }) => {
      if (action !== "send") {
        throw new Error(`Action ${action} is not supported for provider openclaw-chatclaw.`);
      }

      const target = readStringParam(params, ["target", "to"]);
      if (!target) {
        throw new Error("Missing target for send action.");
      }

      const text = typeof params.message === "string" ? params.message : "";
      const mediaPath = readMediaParam(params);
      if (!text && !mediaPath) {
        throw new Error("send action requires message or media.");
      }

      const resolvedAccountId = accountId ?? undefined;
      const agentId = readStringParam(params, ["agentId", "agent_id"]);
      if (!agentId) {
        throw getMissingAgentIdError("ChatClaw message action=send");
      }

      const result = await sendChatClawOutbound({
        cfg,
        to: target,
        text,
        accountId: resolvedAccountId,
        agentId,
        media: mediaPath ? {
          filePath: mediaPath,
          fileName: path.basename(mediaPath),
          type: params.asVoice === true ? 'voice' : getFileTypeOnMessage(mediaPath),
        } : undefined,
      });

      return jsonResult(result);
    },
  },
  reload: { configPrefixes: ["channels.openclaw-chatclaw"] },
  config: {
    listAccountIds: (cfg) => listChatClawAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveChatClawAccount(cfg, accountId),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      const ctxAny = ctx as any;

      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const agentId = resolveOutboundAgentId({ sessionKey: ctxAny.sessionKey || ctxAny.SessionKey, to: ctx.to }, ctxAny);

      if (!agentId) {
        throw getMissingAgentIdError(
          `ChatClaw outbound.sendText could not resolve agentId from sessionKey=${String(ctxAny.sessionKey || ctxAny.SessionKey || "")}`,
        );
      }

      const media = (ctxAny.asVoice && ctxAny.filePath) ? {
        filePath: ctxAny.filePath,
        fileName: ctxAny.filePath.split('/').pop(),
        type: 'voice',
      } : undefined;

      const result = await sendChatClawOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text ?? ctxAny.message ?? "",
        accountId,
        agentId,
        media
      });
      return result;
    },
    sendMedia: async (ctx) => {
      const ctxAny = ctx as any;

      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const agentId = resolveOutboundAgentId({ sessionKey: ctxAny.sessionKey || ctxAny.SessionKey, to: ctx.to }, ctxAny);

      if (!agentId) {
        throw getMissingAgentIdError(
          `ChatClaw outbound.sendMedia could not resolve agentId from sessionKey=${String(ctxAny.sessionKey || ctxAny.SessionKey || "")}`,
        );
      }

      if (!ctxAny.mediaUrl) {
        return { channel: "openclaw-chatclaw", messageId: `msg_${Date.now()}` };
      }

      const type = ctxAny.asVoice ? 'voice' : getFileTypeOnMessage(ctxAny.mediaUrl);

      const result = await sendChatClawOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text ?? ctxAny.message ?? "",
        accountId,
        agentId,
        media: {
          filePath: ctxAny.mediaUrl,
          fileName: ctxAny.mediaUrl.split('/').pop(),
          type,
        },
      });
      return result;
    },
  },
  status: {
    defaultRuntime: {
      accountId: "",
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
};
