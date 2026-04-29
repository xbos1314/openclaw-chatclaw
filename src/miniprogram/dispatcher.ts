import { getChatClawRuntime } from '../runtime.js';
import type { OutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { logger } from '../util/logger.js';
import { sendToClientByAccountId } from '../websocket/server.js';
import * as messageDB from '../db/message.js';
import { buildChatClawDirectSessionKey, CHATCLAW_CHANNEL_ID } from '../session/routing.js';

const CHATCLAW_AGENT_ID = 'nova';

interface CreatePayload {
  name: string;
  prompt: string;
  notes: string;
  taskId: string;
}

interface EditPayload {
  prompt: string;
  notes: string;
  taskId: string;
}

interface ContextPayload {
  title: string;
  summary: string;
}

export async function dispatchMiniprogramCreateToAgent(
  accountId: string,
  agentId: string,
  payload: CreatePayload,
): Promise<void> {
  const text = [
    '[小程序创建请求]',
    `task_id: ${payload.taskId}`,
    `accountId: ${accountId}`,
    `agent_id: ${agentId || CHATCLAW_AGENT_ID}`,
    `name: ${payload.name || '(auto-generate)'}`,
    `prompt: ${payload.prompt}`,
    `notes: ${payload.notes || '(none)'}`,
    '',
    '请先调用 chatclaw_miniprogram.create 创建项目并获取 project_dir。',
    `create 时必须原样传入 task_id=${payload.taskId}。`,
    '之后只能在返回的项目目录内创建和修改文件。',
    '创建成功后，不要立刻凭空修改；必须先查看并遍历当前项目代码和目录结构，至少检查 README.md、docs/、app/、server/、data/ 的现状，再开始实现。',
    '创建完成后要完善 README.md、docs/、app/、server/，保证浏览器能直接访问。',
    '前端功能和页面修改必须优先改 app/ 源码目录；后端接口修改必须优先改 server/。',
    '项目后端必须直接在 server/index.js 导出 handle(req, ctx)，按 req.path 子路径处理请求，例如 /qrcode/generate；禁止创建 express app、router 或 app.listen()，也禁止在 server/ 中写 /api/miniprogram/{appId}/... 全路径路由。',
    'dist/ 是构建产物目录，默认禁止直接编辑；如修改了 app/ 或构建配置，必须重新 build 生成 dist/。',
    '前端调用项目后端时，必须走 /api/miniprogram/{appId}/... 前缀，或使用 baseApi + 子路径；禁止直接写 /api/... 裸路径。',
    '在创建完成后、build 前，必须调用 chatclaw_miniprogram.validate_project 检查项目前后端是否符合规范。',
    '禁止自行运行 npm install、npm run build、vite build 等本地构建命令；如需构建，必须调用 chatclaw_miniprogram.build。',
    `完成后调用 chatclaw_miniprogram.update 和 chatclaw_miniprogram.set_ready，并继续传入 task_id=${payload.taskId}。`,
    `若失败必须调用 chatclaw_miniprogram.set_failed，并继续传入 task_id=${payload.taskId}。`,
  ].join('\n');
  await dispatchToAgent(accountId, agentId, text, { task_id: payload.taskId });
}

export async function dispatchMiniprogramEditToAgent(
  accountId: string,
  appId: string,
  agentId: string,
  payload: EditPayload,
): Promise<void> {
  const text = [
    '[小程序继续完善请求]',
    `task_id: ${payload.taskId}`,
    `app_id: ${appId}`,
    `accountId: ${accountId}`,
    `agent_id: ${agentId || CHATCLAW_AGENT_ID}`,
    `prompt: ${payload.prompt}`,
    `notes: ${payload.notes || '(none)'}`,
    '',
    '请先调用 chatclaw_miniprogram.get 获取项目目录和现有信息。',
    '在开始修改前，必须先查看并遍历当前项目代码和目录结构，至少检查 README.md、docs/、app/、server/、data/ 的现状。',
    '之后只能在该项目目录内继续修改文件。',
    '前端功能和页面修改必须优先改 app/ 源码目录；后端接口修改必须优先改 server/。',
    '项目后端必须直接在 server/index.js 导出 handle(req, ctx)，按 req.path 子路径处理请求，例如 /qrcode/generate；禁止创建 express app、router 或 app.listen()，也禁止在 server/ 中写 /api/miniprogram/{appId}/... 全路径路由。',
    'dist/ 是构建产物目录，默认禁止直接编辑；如修改了 app/ 或构建配置，必须重新 build 生成 dist/。',
    '前端调用项目后端时，必须走 /api/miniprogram/{appId}/... 前缀，或使用 baseApi + 子路径；禁止直接写 /api/... 裸路径。',
    '修改完成后、build 前，必须调用 chatclaw_miniprogram.validate_project 检查项目前后端是否符合规范。',
    '禁止自行运行 npm install、npm run build、vite build 等本地构建命令；如需构建，必须调用 chatclaw_miniprogram.build。',
    `完成后调用 chatclaw_miniprogram.update 和 chatclaw_miniprogram.set_ready，并继续传入 task_id=${payload.taskId}。`,
    `若失败必须调用 chatclaw_miniprogram.set_failed，并继续传入 task_id=${payload.taskId}。`,
  ].join('\n');
  await dispatchToAgent(accountId, agentId, text, { app_id: appId, task_id: payload.taskId });
}

export async function dispatchMiniprogramContextToAgent(
  accountId: string,
  appId: string,
  agentId: string,
  payload: ContextPayload,
): Promise<void> {
  const text = [
    '[小程序上下文请求]',
    `app_id: ${appId}`,
    `accountId: ${accountId}`,
    `agent_id: ${agentId || CHATCLAW_AGENT_ID}`,
    `title: ${payload.title || '(untitled)'}`,
    `summary: ${payload.summary || '(none)'}`,
    '',
    '这是一条用户主动发送给你的小程序上下文消息。',
    '请先调用 chatclaw_miniprogram.get 获取该项目的当前信息、README、docs、目录和访问方式。',
    '注意：前端源码目录是 app/，后端源码目录是 server/，dist/ 仅为构建产物目录。',
    '注意：前端访问项目后端时，应统一走 /api/miniprogram/{appId}/... 前缀。',
    '注意：项目后端只应在 server/index.js 中实现 handle(req, ctx)，并匹配 req.path 子路径，不应创建独立 Express 服务。',
    '读取完成后先向用户总结当前项目状态、已有能力和可继续完善的方向。',
    '在用户继续提出明确修改要求前，不要直接调用 update、set_ready 或 set_failed，也不要创建新的任务记录。',
    '当用户后续给出明确修改要求后，再按需调用相关工具执行修改。',
  ].join('\n');
  await dispatchToAgent(accountId, agentId, text, { app_id: appId });
}

async function dispatchToAgent(
  accountId: string,
  agentId: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const runtime = getChatClawRuntime();
  if (!runtime?.channel) {
    logger.error('dispatchToAgent: channelRuntime not available');
    return;
  }
  const resolvedAgentId = agentId || CHATCLAW_AGENT_ID;
  const channel = CHATCLAW_CHANNEL_ID;
  const sessionKey = buildChatClawDirectSessionKey(accountId, resolvedAgentId);

  const ctx: any = {
    Body: content,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
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
    TaskId: extra['task_id'],
    ...extra,
  };

  const cfg = runtime.config.loadConfig();
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: resolvedAgentId });
  const finalized = runtime.channel.reply.finalizeInboundContext(ctx);
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
    onRecordError: (err: unknown) => logger.error(`recordInboundSession: ${String(err)}`),
  }).catch((err) => logger.error(`recordInboundSession failed: ${err}`));

  const humanDelay = runtime.channel.reply.resolveHumanDelayConfig(cfg, resolvedAgentId);
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
      timestamp: savedMsg.createdAt,
      read: savedMsg.read,
    });
  };
  const { createTypingCallbacks } = await import('openclaw/plugin-sdk/channel-runtime');
  const realTypingCallbacks = createTypingCallbacks({
    start: async () => sendToClientByAccountId(accountId, { type: 'typing_start', agent_id: resolvedAgentId }),
    stop: async () => sendToClientByAccountId(accountId, { type: 'typing_stop', agent_id: resolvedAgentId }),
    onStartError: (err) => logger.error(`typing start error: ${String(err)}`),
    onStopError: (err) => logger.error(`typing stop error: ${String(err)}`),
  });
  const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
    humanDelay,
    typingCallbacks: realTypingCallbacks,
    deliver,
    onError: (err: unknown, info: { kind: string }) => {
      logger.error(`Reply error [${info.kind}]: ${String(err)}`);
    },
  });
  try {
    await runtime.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => markDispatchIdle(),
      run: () => runtime.channel.reply.dispatchReplyFromConfig({
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
