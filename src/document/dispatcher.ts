import { getChatClawRuntime } from '../runtime.js';
import type { OutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { logger } from '../util/logger.js';
import { sendToClientByAccountId } from '../websocket/server.js';
import * as messageDB from '../db/message.js';
import { buildChatClawDirectSessionKey, CHATCLAW_CHANNEL_ID } from '../session/routing.js';

interface DispatchDocumentOptions {
  mode?: 'context' | 'edit';
  fileName?: string;
  filePath?: string;
  summary?: string;
  taskId?: string;
}

export async function dispatchDocumentToAgent(
  accountId: string,
  documentId: string,
  agentId: string,
  options: DispatchDocumentOptions = {},
): Promise<{ requestMessageId: string }> {
  const runtime = getChatClawRuntime();
  if (!runtime?.channel) {
    logger.error(`dispatchDocumentToAgent: channelRuntime not available`);
    return { requestMessageId: '' };
  }

  const resolvedAgentId = agentId || 'nova';
  const channel = CHATCLAW_CHANNEL_ID;
  const sessionKey = buildChatClawDirectSessionKey(accountId, resolvedAgentId);
  const mode = options.mode || 'context';
  const isEditMode = mode == 'edit';
  const documentText = isEditMode
      ? [
          '[云文档编辑请求]',
          `document_id: ${documentId}`,
          `accountId: ${accountId}`,
          `agent_id: ${resolvedAgentId}`,
          options.taskId ? `task_id: ${options.taskId}` : '',
          '',
          '请先调用 chatclaw_document，参数：{"action":"get","accountId":"上述 accountId","agentId":"上述 agent_id","document_id":"上述 document_id"}',
          '读取当前文档的 file_name、file_path、summary。',
          '然后直接编辑 file_path 指向的原始 .md 文件，不再调用任何文档内容更新工具。',
          options.taskId
              ? '请使用 chatclaw_document.update_task 维护该任务状态：开始时 running，完成后 completed，失败时 failed。'
              : '如需记录这次修改，请先调用 chatclaw_document.create_task 创建任务日志，再在过程中更新状态。',
          '不要只输出普通聊天回复而不修改原文件。',
        ].filter(Boolean).join('\n')
      : [
          '[云文档上下文请求]',
          `document_id: ${documentId}`,
          `accountId: ${accountId}`,
          `agent_id: ${resolvedAgentId}`,
          '',
          '这是一份用户主动发送给你的云文档。',
          '请先调用 chatclaw_document，参数：{"action":"get","accountId":"上述 accountId","agentId":"上述 agent_id","document_id":"上述 document_id"}',
          '拿到 file_path 后直接读取该 .md 文件内容，先总结当前文档核心内容和可继续完善方向。',
          '在用户明确要求改写前，不要直接大幅修改文档内容。',
        ].join('\n');

  const messageType = isEditMode ? 'document_edit_request' : 'document_request';
  const messageContent = JSON.stringify({
    type: messageType,
    document_id: documentId,
    file_name: options.fileName || '',
    file_path: options.filePath || '',
    summary: options.summary || '',
    agent_id: resolvedAgentId,
    task_id: options.taskId || '',
  });

  const savedInboundMsg = await messageDB.createMessage({
    accountId,
    agentId: resolvedAgentId,
    direction: 'inbound',
    contentType: messageType,
    content: messageContent,
  });

  sendToClientByAccountId(accountId, {
    type: 'message',
    id: savedInboundMsg.id,
    agent_id: resolvedAgentId,
    document_id: documentId,
    file_name: options.fileName || '',
    file_path: options.filePath || '',
    summary: options.summary || '',
    direction: 'inbound',
    contentType: messageType,
    content: messageContent,
    read: savedInboundMsg.read,
    timestamp: savedInboundMsg.createdAt,
  });

  const ctx: any = {
    Body: documentText,
    BodyForAgent: documentText,
    RawBody: documentText,
    CommandBody: documentText,
    From: accountId,
    To: resolvedAgentId,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: 'direct' as const,
    Timestamp: Date.now(),
    Provider: CHATCLAW_CHANNEL_ID,
    Surface: CHATCLAW_CHANNEL_ID,
    OriginatingChannel: CHATCLAW_CHANNEL_ID,
    OriginatingTo: accountId,
    SenderName: accountId,
    SenderId: accountId,
    DocumentId: documentId,
    DocumentAgentId: resolvedAgentId,
  };

  const cfg = runtime.config.loadConfig();
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: resolvedAgentId,
  });
  const finalized = runtime.channel.reply.finalizeInboundContext(ctx);

  try {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: finalized,
      updateLastRoute: {
        sessionKey: `agent:${resolvedAgentId}:main`,
        channel,
        to: accountId,
        accountId,
      },
      onRecordError: (err: unknown) =>
        logger.error(`document recordInboundSession: ${String(err)}`),
    });
  } catch (err) {
    logger.error(`document recordInboundSession failed: ${err}`);
  }

  const humanDelay = runtime.channel.reply.resolveHumanDelayConfig(
    cfg,
    resolvedAgentId,
  );
  const deliver = async (payload: OutboundReplyPayload): Promise<void> => {
    const replyText = payload.text ?? '';
    const savedMsg = await messageDB.createMessage({
      accountId,
      agentId: resolvedAgentId,
      direction: 'outbound',
      contentType: 'text',
      content: replyText,
    });
    sendToClientByAccountId(accountId, {
      type: 'message',
      id: savedMsg.id,
      agent_id: resolvedAgentId,
      contentType: 'text',
      content: replyText,
      read: savedMsg.read,
      timestamp: savedMsg.createdAt,
    });
  };

  const { createTypingCallbacks } = await import(
    'openclaw/plugin-sdk/channel-runtime'
  );
  const realTypingCallbacks = createTypingCallbacks({
    start: async () => {
      sendToClientByAccountId(accountId, {
        type: 'typing_start',
        agent_id: resolvedAgentId,
      });
    },
    stop: async () => {
      sendToClientByAccountId(accountId, {
        type: 'typing_stop',
        agent_id: resolvedAgentId,
      });
    },
    onStartError: (err) => logger.error(`document typing start error: ${err}`),
    onStopError: (err) => logger.error(`document typing stop error: ${err}`),
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      humanDelay,
      typingCallbacks: realTypingCallbacks,
      deliver,
      onError: (err: unknown, info: { kind: string }) => {
        logger.error(`Document reply error [${info.kind}]: ${String(err)}`);
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

  return { requestMessageId: savedInboundMsg.id };
}
