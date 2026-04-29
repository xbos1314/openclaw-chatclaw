import http from 'node:http';
import path from 'node:path';
import * as memosDB from '../db/memos.js';
import * as voiceStorage from '../media/voiceStorage.js';
import { requireAuth, parseBody, sendJson, getMimeTypeFromFileName } from './server.js';
import type { RequestContext, ParsedUrl } from './server.js';
import { logger } from '../util/logger.js';
import { dispatchMemoToAgent } from '../memo/dispatcher.js';
import { verifyDownloadToken } from '../auth/token.js';

// ============ MIME Types for Voice ============

const VOICE_MIME_TYPES: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.amr': 'audio/amr',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
};

function getVoiceMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return VOICE_MIME_TYPES[ext] || 'audio/ogg';
}

function canAccessMemoAccount(authAccountId: string, memoAccountId: string): boolean {
  return memoAccountId === authAccountId;
}

// ============ Route Handlers ============

/**
 * POST /api/memo/voice - 上传语音并创建备忘
 */
export async function handleMemoVoice(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  ctx: RequestContext
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const authCtx = requireAuth(ctx);
    const baseAccountId = authCtx.accountId;

    // 解析 multipart form data
    const { fileName, fileData, agentId } = await parseMultipartForm(req);

    if (!fileName || !fileData) {
      sendJson(res, 400, { error: 'Missing file data' });
      return;
    }

    // 保存语音文件
    const voiceInfo = await voiceStorage.saveVoiceFile(
      Buffer.from(fileData, 'base64'),
      baseAccountId,
      fileName,
      getVoiceMimeType(fileName)
    );

    // 创建备忘录记录
    const memo = await memosDB.createMemo({
      accountId: baseAccountId,
      agentId: agentId || 'nova',
      voiceUrl: voiceInfo.fileUrl,
      voicePath: voiceInfo.filePath,
    });

    logger.info(`Memo created: ${memo.id}, voice: ${voiceInfo.fileUrl}`);

    // 通知智能体处理新备忘（异步，不阻塞响应）
    dispatchMemoToAgent(
      baseAccountId,
      memo.id,
      memo.agentId,
      voiceInfo.fileUrl,
      voiceInfo.filePath
    ).catch((err) => {
      logger.error(`dispatchMemoToAgent failed: ${err}`);
    });

    sendJson(res, 200, {
      code: 0,
      data: {
        id: memo.id,
        status: memo.status,
        voiceUrl: memo.voiceUrl,
        voicePath: memo.voicePath,
        agentId: memo.agentId,
        createdAt: memo.createdAt,
      },
    });
  } catch (err) {
    logger.error(`handleMemoVoice failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to create memo' });
  }
}

/**
 * GET /api/memo/list - 获取备忘列表
 */
export async function handleMemoList(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const baseAccountId = authCtx.accountId;

  const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(parsedUrl.searchParams.get('page_size') || '20', 10);
  const agentId = parsedUrl.searchParams.get('agent_id') || undefined;

  try {
    const result = await memosDB.queryMemos({
      accountId: baseAccountId,
      agentId,
      page,
      pageSize,
    });

    sendJson(res, 200, {
      code: 0,
      data: {
        memos: result.data.map(formatMemoForClient),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    logger.error(`handleMemoList failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to get memo list' });
  }
}

/**
 * GET /api/memo/{id} - 获取单个备忘详情
 */
