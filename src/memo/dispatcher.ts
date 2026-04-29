import { getChatClawRuntime } from '../runtime.js';
import type { OutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { logger } from '../util/logger.js';
import { clients, sendToClientByAccountId } from '../websocket/server.js';
import * as messageDB from '../db/message.js';
import * as filesDB from '../db/files.js';
import { uploadFileAs } from '../media/upload.js';
import { shouldSkipFilesDbRecord } from '../media/filePolicy.js';
import { buildChatClawDirectSessionKey, CHATCLAW_CHANNEL_ID } from '../session/routing.js';

const CHATCLAW_AGENT_ID = 'nova';

interface DispatchMemoOptions {
  mode?: 'organize' | 'context';
  title?: string;
  summary?: string;
}

/**
 * 通知智能体有新的语音备忘需要处理
 */
export async function dispatchMemoToAgent(
  accountId: string,
  memoId: string,
  agentId: string,
  voiceUrl: string,
  voicePath: string,
  options: DispatchMemoOptions = {},
): Promise<void> {
  const runtime = getChatClawRuntime();
  if (!runtime?.channel) {
    logger.error(`dispatchMemoToAgent: channelRuntime not available`);
    return;
  }

  const log = logger.withAccount(accountId);
  const resolvedAgentId = agentId || CHATCLAW_AGENT_ID;
  const channel = CHATCLAW_CHANNEL_ID;
  const sessionKey = buildChatClawDirectSessionKey(accountId, resolvedAgentId);

  const mode = options.mode || 'organize';
  const isContextMode = mode === 'context';
  const memoText = isContextMode
    ? [
        '[语音备忘上下文请求]',
        `memo_id: ${memoId}`,
        `accountId: ${accountId}`,
        `agent_id: ${resolvedAgentId}`,
        '',
        '这是一条用户主动发送给你的语音备忘录上下文消息。',
        '请先调用 chatclaw_memo，参数：{"action":"get","accountId":"上述 accountId","memo_id":"上述 memo_id"}',
        '读取这条备忘录的 title、summary、content、keywords、original_text、voice_path 等信息。',
        '读取完成后先向用户简洁总结当前备忘录的核心内容、状态和可继续处理的方向。',
        '在用户继续提出明确要求前，不要直接大幅修改备忘录内容。',
        '如果用户后续要求修改或补充，再调用 chatclaw_memo.update 写回。',
      ].join('\n')
    : [
        '[语音备忘整理请求]',
        `memo_id: ${memoId}`,
        `accountId: ${accountId}`,
        `agent_id: ${resolvedAgentId}`,
        '',
        '请按以下流程处理这条语音备忘：',
        '1. 调用 chatclaw_memo，参数：{"action":"get","accountId":"上述 accountId","memo_id":"上述 memo_id"}',
        '2. 读取返回结果中的 voice_path，自己完成语音识别，不要停留在只查询详情',
        '3. 基于识别结果整理出 title、summary、content（Markdown）、keywords',
        '4. 调用 chatclaw_memo，参数：{"action":"update","accountId":"上述 accountId","memo_id":"上述 memo_id",...整理结果...}',
        '',
        '重要要求：',
        '- 必须调用 update 把整理结果写回备忘录',
        '- 不要只在对话里告诉用户“我知道要做什么了”',
        '- 若成功整理，禁止只输出普通聊天回复，优先完成 memo update 写回结果',
        '- 如果识别失败或无法整理，也要给出可执行的失败说明后再结束',
      ].join('\n');
  const messageType = isContextMode ? 'memo_edit_request' : 'memo_request';
  const messageContent = isContextMode
    ? JSON.stringify({
        type: 'memo_edit_request',
        memo_id: memoId,
        title: options.title || '',
        summary: options.summary || '',
        agent_id: resolvedAgentId,
      })
    : memoText;

  // 作为“用户消息”补充写入 messages，保持与普通会话消息一致
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
    memo_id: memoId,
    title: options.title || '',
    summary: options.summary || '',
    direction: 'inbound',
    contentType: messageType,
    content: messageContent,
    read: savedInboundMsg.read,
    timestamp: savedInboundMsg.createdAt,
  });

  const ctx: any = {
    Body: memoText,
    BodyForAgent: memoText,
    RawBody: memoText,
    CommandBody: memoText,
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
    // 附加备忘信息，供智能体识别
    MemoId: memoId,
    MemoVoiceUrl: voiceUrl,
    MemoVoicePath: voicePath,
    MemoAgentId: resolvedAgentId,
  };

  const cfg = runtime.config.loadConfig();
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

  // 创建 deliver 回调
  const deliver = async (payload: OutboundReplyPayload): Promise<void> => {
    const replyText = payload.text ?? '';
    const message: any = {
      type: 'message',
      agent_id: resolvedAgentId,
      timestamp: Date.now(),
    };

    const payloadAny = payload as any;
    if (payloadAny.attachments && payloadAny.attachments.length > 0) {
      const attachment = payloadAny.attachments[0];

      try {
        const finalFileName = await filesDB.resolveAvailableFileName(accountId, attachment.fileName || 'file');
        const uploadResult = await uploadFileAs(attachment.filePath, accountId, finalFileName);
        const fileSize = uploadResult.fileSize ? parseInt(uploadResult.fileSize, 10) : 0;
        const resolvedDuration = uploadResult.duration;

        const savedMsg = await messageDB.createMessage({
          accountId,
          agentId: resolvedAgentId,
          direction: 'outbound',
          contentType: attachment.type || 'file',
          content: replyText || `[${attachment.type || 'file'}: ${uploadResult.fileName}]`,
          fileUrl: uploadResult.fileUrl,
          fileName: uploadResult.fileName,
          fileSize: isNaN(fileSize) ? 0 : fileSize,
          duration: resolvedDuration,
          fileId: uploadResult.id,
        });

        if (uploadResult.id && !shouldSkipFilesDbRecord({
          contentType: attachment.type || 'file',
          fileName: uploadResult.fileName,
          fileUrl: uploadResult.fileUrl,
          mimeType: uploadResult.fileType,
        })) {
          await filesDB.createFileRecord({
            fileId: uploadResult.id,
            fileUrl: uploadResult.fileUrl,
            fileName: uploadResult.fileName,
            fileSize: isNaN(fileSize) ? 0 : fileSize,
            duration: resolvedDuration,
            contentType: attachment.type || 'file',
            accountId,
            agentId: resolvedAgentId,
          });
        }

        message.id = savedMsg.id;
        message.contentType = attachment.type || 'file';
        message.content = replyText || `[${attachment.type || 'file'}: ${uploadResult.fileName}]`;
        message.fileUrl = uploadResult.fileUrl;
        message.fileName = uploadResult.fileName;
        message.fileSize = savedMsg.fileSize;
        message.duration = savedMsg.duration;
        message.read = savedMsg.read;
      } catch (err) {
        logger.error(`Failed to upload file: ${err}`);
        throw new Error(`文件上传失败: ${attachment.fileName}`);
      }
    } else {
      const savedMsg = await messageDB.createMessage({
        accountId,
        agentId: resolvedAgentId,
        direction: 'outbound',
        contentType: 'text',
        content: replyText,
      });

      message.id = savedMsg.id;
      message.contentType = 'text';
      message.content = replyText;
      message.read = savedMsg.read;
    }

    // 推送给客户端
    sendToClientByAccountId(accountId, message);
  };

  // 创建 typing callbacks
  const { createTypingCallbacks } = await import('openclaw/plugin-sdk/channel-runtime');
  const realTypingCallbacks = createTypingCallbacks({
    start: async () => {
      sendToClientByAccountId(accountId, { type: 'typing_start', agent_id: resolvedAgentId });
    },
    stop: async () => {
      sendToClientByAccountId(accountId, { type: 'typing_stop', agent_id: resolvedAgentId });
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
