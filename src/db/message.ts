import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { deleteLocalFile, fileExists } from '../media/fileStorage.js';
import { shouldDeleteLocalFileOnMessageRemoval } from '../media/filePolicy.js';
import { deleteFileRecordByFileId } from './files.js';

const DB_DIR = path.join(os.homedir(), '.openclaw', 'openclaw-chatclaw');
const DB_PATH = path.join(DB_DIR, 'messages.db');

let db: SqlJsDatabase | null = null;

// ============ 辅助函数 ============

/**
 * 从 fileUrl 中提取 fileId 和 accountId
 * fileUrl 新格式: /files/download/accountId/fileId
 * @returns [accountId, fileId] 或 null
 */
function extractIdsFromFileUrl(fileUrl: string): [string, string] | null {
  if (!fileUrl) return null;
  // 匹配 /files/download/accountId/fileId 格式
  const match = fileUrl.match(/\/files\/download\/([^\/]+)\/([^\/?#]+)/i);
  return match ? [match[1], match[2]] : null;
}

async function deleteMessageLocalFileIfNeeded(message: Message | null): Promise<void> {
  if (!message?.fileUrl || !shouldDeleteLocalFileOnMessageRemoval({
    direction: message.direction,
    contentType: message.contentType,
    fileName: message.fileName,
    fileUrl: message.fileUrl,
  })) {
    return;
  }

  const ids = extractIdsFromFileUrl(message.fileUrl);
  if (!ids) {
    return;
  }

  const [accountId, fileId] = ids;
  if (fileExists(fileId, accountId)) {
    deleteLocalFile(fileId, accountId);
  }

  await deleteFileRecordByFileId(fileId);
}

// ============ Types ============

export interface Message {
  id: string;
  accountId: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  contentType: string;
  content: string;
  fileUrl?: string;
  coverUrl?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  requestId?: string;
  fileId?: string;  // 文件服务器返回的文件ID
  status: string;
  read: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMessageParams {
  accountId: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  contentType: string;
  content: string;
  fileUrl?: string;
  coverUrl?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  requestId?: string;
  fileId?: string;  // 文件服务器返回的文件ID
}

export interface QueryMessagesParams {
  accountId: string;
  agentId?: string;
  direction?: 'inbound' | 'outbound';
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
}

export interface QueryFilesParams {
  accountId: string;
  agentId?: string;
  contentType?: string;
  page?: number;
  pageSize?: number;
}

export interface QueryResult {
  data: Message[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UpdateMessageParams {
  content?: string;
  status?: string;
  read?: number;
  fileUrl?: string;
  coverUrl?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
}

// ============ Database Init ============

async function initDb(): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await initSqlJs();

  // Ensure directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content TEXT NOT NULL,
      file_url TEXT,
      cover_url TEXT,
      file_name TEXT,
      file_size INTEGER,
      duration INTEGER,
      request_id TEXT,
      file_id TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 迁移：为已有数据库添加 file_id 列（如果不存在）
  try {
    db.run('ALTER TABLE messages ADD COLUMN file_id TEXT');
  } catch {
    // 列可能已存在，忽略错误
  }
  try {
    db.run('ALTER TABLE messages ADD COLUMN cover_url TEXT');
  } catch {
    // 列可能已存在，忽略错误
  }

  // Create indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_account_agent ON messages(account_id, agent_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_request_id ON messages(request_id)`);

  saveDb();
  return db;
}

function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function withDb<T>(fn: (database: SqlJsDatabase) => T): Promise<T> {
  const database = await initDb();
  return fn(database);
}

// ============ Message Operations ============

export async function createMessage(params: CreateMessageParams): Promise<Message> {
  return withDb((database) => {
    const id = randomUUID();
    const now = Date.now();

    database.run(`
      INSERT INTO messages (id, account_id, agent_id, direction, content_type, content, file_url, cover_url, file_name, file_size, duration, request_id, file_id, status, read, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 0, ?, ?)
    `, [
      id,
      params.accountId,
      params.agentId,
      params.direction,
      params.contentType,
      params.content,
      params.fileUrl ?? null,
      params.coverUrl ?? null,
      params.fileName ?? null,
      params.fileSize ?? null,
      params.duration ?? null,
      params.requestId ?? null,
      params.fileId ?? null,
      now,
      now,
    ]);

    saveDb();

    return {
      id,
      accountId: params.accountId,
      agentId: params.agentId,
      direction: params.direction,
      contentType: params.contentType,
      content: params.content,
      fileUrl: params.fileUrl,
      coverUrl: params.coverUrl,
      fileName: params.fileName,
      fileSize: params.fileSize,
      duration: params.duration,
      requestId: params.requestId,
      fileId: params.fileId,
      status: 'completed',
      read: 0,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function getMessageById(id: string): Promise<Message | null> {
  return withDb((database) => {
    const result = database.exec(`
      SELECT * FROM messages WHERE id = ?
    `, [id]);

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    return rowToMessage(result[0].columns, result[0].values[0].map((v): (string | number | null) => v instanceof Uint8Array ? null : v) as (string | number | null)[]);
  });
}

export async function queryMessages(params: QueryMessagesParams): Promise<QueryResult> {
  return withDb((database) => {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    // Build WHERE clause
    const conditions: string[] = ['account_id = ?'];
    const values: (string | number)[] = [params.accountId];

    if (params.agentId) {
      conditions.push('agent_id = ?');
      values.push(params.agentId);
    }
    if (params.direction) {
      conditions.push('direction = ?');
      values.push(params.direction);
    }
    if (params.startTime) {
      conditions.push('created_at >= ?');
      values.push(params.startTime);
    }
    if (params.endTime) {
      conditions.push('created_at <= ?');
      values.push(params.endTime);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = database.exec(`SELECT COUNT(*) FROM messages WHERE ${whereClause}`, values);
    const total = countResult[0]?.values[0]?.[0] as number ?? 0;

    // Get data with pagination
    const dataResult = database.exec(`
      SELECT * FROM messages WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...values, pageSize, offset]);

    const data: Message[] = dataResult.length > 0
      ? dataResult[0].values.map((row) => {
          const normalized = row.map((v): (string | number | null) => v instanceof Uint8Array ? null : v);
          return rowToMessage(dataResult[0].columns, normalized);
        })
      : [];

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

/**
 * 查询文件列表（带分页）
 * @param params 查询参数
 * @returns 文件消息列表和分页信息
 */
export async function queryFiles(params: QueryFilesParams): Promise<QueryResult> {
  return withDb((database) => {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    // Build WHERE clause - 只查询有 file_url 的消息（文件消息）
    const conditions: string[] = ['account_id = ?', 'file_url IS NOT NULL'];
    const values: (string | number)[] = [params.accountId];

    if (params.agentId) {
      conditions.push('agent_id = ?');
      values.push(params.agentId);
    }
    if (params.contentType) {
      conditions.push('content_type = ?');
      values.push(params.contentType);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = database.exec(`SELECT COUNT(*) FROM messages WHERE ${whereClause}`, values);
    const total = countResult[0]?.values[0]?.[0] as number ?? 0;

    // Get data with pagination
    const dataResult = database.exec(`
      SELECT * FROM messages WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...values, pageSize, offset]);

    const data: Message[] = dataResult.length > 0
      ? dataResult[0].values.map((row) => {
          const normalized = row.map((v): (string | number | null) => v instanceof Uint8Array ? null : v);
          return rowToMessage(dataResult[0].columns, normalized);
        })
      : [];

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function syncMessages(params: {
  accountId: string;
  agentId?: string;
  since?: number;
}): Promise<Message[]> {
  return withDb((database) => {
    const conditions: string[] = ['account_id = ?'];
    const values: (string | number)[] = [params.accountId];

    if (params.agentId) {
      conditions.push('agent_id = ?');
      values.push(params.agentId);
    }
    if (params.since) {
      conditions.push('created_at > ?');
      values.push(params.since);
    }

    const whereClause = conditions.join(' AND ');

    const result = database.exec(`
      SELECT * FROM messages WHERE ${whereClause}
      ORDER BY created_at ASC
    `, values);

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => {
      const normalized = row.map((v): (string | number | null) => v instanceof Uint8Array ? null : v);
      return rowToMessage(result[0].columns, normalized);
    });
  });
}

export async function updateMessage(id: string, updates: UpdateMessageParams): Promise<Message | null> {
  return withDb((database) => {
    const setClause: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [Date.now()];

    if (updates.content !== undefined) {
      setClause.push('content = ?');
      values.push(updates.content);
    }
    if (updates.status !== undefined) {
      setClause.push('status = ?');
      values.push(updates.status);
    }
    if (updates.read !== undefined) {
      setClause.push('read = ?');
      values.push(updates.read);
    }
    if (updates.fileUrl !== undefined) {
      setClause.push('file_url = ?');
      values.push(updates.fileUrl);
    }
    if (updates.coverUrl !== undefined) {
      setClause.push('cover_url = ?');
      values.push(updates.coverUrl);
    }
    if (updates.fileName !== undefined) {
      setClause.push('file_name = ?');
      values.push(updates.fileName);
    }
    if (updates.fileSize !== undefined) {
      setClause.push('file_size = ?');
      values.push(updates.fileSize);
    }
    if (updates.duration !== undefined) {
      setClause.push('duration = ?');
      values.push(updates.duration);
    }

    values.push(id);

    database.run(`UPDATE messages SET ${setClause.join(', ')} WHERE id = ?`, values);
    saveDb();

    return getMessageById(id);
  });
}

export async function deleteMessage(id: string): Promise<boolean> {
  // 先获取消息详情
  const message = await getMessageById(id);
  await deleteMessageLocalFileIfNeeded(message);

  return withDb((database) => {
    database.run('DELETE FROM messages WHERE id = ?', [id]);
    saveDb();
    return true;
  });
}

export async function clearMessages(accountId: string, agentId?: string): Promise<void> {
  // 先查询所有符合条件的消息，删除需要清理的本地文件
  const messages = await queryMessages({ accountId, agentId, page: 1, pageSize: 10000 });
  
  for (const msg of messages.data) {
    await deleteMessageLocalFileIfNeeded(msg);
  }

  return withDb((database) => {
    // 删除消息
    if (agentId) {
      database.exec('DELETE FROM messages WHERE account_id = ? AND agent_id = ?', [accountId, agentId]);
    } else {
      database.exec('DELETE FROM messages WHERE account_id = ?', [accountId]);
    }
    saveDb();
  });
}

export async function markAsRead(id: string): Promise<Message | null> {
  return updateMessage(id, { read: 1 });
}

export async function markAllAsRead(accountId: string, agentId?: string): Promise<number> {
  return withDb((database) => {
    const now = Date.now();
    if (agentId) {
      database.run(
        'UPDATE messages SET read = 1, updated_at = ? WHERE account_id = ? AND agent_id = ? AND read = 0',
        [now, accountId, agentId]
      );
    } else {
      database.run(
        'UPDATE messages SET read = 1, updated_at = ? WHERE account_id = ? AND read = 0',
        [now, accountId]
      );
    }
    saveDb();
    return 0;
  });
}

export async function getUnreadCount(accountId: string, agentId?: string): Promise<number> {
  return withDb((database) => {
    let result;
    if (agentId) {
      result = database.exec(
        'SELECT COUNT(*) as count FROM messages WHERE account_id = ? AND agent_id = ? AND direction = ? AND read = 0',
        [accountId, agentId, 'outbound']
      );
    } else {
      result = database.exec(
        'SELECT COUNT(*) as count FROM messages WHERE account_id = ? AND direction = ? AND read = 0',
        [accountId, 'outbound']
      );
    }

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as number;
    }
    return 0;
  });
}

// ============ Helper ============

function rowToMessage(columns: string[], values: (string | number | null)[]): Message {
  const row: Record<string, string | number | null> = {};
  columns.forEach((col, i) => {
    row[col] = values[i];
  });

  return {
    id: row.id as string,
    accountId: row.account_id as string,
    agentId: row.agent_id as string,
    direction: row.direction as 'inbound' | 'outbound',
    contentType: row.content_type as string,
    content: row.content as string,
    fileUrl: row.file_url as string | undefined,
    coverUrl: row.cover_url as string | undefined,
    fileName: row.file_name as string | undefined,
    fileSize: row.file_size as number | undefined,
    duration: row.duration as number | undefined,
    requestId: row.request_id as string | undefined,
    fileId: row.file_id as string | undefined,
    status: row.status as string,
    read: row.read as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