export async function handleMemoGet(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext
): Promise<void> {
  const authCtx = requireAuth(ctx);

  const memoId = path.basename(parsedUrl.pathname || '');

  if (!memoId) {
    sendJson(res, 400, { error: 'Missing memo_id' });
    return;
  }

  try {
    const memo = await memosDB.getMemoById(memoId);

    if (!memo) {
      sendJson(res, 404, { error: 'Memo not found' });
      return;
    }

    // 验证归属
    if (!canAccessMemoAccount(authCtx.accountId, memo.accountId)) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    sendJson(res, 200, {
      code: 0,
      data: formatMemoForClient(memo),
    });
  } catch (err) {
    logger.error(`handleMemoGet failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to get memo' });
  }
}

/**
 * POST /api/memo/{id}/send - 将备忘录发送给智能体，作为后续沟通上下文
 */
export async function handleMemoSend(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const baseAccountId = authCtx.accountId;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const memoId = parsedUrl.pathname.split('/')[2] || '';

  if (!memoId) {
    sendJson(res, 400, { error: 'Missing memo_id' });
    return;
  }

  try {
    const memo = await memosDB.getMemoById(memoId);
    if (!memo) {
      sendJson(res, 404, { error: 'Memo not found' });
      return;
    }
    if (!canAccessMemoAccount(authCtx.accountId, memo.accountId)) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    const body = await parseBody<Record<string, any>>(req);
    const agentId = String(body.agent_id || memo.agentId || 'nova').trim();
    if (!agentId) {
      sendJson(res, 400, { error: 'Missing agent_id' });
      return;
    }

    const updatedMemo = await memosDB.updateMemo(memoId, { agentId });
    const resolvedMemo = updatedMemo || memo;

    await dispatchMemoToAgent(
      baseAccountId,
      memoId,
      agentId,
      resolvedMemo.voiceUrl,
      resolvedMemo.voicePath,
      {
        mode: 'context',
        title: resolvedMemo.title,
        summary: resolvedMemo.summary,
      }
    );

    sendJson(res, 200, {
      code: 0,
      data: {
        memo_id: memoId,
        agent_id: agentId,
        status: resolvedMemo.status,
      },
    });
  } catch (err) {
    logger.error(`handleMemoSend failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to send memo' });
  }
}

/**
 * PUT /api/memo/{id} - 更新备忘
 */
export async function handleMemoUpdate(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext
): Promise<void> {
  const authCtx = requireAuth(ctx);

  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const memoId = path.basename(parsedUrl.pathname || '');

  if (!memoId) {
    sendJson(res, 400, { error: 'Missing memo_id' });
    return;
  }

  try {
    const body = await parseBody<Record<string, any>>(req);
    const updates: memosDB.UpdateMemoParams = {};

    if (body.title !== undefined) updates.title = body.title;
    if (body.summary !== undefined) updates.summary = body.summary;
    if (body.content !== undefined) updates.content = body.content;
    if (body.keywords !== undefined) updates.keywords = body.keywords;
    if (body.original_text !== undefined) updates.originalText = body.original_text;
    if (body.status !== undefined) updates.status = body.status;

    const updated = await memosDB.updateMemo(memoId, updates);

    if (!updated) {
      sendJson(res, 404, { error: 'Memo not found' });
      return;
    }

    // 验证归属
    if (!canAccessMemoAccount(authCtx.accountId, updated.accountId)) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    sendJson(res, 200, {
      code: 0,
      data: formatMemoForClient(updated),
    });
  } catch (err) {
    logger.error(`handleMemoUpdate failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to update memo' });
  }
}

/**
 * DELETE /api/memo/{id} - 删除备忘
 */
export async function handleMemoDelete(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext
): Promise<void> {
  const authCtx = requireAuth(ctx);

  if (req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const memoId = path.basename(parsedUrl.pathname || '');

  if (!memoId) {
    sendJson(res, 400, { error: 'Missing memo_id' });
    return;
  }

  try {
    const memo = await memosDB.getMemoById(memoId);

    if (!memo) {
      sendJson(res, 404, { error: 'Memo not found' });
      return;
    }

    // 验证归属
    if (!canAccessMemoAccount(authCtx.accountId, memo.accountId)) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    // 删除语音文件
    if (memo.voicePath) {
      voiceStorage.deleteVoiceFile(path.basename(memo.voicePath), memo.accountId);
    }

    // 删除备忘录记录
    await memosDB.deleteMemo(memoId);

    sendJson(res, 200, {
      code: 0,
      id: memoId,
      deleted: true,
    });
  } catch (err) {
    logger.error(`handleMemoDelete failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to delete memo' });
  }
}

/**
 * GET /voices/download/{accountId}/{voiceId} - 下载语音文件
 */
export async function handleVoiceDownload(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // URL: /voices/download/{accountId}/{voiceId}
  const pathParts = parsedUrl.pathname!.replace('/voices/download/', '').split('/');
  if (pathParts.length < 2) {
    sendJson(res, 400, { error: 'Invalid path' });
    return;
  }

  const accountId = decodeURIComponent(pathParts[0]);
  const voiceId = decodeURIComponent(pathParts.slice(1).join('/'));

  const token = parsedUrl.searchParams.get('token');
  if (!token || !verifyDownloadToken(token, accountId)) {
    sendJson(res, 401, { error: 'Invalid or expired download token' });
    return;
  }

  try {
    const fileBuffer = voiceStorage.readVoiceFile(voiceId, accountId);

    if (!fileBuffer) {
      sendJson(res, 404, { error: 'Voice file not found' });
      return;
    }

    const contentType = voiceStorage.getContentTypeFromVoiceId(voiceId);
    const fileName = voiceStorage.getFileNameFromVoiceId(voiceId);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.writeHead(200);
    res.end(fileBuffer);
  } catch (err) {
    logger.error(`handleVoiceDownload failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to download voice' });
  }
}

// ============ Helpers ============

function formatMemoForClient(memo: memosDB.Memo) {
  return {
    id: memo.id,
    accountId: memo.accountId,
    agentId: memo.agentId,
    title: memo.title,
    summary: memo.summary,
    content: memo.content,
    keywords: JSON.parse(memo.keywords || '[]'),
    voiceUrl: memo.voiceUrl,
    voicePath: memo.voicePath,
    originalText: memo.originalText,
    status: memo.status,
    createdAt: memo.createdAt,
    updatedAt: memo.updatedAt,
  };
}

// ============ Simple Multipart Parser ============

interface ParsedFormData {
  fileName: string;
  fileData: string; // base64 encoded
  agentId: string;
}

async function parseMultipartForm(req: http.IncomingMessage): Promise<ParsedFormData> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const boundary = getBoundary(req.headers['content-type'] || '');

        if (!boundary) {
          // Fallback: treat as JSON body
          const json = JSON.parse(body.toString());
          resolve({
            fileName: json.file_name || 'voice.ogg',
            fileData: json.data || '',
            agentId: json.agent_id || 'nova',
          });
          return;
        }

        // Simple multipart parsing
        const parts = body.toString('binary').split(`--${boundary}`);
        let fileName = 'voice.ogg';
        let fileData = '';
        let agentId = 'nova';

        for (const part of parts) {
          if (part.includes('filename=')) {
            // Extract filename
            const nameMatch = part.match(/filename="([^"]+)"/);
            if (nameMatch) {
              fileName = nameMatch[1];
            }

            // Extract file data (after double CRLF)
            const dataStart = part.indexOf('\r\n\r\n') + 4;
            if (dataStart > 4) {
              const fileContent = part.slice(dataStart, part.lastIndexOf('\r\n'));
              fileData = Buffer.from(fileContent, 'binary').toString('base64');
            }
          }

          // Extract agent_id from form field
          if (part.includes('name="agent_id"')) {
            const valueMatch = part.match(/agent_id"\r\n\r\n([^\r\n]+)/);
            if (valueMatch) {
              agentId = valueMatch[1].trim();
            }
          }
        }

        resolve({ fileName, fileData, agentId });
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

function getBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(.+)/);
  return match ? match[1] : null;
}
