import { Type } from '@sinclair/typebox';
import * as documentsDB from '../db/documents.js';
import * as documentStorage from './storage.js';
import { logger } from '../util/logger.js';
import { sendToClientByAccountId } from '../websocket/server.js';
import * as messageDB from '../db/message.js';

interface DocumentToolParams {
  action: 'create' | 'get' | 'list' | 'update' | 'create_task' | 'update_task';
  accountId?: string;
  agentId?: string;
  document_id?: string;
  task_id?: string;
  file_name?: string;
  summary?: string;
  page?: number;
  page_size?: number;
  task_type?: 'update' | 'manual_update';
  task_status?: 'pending' | 'running' | 'completed' | 'failed';
  prompt?: string;
  notes?: string;
  error?: string;
  result_message_id?: string;
  request_message_id?: string;
}

const ChatClawDocumentSchema = Type.Object({
  action: Type.Union([
    Type.Literal('create'),
    Type.Literal('get'),
    Type.Literal('list'),
    Type.Literal('update'),
    Type.Literal('create_task'),
    Type.Literal('update_task'),
  ]),
  accountId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  document_id: Type.Optional(Type.String()),
  task_id: Type.Optional(Type.String()),
  file_name: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  page: Type.Optional(Type.Number()),
  page_size: Type.Optional(Type.Number()),
  task_type: Type.Optional(Type.Union([
    Type.Literal('update'),
    Type.Literal('manual_update'),
  ])),
  task_status: Type.Optional(Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ])),
  prompt: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  result_message_id: Type.Optional(Type.String()),
  request_message_id: Type.Optional(Type.String()),
});

export function registerChatClawDocumentTools(api: any): void {
  api.registerTool({
    name: 'chatclaw_document',
    description:
      'ChatClaw 云文档工具：创建、获取、列出文档元数据，并维护文档修改任务日志。',
    parameters: ChatClawDocumentSchema,
    execute: async (_toolCallId: string, params: DocumentToolParams) => {
      try {
        switch (params.action) {
          case 'create':
            return await handleCreate(params);
          case 'get':
            return await handleGet(params);
          case 'list':
            return await handleList(params);
          case 'update':
            return await handleUpdate(params);
          case 'create_task':
            return await handleCreateTask(params);
          case 'update_task':
            return await handleUpdateTask(params);
          default:
            return { ok: false, error: `Unknown action: ${params.action}` };
        }
      } catch (err: any) {
        logger.error(`chatclaw_document[${params.action}] failed: ${err}`);
        return { ok: false, error: err.message };
      }
    },
  });
}

async function handleCreate(params: DocumentToolParams): Promise<any> {
  const account = getAccountContextFromParams(params);
  if (!account) {
    return { ok: false, error: 'accountId is required' };
  }
  if (!params.file_name?.trim()) {
    return { ok: false, error: 'file_name is required' };
  }

  const fileRef = documentStorage.createEmptyDocumentFile(
    account.accountId,
    params.file_name,
  );

  try {
    const document = await documentsDB.createDocument({
      accountId: account.accountId,
      agentId: account.agentId,
      fileName: fileRef.fileName,
      filePath: fileRef.filePath,
      summary: params.summary,
      format: 'markdown',
      source: 'agent',
      status: 'ready',
    });

    pushDocumentToClient(account.accountId, document);
    return { ok: true, document: formatDocument(document) };
  } catch (error) {
    documentStorage.deleteDocumentFile(fileRef.filePath);
    throw error;
  }
}

