import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DB_DIR = path.join(os.homedir(), '.openclaw', 'openclaw-chatclaw');
const DB_PATH = path.join(DB_DIR, 'documents.db');

let db: SqlJsDatabase | null = null;

export type DocumentFormat = 'markdown';
export type DocumentSource = 'user' | 'agent' | 'imported';
export type DocumentStatus = 'ready' | 'processing' | 'failed' | 'archived';
export type DocumentTaskType = 'update' | 'manual_update';
export type DocumentTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Document {
  id: string;
  accountId: string;
  agentId: string;
  fileName: string;
  filePath: string;
  summary: string;
  format: DocumentFormat;
  source: DocumentSource;
  status: DocumentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentTask {
  id: string;
  documentId: string;
  accountId: string;
  agentId: string;
  taskType: DocumentTaskType;
  status: DocumentTaskStatus;
  prompt: string;
  notes: string;
  requestMessageId: string;
  resultMessageId: string;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDocumentParams {
  accountId: string;
  agentId: string;
  fileName: string;
  filePath: string;
  summary?: string;
  format?: DocumentFormat;
  source?: DocumentSource;
  status?: DocumentStatus;
}

export interface UpdateDocumentParams {
  agentId?: string;
  fileName?: string;
  filePath?: string;
  summary?: string;
  format?: DocumentFormat;
  source?: DocumentSource;
  status?: DocumentStatus;
}

export interface QueryDocumentsParams {
  accountId: string;
  agentId?: string;
  page?: number;
  pageSize?: number;
}

export interface QueryResult {
  data: Document[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CreateDocumentTaskParams {
  documentId: string;
  accountId: string;
  agentId: string;
  taskType: DocumentTaskType;
  status?: DocumentTaskStatus;
  prompt: string;
  notes?: string;
  requestMessageId?: string;
}

export interface UpdateDocumentTaskParams {
  taskType?: DocumentTaskType;
  status?: DocumentTaskStatus;
  prompt?: string;
  notes?: string;
  requestMessageId?: string;
  resultMessageId?: string;
  errorMessage?: string;
}

async function initDb(): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await initSqlJs();
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      file_name TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      format TEXT NOT NULL DEFAULT 'markdown',
      source TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS document_tasks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      request_message_id TEXT NOT NULL DEFAULT '',
      result_message_id TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  try {
    db.run(`ALTER TABLE documents ADD COLUMN file_name TEXT NOT NULL DEFAULT ''`);
  } catch {
    // ignore when column already exists
  }
  try {
    db.run(`ALTER TABLE documents ADD COLUMN file_path TEXT NOT NULL DEFAULT ''`);
  } catch {
    // ignore when column already exists
  }

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id, updated_at DESC)`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_documents_agent ON documents(account_id, agent_id, updated_at DESC)`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(account_id, status, updated_at DESC)`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_document_tasks_account ON document_tasks(account_id, created_at DESC)`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_document_tasks_document ON document_tasks(document_id, created_at DESC)`,
  );

  saveDb();
  return db;
}

function saveDb(): void {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

async function withDb<T>(fn: (database: SqlJsDatabase) => T): Promise<T> {
  const database = await initDb();
  return fn(database);
}

export async function createDocument(
  params: CreateDocumentParams,
): Promise<Document> {
  return withDb((database) => {
    const now = Date.now();
    const id = `doc_${randomUUID()}`;
    const fileName = params.fileName.trim();
    const filePath = params.filePath.trim();
    const summary = params.summary?.trim() || '';
    const format = params.format ?? 'markdown';
    const source = params.source ?? 'user';
    const status = params.status ?? 'ready';

    database.run(
      `
      INSERT INTO documents (
        id, account_id, agent_id, file_name, file_path, summary,
        format, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        id,
        params.accountId,
        params.agentId,
        fileName,
        filePath,
        summary,
        format,
        source,
        status,
        now,
        now,
      ],
    );
    saveDb();

    return {
      id,
      accountId: params.accountId,
      agentId: params.agentId,
      fileName,
      filePath,
      summary,
      format,
      source,
      status,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function getDocumentById(id: string): Promise<Document | null> {
  return withDb((database) => {
    const result = database.exec(`SELECT * FROM documents WHERE id = ?`, [id]);
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }
    return rowToDocument(result[0].columns, result[0].values[0]);
  });
}

export async function queryDocuments(
  params: QueryDocumentsParams,
): Promise<QueryResult> {
  return withDb((database) => {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const conditions: string[] = ['account_id = ?'];
    const values: (string | number)[] = [params.accountId];

    if (params.agentId) {
      conditions.push('agent_id = ?');
      values.push(params.agentId);
    }

    const whereClause = conditions.join(' AND ');
    const dataResult = database.exec(
      `
      SELECT * FROM documents WHERE ${whereClause}
    `,
      values,
    );
    const items =
      dataResult.length > 0
          ? dataResult[0].values.map((row) =>
              rowToDocument(dataResult[0].columns, row),
            )
          : [];
    items.sort((a, b) => b.updatedAt - a.updatedAt);

    const total = items.length;
    const offset = (page - 1) * pageSize;
    const data = items.slice(offset, offset + pageSize);

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function updateDocument(
  id: string,
  updates: UpdateDocumentParams,
): Promise<Document | null> {
  return withDb((database) => {
    const setClause: string[] = ['updated_at = ?'];
    const values: (string | number)[] = [Date.now()];

    if (updates.agentId !== undefined) {
      setClause.push('agent_id = ?');
      values.push(updates.agentId);
    }
    if (updates.fileName !== undefined) {
      setClause.push('file_name = ?');
      values.push(updates.fileName);
    }
    if (updates.filePath !== undefined) {
      setClause.push('file_path = ?');
      values.push(updates.filePath);
    }
    if (updates.summary !== undefined) {
      setClause.push('summary = ?');
      values.push(updates.summary);
    }
    if (updates.format !== undefined) {
      setClause.push('format = ?');
      values.push(updates.format);
    }
    if (updates.source !== undefined) {
      setClause.push('source = ?');
      values.push(updates.source);
    }
    if (updates.status !== undefined) {
      setClause.push('status = ?');
      values.push(updates.status);
    }

    values.push(id);
    database.run(
      `UPDATE documents SET ${setClause.join(', ')} WHERE id = ?`,
      values,
    );
    saveDb();
    return getDocumentById(id);
  });
}

export async function deleteDocument(id: string): Promise<boolean> {
  return withDb((database) => {
    database.run(`DELETE FROM document_tasks WHERE document_id = ?`, [id]);
    database.run(`DELETE FROM documents WHERE id = ?`, [id]);
    saveDb();
    return true;
  });
}

export async function createDocumentTask(
  params: CreateDocumentTaskParams,
): Promise<DocumentTask> {
  return withDb((database) => {
    const now = Date.now();
    const id = `dot_${randomUUID()}`;
    database.run(
      `
      INSERT INTO document_tasks (
        id, document_id, account_id, agent_id, task_type, status, prompt, notes,
        request_message_id, result_message_id, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
    `,
      [
        id,
        params.documentId,
        params.accountId,
        params.agentId,
        params.taskType,
        params.status ?? 'pending',
        params.prompt,
        params.notes ?? '',
        params.requestMessageId ?? '',
        now,
        now,
      ],
    );
    saveDb();
    return {
      id,
      documentId: params.documentId,
      accountId: params.accountId,
      agentId: params.agentId,
      taskType: params.taskType,
      status: params.status ?? 'pending',
      prompt: params.prompt,
      notes: params.notes ?? '',
      requestMessageId: params.requestMessageId ?? '',
      resultMessageId: '',
      errorMessage: '',
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function updateDocumentTask(
  taskId: string,
  updates: UpdateDocumentTaskParams,
): Promise<DocumentTask | null> {
  return withDb((database) => {
    const setClause: string[] = ['updated_at = ?'];
    const values: Array<string | number> = [Date.now()];

    if (updates.taskType !== undefined) {
      setClause.push('task_type = ?');
      values.push(updates.taskType);
    }
    if (updates.status !== undefined) {
      setClause.push('status = ?');
      values.push(updates.status);
    }
    if (updates.prompt !== undefined) {
      setClause.push('prompt = ?');
      values.push(updates.prompt);
    }
    if (updates.notes !== undefined) {
      setClause.push('notes = ?');
      values.push(updates.notes);
    }
    if (updates.requestMessageId !== undefined) {
      setClause.push('request_message_id = ?');
      values.push(updates.requestMessageId);
    }
    if (updates.resultMessageId !== undefined) {
      setClause.push('result_message_id = ?');
      values.push(updates.resultMessageId);
    }
    if (updates.errorMessage !== undefined) {
      setClause.push('error_message = ?');
      values.push(updates.errorMessage);
    }

    values.push(taskId);
    database.run(
      `UPDATE document_tasks SET ${setClause.join(', ')} WHERE id = ?`,
      values,
    );
    saveDb();
    return getDocumentTaskById(taskId);
  });
}

export async function getDocumentTaskById(
  taskId: string,
): Promise<DocumentTask | null> {
  return withDb((database) => {
    const result = database.exec(`SELECT * FROM document_tasks WHERE id = ?`, [
      taskId,
    ]);
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }
    return rowToDocumentTask(result[0].columns, result[0].values[0]);
  });
}

export async function queryDocumentTasks(
  accountId: string,
  documentId: string,
): Promise<DocumentTask[]> {
  return withDb((database) => {
    const result = database.exec(
      `
      SELECT * FROM document_tasks
      WHERE account_id = ? AND document_id = ?
      ORDER BY created_at DESC
    `,
      [accountId, documentId],
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) =>
      rowToDocumentTask(result[0].columns, row),
    );
  });
}

function rowToDocument(columns: string[], row: unknown[]): Document {
  const map = Object.fromEntries(
    columns.map((column, index) => [column, row[index]]),
  );
  const filePath = String(map.file_path ?? '');
  return {
    id: String(map.id),
    accountId: String(map.account_id),
    agentId: String(map.agent_id),
    fileName: String(map.file_name ?? ''),
    filePath,
    summary: String(map.summary ?? ''),
    format: String(map.format ?? 'markdown') as DocumentFormat,
    source: String(map.source ?? 'user') as DocumentSource,
    status: String(map.status ?? 'ready') as DocumentStatus,
    createdAt: Number(map.created_at ?? 0),
    updatedAt: Number(map.updated_at ?? 0),
  };
}

function rowToDocumentTask(columns: string[], row: unknown[]): DocumentTask {
  const map = Object.fromEntries(
    columns.map((column, index) => [column, row[index]]),
  );
  return {
    id: String(map.id),
    documentId: String(map.document_id),
    accountId: String(map.account_id),
    agentId: String(map.agent_id),
    taskType: String(map.task_type) as DocumentTaskType,
    status: String(map.status) as DocumentTaskStatus,
    prompt: String(map.prompt ?? ''),
    notes: String(map.notes ?? ''),
    requestMessageId: String(map.request_message_id ?? ''),
    resultMessageId: String(map.result_message_id ?? ''),
    errorMessage: String(map.error_message ?? ''),
    createdAt: Number(map.created_at ?? 0),
    updatedAt: Number(map.updated_at ?? 0),
  };
}

