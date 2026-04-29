import http from 'node:http';
import path from 'node:path';
import * as documentsDB from '../db/documents.js';
import * as documentStorage from '../document/storage.js';
import { requireAuth, parseBody, sendJson } from './server.js';
import type { ParsedUrl, RequestContext } from './server.js';
import { logger } from '../util/logger.js';
import { dispatchDocumentToAgent } from '../document/dispatcher.js';

interface CreateDocumentBody {
  agent_id?: string;
  file_name?: string;
  title?: string;
  summary?: string;
}

interface UpdateDocumentBody {
  agent_id?: string;
  file_name?: string;
  summary?: string;
  status?: documentsDB.DocumentStatus;
}

interface SaveDocumentFileBody {
  content?: string;
}

interface SendDocumentBody {
  agent_id?: string;
  mode?: 'context' | 'edit';
  prompt?: string;
  notes?: string;
}

export async function handleDocumentCreate(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  ctx: RequestContext,
): Promise<void> {
  if (req.method != 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const authCtx = requireAuth(ctx);
    const body = await parseBody<CreateDocumentBody>(req);
    const rawFileName = String(body.file_name || body.title || '').trim();
    if (!rawFileName) {
      sendJson(res, 400, { error: 'file_name is required' });
      return;
    }
    const fileRef = documentStorage.createEmptyDocumentFile(
      authCtx.accountId,
      rawFileName,
    );
    const document = await documentsDB.createDocument({
      accountId: authCtx.accountId,
      agentId: String(body.agent_id || 'nova').trim() || 'nova',
      fileName: fileRef.fileName,
      filePath: fileRef.filePath,
      summary: String(body.summary || '').trim(),
      format: 'markdown',
      source: 'user',
      status: 'ready',
    });
    sendJson(res, 200, { code: 0, data: formatDocumentForClient(document) });
  } catch (err) {
    logger.error(`handleDocumentCreate failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to create document' });
  }
}

export async function handleDocumentList(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  try {
    const result = await documentsDB.queryDocuments({
      accountId: authCtx.accountId,
      agentId: parsedUrl.searchParams.get('agent_id') || undefined,
      page: parseInt(parsedUrl.searchParams.get('page') || '1', 10),
      pageSize: parseInt(parsedUrl.searchParams.get('page_size') || '20', 10),
    });
    sendJson(res, 200, {
      code: 0,
      data: {
        documents: result.data.map(formatDocumentForClient),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    logger.error(`handleDocumentList failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to get document list' });
  }
}

export async function handleDocumentGet(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const documentId = path.basename(parsedUrl.pathname || '');
  if (!documentId) {
    sendJson(res, 400, { error: 'Missing document_id' });
    return;
  }

  try {
    const document = await documentsDB.getDocumentById(documentId);
    if (!document) {
      sendJson(res, 404, { error: 'Document not found' });
      return;
    }
    if (document.accountId != authCtx.accountId) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }
    sendJson(res, 200, { code: 0, data: formatDocumentForClient(document) });
  } catch (err) {
    logger.error(`handleDocumentGet failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to get document' });
  }
}

export async function handleDocumentFile(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const documentId = parsedUrl.pathname.split('/')[2] || '';
  if (!documentId) {
    sendJson(res, 400, { error: 'Missing document_id' });
    return;
  }

  try {
    const document = await documentsDB.getDocumentById(documentId);
    if (!document) {
      sendJson(res, 404, { error: 'Document not found' });
      return;
    }
    if (document.accountId !== authCtx.accountId) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    if (req.method === 'GET') {
      sendJson(res, 200, {
        code: 0,
        data: documentStorage.readDocumentTextFile(document.filePath),
      });
      return;
    }

    if (req.method === 'PUT') {
      const body = await parseBody<SaveDocumentFileBody>(req);
      if (typeof body.content !== 'string') {
        sendJson(res, 400, { error: 'content must be a string' });
        return;
      }

      const file = documentStorage.writeDocumentTextFile(
        document.filePath,
        body.content,
      );
      const updated = await documentsDB.updateDocument(documentId, {
        source: 'user',
      });
      sendJson(res, 200, {
        code: 0,
        data: {
          ...file,
          document: formatDocumentForClient(updated || document),
        },
      });
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    logger.error(`handleDocumentFile failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to access document file' });
  }
}

export async function handleDocumentUpdate(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  if (req.method != 'PUT') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const documentId = path.basename(parsedUrl.pathname || '');
  if (!documentId) {
    sendJson(res, 400, { error: 'Missing document_id' });
    return;
  }

  try {
    const document = await documentsDB.getDocumentById(documentId);
    if (!document) {
      sendJson(res, 404, { error: 'Document not found' });
      return;
    }
    if (document.accountId != authCtx.accountId) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    const body = await parseBody<UpdateDocumentBody>(req);
    let fileName: string | undefined;
    let filePath: string | undefined;
    if (body.file_name != null) {
      const renamed = documentStorage.renameDocumentFile(
        authCtx.accountId,
        document.filePath,
        String(body.file_name),
      );
      fileName = renamed.fileName;
      filePath = renamed.filePath;
    }

    const updated = await documentsDB.updateDocument(documentId, {
      agentId: body.agent_id == null ? undefined : String(body.agent_id).trim(),
      fileName,
      filePath,
      summary: body.summary == null ? undefined : String(body.summary),
      status: body.status == null ? undefined : body.status,
      source: 'user',
    });
    sendJson(res, 200, { code: 0, data: formatDocumentForClient(updated!) });
  } catch (err) {
    logger.error(`handleDocumentUpdate failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to update document' });
  }
}

export async function handleDocumentDelete(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  if (req.method != 'DELETE') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const documentId = path.basename(parsedUrl.pathname || '');
  if (!documentId) {
    sendJson(res, 400, { error: 'Missing document_id' });
    return;
  }

  try {
    const document = await documentsDB.getDocumentById(documentId);
    if (!document) {
      sendJson(res, 404, { error: 'Document not found' });
      return;
    }
    if (document.accountId != authCtx.accountId) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }
    documentStorage.deleteDocumentFile(document.filePath);
    await documentsDB.deleteDocument(documentId);
    sendJson(res, 200, { code: 0, data: { document_id: documentId } });
  } catch (err) {
    logger.error(`handleDocumentDelete failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to delete document' });
  }
}

export async function handleDocumentSend(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  if (req.method != 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const documentId = parsedUrl.pathname.split('/')[2] || '';
  if (!documentId) {
    sendJson(res, 400, { error: 'Missing document_id' });
    return;
  }

  try {
    const document = await documentsDB.getDocumentById(documentId);
    if (!document) {
      sendJson(res, 404, { error: 'Document not found' });
      return;
    }
    if (document.accountId != authCtx.accountId) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    const body = await parseBody<SendDocumentBody>(req);
    const agentId = String(body.agent_id || document.agentId || 'nova').trim();
    const mode = String(body.mode || 'context').trim() == 'edit'
        ? 'edit'
        : 'context';

    let task: documentsDB.DocumentTask | null = null;
    if (mode === 'edit') {
      task = await documentsDB.createDocumentTask({
        documentId,
        accountId: authCtx.accountId,
        agentId,
        taskType: 'update',
        status: 'pending',
        prompt: body.prompt?.trim() || '智能体开始修改云文档',
        notes: body.notes?.trim() || '',
      });
    }

    const updatedDocument = await documentsDB.updateDocument(documentId, {
      agentId,
      source: 'user',
    });
    const resolvedDocument = updatedDocument || document;

    const dispatchResult = await dispatchDocumentToAgent(authCtx.accountId, documentId, agentId, {
      mode,
      fileName: resolvedDocument.fileName,
      filePath: resolvedDocument.filePath,
      summary: resolvedDocument.summary,
      taskId: task?.id,
    });
    if (task && dispatchResult.requestMessageId) {
      task = await documentsDB.updateDocumentTask(task.id, {
        requestMessageId: dispatchResult.requestMessageId,
      });
    }

    sendJson(res, 200, {
      code: 0,
      data: {
        document_id: documentId,
        agent_id: agentId,
        status: resolvedDocument.status,
        file_name: resolvedDocument.fileName,
        file_path: resolvedDocument.filePath,
        task_id: task?.id || '',
        request_message_id: task?.requestMessageId || '',
      },
    });
  } catch (err) {
    logger.error(`handleDocumentSend failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to send document' });
  }
}

export async function handleDocumentTasks(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const documentId = parsedUrl.pathname.split('/')[2] || '';
  if (!documentId) {
    sendJson(res, 400, { error: 'Missing document_id' });
    return;
  }

  try {
    const document = await documentsDB.getDocumentById(documentId);
    if (!document) {
      sendJson(res, 404, { error: 'Document not found' });
      return;
    }
    if (document.accountId !== authCtx.accountId) {
      sendJson(res, 403, { error: 'Not authorized' });
      return;
    }

    const items = await documentsDB.queryDocumentTasks(authCtx.accountId, documentId);
    sendJson(res, 200, {
      code: 0,
      data: {
        items: items.map(formatDocumentTaskForClient),
      },
    });
  } catch (err) {
    logger.error(`handleDocumentTasks failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to get document tasks' });
  }
}

function formatDocumentForClient(document: documentsDB.Document) {
  return {
    id: document.id,
    accountId: document.accountId,
    agentId: document.agentId,
    fileName: document.fileName,
    filePath: document.filePath,
    summary: document.summary,
    format: document.format,
    source: document.source,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function formatDocumentTaskForClient(task: documentsDB.DocumentTask) {
  return {
    id: task.id,
    documentId: task.documentId,
    agentId: task.agentId,
    taskType: task.taskType,
    status: task.status,
    prompt: task.prompt,
    notes: task.notes,
    requestMessageId: task.requestMessageId,
    resultMessageId: task.resultMessageId,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