async function handleGet(params: DocumentToolParams): Promise<any> {
  const account = getAccountContextFromParams(params);
  if (!account) {
    return { ok: false, error: 'accountId is required' };
  }
  if (!params.document_id) {
    return { ok: false, error: 'document_id is required' };
  }

  const document = await documentsDB.getDocumentById(params.document_id);
  if (!document) {
    return { ok: false, error: `Document not found: ${params.document_id}` };
  }
  if (document.accountId != account.accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  return { ok: true, document: formatDocument(document) };
}

async function handleUpdate(params: DocumentToolParams): Promise<any> {
  const account = getAccountContextFromParams(params);
  if (!account) {
    return { ok: false, error: 'accountId is required' };
  }
  if (!params.document_id) {
    return { ok: false, error: 'document_id is required' };
  }
  if (params.summary === undefined) {
    return { ok: false, error: 'summary is required' };
  }

  const document = await documentsDB.getDocumentById(params.document_id);
  if (!document) {
    return { ok: false, error: `Document not found: ${params.document_id}` };
  }
  if (document.accountId != account.accountId) {
    return { ok: false, error: 'Not authorized' };
  }

  const updated = await documentsDB.updateDocument(params.document_id, {
    summary: params.summary,
  });
  return { ok: true, document: updated ? formatDocument(updated) : null };
}

async function handleList(params: DocumentToolParams): Promise<any> {
  const account = getAccountContextFromParams(params);
  if (!account) {
    return { ok: false, error: 'accountId is required' };
  }

  const result = await documentsDB.queryDocuments({
    accountId: account.accountId,
    agentId: account.agentId,
    page: params.page || 1,
    pageSize: params.page_size || 20,
  });
  return {
    ok: true,
    page: result.page,
    page_size: result.pageSize,
    total: result.total,
    total_pages: result.totalPages,
    data: result.data.map((item) => formatDocument(item)),
  };
}

async function handleCreateTask(params: DocumentToolParams): Promise<any> {
  const account = getAccountContextFromParams(params);
  if (!account) {
    return { ok: false, error: 'accountId is required' };
  }
  if (!params.document_id) {
    return { ok: false, error: 'document_id is required' };
  }

  const document = await documentsDB.getDocumentById(params.document_id);
  if (!document) {
    return { ok: false, error: `Document not found: ${params.document_id}` };
  }
  if (document.accountId !== account.accountId) {
    return { ok: false, error: 'Not authorized' };
  }

  const task = await documentsDB.createDocumentTask({
    documentId: document.id,
    accountId: account.accountId,
    agentId: account.agentId,
    taskType: params.task_type || 'manual_update',
    status: params.task_status || 'running',
    prompt: params.prompt || '智能体开始修改云文档',
    notes: params.notes || '',
    requestMessageId: params.request_message_id || '',
  });
  return { ok: true, task: formatTask(task) };
}

async function handleUpdateTask(params: DocumentToolParams): Promise<any> {
  const account = getAccountContextFromParams(params);
  if (!account) {
    return { ok: false, error: 'accountId is required' };
  }
  if (!params.task_id) {
    return { ok: false, error: 'task_id is required' };
  }

  const task = await documentsDB.getDocumentTaskById(params.task_id);
  if (!task) {
    return { ok: false, error: `Task not found: ${params.task_id}` };
  }
  if (task.accountId !== account.accountId) {
    return { ok: false, error: 'Not authorized' };
  }

  const updated = await documentsDB.updateDocumentTask(params.task_id, {
    taskType: params.task_type,
    status: params.task_status,
    prompt: params.prompt,
    notes: params.notes,
    requestMessageId: params.request_message_id,
    resultMessageId: params.result_message_id,
    errorMessage: params.error,
  });

  // When task completes or fails, update the document's updatedAt
  if (params.task_status === 'completed' || params.task_status === 'failed') {
    const updatedDoc = await documentsDB.updateDocument(task.documentId, {});
    if (updatedDoc) {
      const content = params.task_status === 'completed'
          ? (params.notes || '')
          : (params.error || '');
      pushDocumentToClient(account.accountId, updatedDoc, content);
    }
  }
  return { ok: true, task: updated ? formatTask(updated) : null };
}

function pushDocumentToClient(
  accountId: string,
  document: documentsDB.Document,
  content: string = '',
): void {
  const documentPayload = {
    document_id: document.id,
    file_name: document.fileName,
    file_path: document.filePath,
    summary: document.summary,
    format: document.format,
    status: document.status,
    content,
  };

  sendToClientByAccountId(accountId, {
    type: 'document',
    data: formatDocument(document),
  });

  void messageDB
      .createMessage({
        accountId,
        agentId: document.agentId,
        direction: 'outbound',
        contentType: 'document_result',
        content: JSON.stringify(documentPayload),
      })
      .then((savedMsg) => {
        sendToClientByAccountId(accountId, {
          type: 'message',
          id: savedMsg.id,
          agent_id: document.agentId,
          direction: 'outbound',
          contentType: 'document_result',
          content: savedMsg.content,
          document_id: document.id,
          file_name: document.fileName,
          file_path: document.filePath,
          summary: document.summary,
          document_content: content,
          timestamp: savedMsg.createdAt,
          read: savedMsg.read,
        });
      })
      .catch((err) => {
        logger.error(`Failed to push document result message: ${err}`);
      });
}

function getAccountContextFromParams(
  params: DocumentToolParams,
): { accountId: string; agentId: string } | null {
  if (!params.accountId) {
    return null;
  }
  const rawAccountId = params.accountId.trim();
  const agentId = params.agentId?.trim();
  if (!rawAccountId.startsWith('chatclaw_')) {
    throw new Error('Invalid accountId format. Must start with chatclaw_.');
  }
  if (!agentId) {
    throw new Error('agentId is required.');
  }
  return {
    accountId: rawAccountId,
    agentId,
  };
}

function formatDocument(document: documentsDB.Document) {
  return {
    id: document.id,
    account_id: document.accountId,
    agent_id: document.agentId,
    file_name: document.fileName,
    file_path: document.filePath,
    summary: document.summary,
    format: document.format,
    source: document.source,
    status: document.status,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  };
}

function formatTask(task: documentsDB.DocumentTask) {
  return {
    id: task.id,
    document_id: task.documentId,
    account_id: task.accountId,
    agent_id: task.agentId,
    task_type: task.taskType,
    status: task.status,
    prompt: task.prompt,
    notes: task.notes,
    request_message_id: task.requestMessageId,
    result_message_id: task.resultMessageId,
    error_message: task.errorMessage,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}
