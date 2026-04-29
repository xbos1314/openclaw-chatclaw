import { Type } from "@sinclair/typebox";
import * as memosDB from '../db/memos.js';
import { logger } from '../util/logger.js';
import { sendToClientByAccountId } from '../websocket/server.js';
import * as messageDB from '../db/message.js';

// ============ Types ============

interface MemoToolParams {
  action: "get" | "update" | "list";
  /** 当前会话的账号ID */
  accountId?: string;
  /** 备忘录ID */
  memo_id?: string;
  /** 标题 */
  title?: string;
  /** 摘要 */
  summary?: string;
  /** 正文（Markdown） */
  content?: string;
  /** 关键词 */
  keywords?: string[];
  /** 页码 */
  page?: number;
  /** 每页数量 */
  page_size?: number;
}

// ============ Schema ============

const ChatClawMemoSchema = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("update"),
    Type.Literal("list"),
  ]),
  /** 当前会话的账号ID */
  accountId: Type.Optional(Type.String()),
  /** 备忘录ID */
  memo_id: Type.Optional(Type.String()),
  /** 标题 */
  title: Type.Optional(Type.String()),
  /** 摘要 */
  summary: Type.Optional(Type.String()),
  /** 正文（Markdown） */
  content: Type.Optional(Type.String()),
  /** 关键词 */
  keywords: Type.Optional(Type.Array(Type.String())),
  /** 页码 */
  page: Type.Optional(Type.Number()),
  /** 每页数量 */
  page_size: Type.Optional(Type.Number()),
});

// ============ Tool Registration ============

export function registerChatClawMemoTools(api: any): void {
  api.registerTool({
    name: "chatclaw_memo",
    description: "ChatClaw 语音备忘工具：获取、更新、列出备忘录",
    parameters: ChatClawMemoSchema,
    execute: async (toolCallId: string, params: MemoToolParams) => {
      try {
        switch (params.action) {
          case "get":
            return await handleGet(params);
          case "update":
            return await handleUpdate(params);
          case "list":
            return await handleList(params);
          default:
            return { error: `Unknown action: ${params.action}` };
        }
      } catch (err: any) {
        logger.error(`chatclaw_memo[${params.action}] failed: ${err}`);
        return { error: err.message };
      }
    },
  });
}

// ============ Handlers ============

async function handleGet(params: MemoToolParams): Promise<any> {
  const accountId = getAccountIdFromParams(params);
  const memoId = params.memo_id;

  if (!memoId) {
    return { error: "memo_id is required" };
  }

  if (!accountId) {
    return { error: "accountId is required" };
  }

  const memo = await memosDB.getMemoById(memoId);

  if (!memo) {
    return { error: `Memo not found: ${memoId}` };
  }

  // 验证归属
  if (memo.accountId !== accountId) {
    return { error: "Not authorized" };
  }

  return {
    id: memo.id,
    account_id: memo.accountId,
    agent_id: memo.agentId,
    title: memo.title,
    summary: memo.summary,
    content: memo.content,
    keywords: JSON.parse(memo.keywords || '[]'),
    voice_url: memo.voiceUrl,
    voice_path: memo.voicePath,
    original_text: memo.originalText,
    status: memo.status,
    created_at: memo.createdAt,
    updated_at: memo.updatedAt,
  };
}

async function handleUpdate(params: MemoToolParams): Promise<any> {
  const accountId = getAccountIdFromParams(params);
  const memoId = params.memo_id;

  if (!memoId) {
    return { error: "memo_id is required" };
  }

  if (!accountId) {
    return { error: "accountId is required" };
  }

  const memo = await memosDB.getMemoById(memoId);

  if (!memo) {
    return { error: `Memo not found: ${memoId}` };
  }

  // 验证归属
  if (memo.accountId !== accountId) {
    return { error: "Not authorized" };
  }

  // 构建更新参数
  const updates: memosDB.UpdateMemoParams = {
    status: 'completed',
  };

  if (params.title !== undefined) updates.title = params.title;
  if (params.summary !== undefined) updates.summary = params.summary;
  if (params.content !== undefined) updates.content = params.content;
  if (params.keywords !== undefined) updates.keywords = params.keywords;

  const updated = await memosDB.updateMemo(memoId, updates);

  if (!updated) {
    return { error: "Failed to update memo" };
  }

  // 推送整理结果给用户
  pushMemoToClient(accountId, updated);

  return {
    ok: true,
    id: updated.id,
    updated: true,
  };
}

async function handleList(params: MemoToolParams): Promise<any> {
  const accountId = getAccountIdFromParams(params);

  if (!accountId) {
    return { error: "accountId is required" };
  }

  const page = params.page || 1;
  const pageSize = params.page_size || 20;

  const result = await memosDB.queryMemos({
    accountId,
    page,
    pageSize,
  });

  return {
    data: result.data.map(formatMemo),
    total: result.total,
    page: result.page,
    page_size: result.pageSize,
    total_pages: result.totalPages,
  };
}

// ============ Push to Client ============

function pushMemoToClient(accountId: string, memo: memosDB.Memo): void {
  const memoPayload = {
    memo_id: memo.id,
    title: memo.title,
    summary: memo.summary,
    content: memo.content,
  };

  sendToClientByAccountId(accountId, {
    type: "memo",
    data: {
      id: memo.id,
      agent_id: memo.agentId,
      title: memo.title,
      summary: memo.summary,
      content: memo.content,
      keywords: JSON.parse(memo.keywords || '[]'),
      voiceUrl: memo.voiceUrl,
      originalText: memo.originalText,
      createdAt: memo.createdAt,
      isMemo: true,
    },
  });

  void messageDB.createMessage({
    accountId,
    agentId: memo.agentId,
    direction: 'outbound',
    contentType: 'memo_result',
    content: JSON.stringify(memoPayload),
  }).then((savedMsg) => {
    sendToClientByAccountId(accountId, {
      type: "message",
      id: savedMsg.id,
      agent_id: memo.agentId,
      direction: 'outbound',
      contentType: 'memo_result',
      content: savedMsg.content,
      memo_id: memo.id,
      title: memo.title,
      summary: memo.summary,
      timestamp: savedMsg.createdAt,
      read: savedMsg.read,
    });
  }).catch((err) => {
    logger.error(`Failed to push memo result message: ${err}`);
  });

  logger.info(`Memo pushed to client: ${memo.id}`);
}

// ============ Helpers ============

function getAccountIdFromParams(params: MemoToolParams): string | null {
  if (!params.accountId) {
    return null;
  }
  return params.accountId.trim() || null;
}

function formatMemo(memo: memosDB.Memo) {
  return {
    id: memo.id,
    agent_id: memo.agentId,
    title: memo.title,
    summary: memo.summary,
    keywords: JSON.parse(memo.keywords || '[]'),
    voice_url: memo.voiceUrl,
    status: memo.status,
    created_at: memo.createdAt,
  };
}
