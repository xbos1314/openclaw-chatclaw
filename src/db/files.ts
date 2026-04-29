import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

let db: SqlJsDatabase | null = null;

// ============ Types ============

export interface FileRecord {
  id: string;
  fileId: string;       // 文件服务器返回的文件ID
  fileUrl: string;
  coverUrl?: string;
  fileName: string;
  fileSize: number;
  duration?: number;
  contentType: string;
  accountId: string;
  agentId?: string;
  createdAt: number;
}

export interface CreateFileRecordParams {
  fileId: string;
  fileUrl: string;
  coverUrl?: string;
  fileName: string;
  fileSize: number;
  duration?: number;
  contentType: string;
  accountId: string;
  agentId?: string;
}

export interface QueryFilesParams {
  accountId: string;
  agentId?: string;
  contentType?: string;
  page?: number;
  pageSize?: number;
}

export interface QueryResult {
  data: FileRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ============ Database Path ============

const DB_DIR = path.join(process.env.HOME || '/root', '.openclaw', 'openclaw-chatclaw');
const DB_PATH = path.join(DB_DIR, 'files.db');

// ============ Initialize Database ============

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
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      file_url TEXT NOT NULL,
      cover_url TEXT,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      duration INTEGER,
      content_type TEXT NOT NULL,
      account_id TEXT NOT NULL,
      agent_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  try {
    db.run('ALTER TABLE files ADD COLUMN duration INTEGER');
  } catch {
    // 列可能已存在，忽略错误
  }
  try {
    db.run('ALTER TABLE files ADD COLUMN cover_url TEXT');
  } catch {
    // 列可能已存在，忽略错误
  }

  // 创建索引
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_account ON files(account_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_account_type ON files(account_id, content_type, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_account_name ON files(account_id, file_name)`);

  return db;
}

// ============ Save Database ============

function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ============ Helper ============

async function withDb<T>(fn: (database: SqlJsDatabase) => T): Promise<T> {
  const database = await initDb();
  return fn(database);
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function resolveUniqueFileName(database: SqlJsDatabase, accountId: string, fileName: string): string {
  const ext = path.extname(fileName);
  const baseName = ext ? fileName.slice(0, -ext.length) : fileName;
  const escapedBaseName = escapeSqlLike(baseName);
  const likePattern = `${escapedBaseName}\\_%${escapeSqlLike(ext)}`;

  const result = database.exec(
    `
      SELECT file_name FROM files
      WHERE account_id = ?
        AND (file_name = ? OR file_name LIKE ? ESCAPE '\\')
    `,
    [accountId, fileName, likePattern]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return fileName;
  }

  const existingNames = new Set(
    result[0].values
      .map((row) => row[0])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  );

  if (!existingNames.has(fileName)) {
    return fileName;
  }

  let suffix = 2;
  while (existingNames.has(`${baseName}_${suffix}${ext}`)) {
    suffix += 1;
  }

  return `${baseName}_${suffix}${ext}`;
}

export async function resolveAvailableFileName(accountId: string, fileName: string): Promise<string> {
  return withDb((database) => resolveUniqueFileName(database, accountId, fileName));
}

// ============ File Operations ============

/**
 * 创建文件记录
 */
export async function createFileRecord(params: CreateFileRecordParams): Promise<FileRecord> {
  return withDb((database) => {
    const id = randomUUID();
    const now = Date.now();

    database.run(`
      INSERT INTO files (id, file_id, file_url, cover_url, file_name, file_size, duration, content_type, account_id, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      params.fileId,
      params.fileUrl,
      params.coverUrl ?? null,
      params.fileName,
      params.fileSize,
      params.duration ?? null,
      params.contentType,
      params.accountId,
      params.agentId ?? null,
      now,
    ]);

    saveDb();

    return {
      id,
      fileId: params.fileId,
      fileUrl: params.fileUrl,
      coverUrl: params.coverUrl,
      fileName: params.fileName,
      fileSize: params.fileSize,
      duration: params.duration,
      contentType: params.contentType,
      accountId: params.accountId,
      agentId: params.agentId,
      createdAt: now,
    };
  });
}

/**
 * 查询文件列表（带分页）
 */
export async function queryFiles(params: QueryFilesParams): Promise<QueryResult> {
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
    if (params.contentType) {
      conditions.push('content_type = ?');
      values.push(params.contentType);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = database.exec(`SELECT COUNT(*) FROM files WHERE ${whereClause}`, values);
    const total = countResult[0]?.values[0]?.[0] as number ?? 0;

    // Get data with pagination
    const dataResult = database.exec(`
      SELECT * FROM files WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...values, pageSize, offset]);

    const data: FileRecord[] = dataResult.length > 0
      ? dataResult[0].values.map((row) => {
          const columns = dataResult[0].columns;
          const rowMap: Record<string, any> = {};
          columns.forEach((col, i) => {
            rowMap[col] = row[i];
          });
          return {
            id: rowMap.id as string,
            fileId: rowMap.file_id as string,
            fileUrl: rowMap.file_url as string,
            coverUrl: rowMap.cover_url as string | undefined,
            fileName: rowMap.file_name as string,
            fileSize: rowMap.file_size as number,
            duration: rowMap.duration as number | undefined,
            contentType: rowMap.content_type as string,
            accountId: rowMap.account_id as string,
            agentId: rowMap.agent_id as string | undefined,
            createdAt: rowMap.created_at as number,
          };
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
 * 根据文件ID获取文件记录
 */
export async function getFileRecordByFileId(fileId: string): Promise<FileRecord | null> {
  return withDb((database) => {
    const result = database.exec(`
      SELECT * FROM files WHERE file_id = ?
    `, [fileId]);

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const columns = result[0].columns;
    const row = result[0].values[0];
    const rowMap: Record<string, any> = {};
    columns.forEach((col, i) => {
      rowMap[col] = row[i];
    });

    return {
      id: rowMap.id as string,
      fileId: rowMap.file_id as string,
      fileUrl: rowMap.file_url as string,
      coverUrl: rowMap.cover_url as string | undefined,
      fileName: rowMap.file_name as string,
      fileSize: rowMap.file_size as number,
      duration: rowMap.duration as number | undefined,
      contentType: rowMap.content_type as string,
      accountId: rowMap.account_id as string,
      agentId: rowMap.agent_id as string | undefined,
      createdAt: rowMap.created_at as number,
    };
  });
}

/**
 * 根据ID删除文件记录
 */
export async function deleteFileRecord(id: string): Promise<boolean> {
  return withDb((database) => {
    database.exec('DELETE FROM files WHERE id = ?', [id]);
    saveDb();
    return true;
  });
}

/**
 * 根据文件服务器返回的fileId删除文件记录
 */
export async function deleteFileRecordByFileId(fileId: string): Promise<boolean> {
  return withDb((database) => {
    database.exec('DELETE FROM files WHERE file_id = ?', [fileId]);
    saveDb();
    return true;
  });
}

/**
 * 删除账户下的所有文件记录
 */
export async function deleteAllFileRecords(accountId: string, agentId?: string): Promise<string[]> {
  return withDb((database) => {
    // 先查询要删除的文件ID列表
    let query: string;
    let params: string[];
    if (agentId) {
      query = 'SELECT file_id FROM files WHERE account_id = ? AND agent_id = ?';
      params = [accountId, agentId];
    } else {
      query = 'SELECT file_id FROM files WHERE account_id = ?';
      params = [accountId];
    }

    const result = database.exec(query, params);
    const fileIds: string[] = [];
    if (result.length > 0) {
      for (const row of result[0].values) {
        if (row[0]) {
          fileIds.push(row[0] as string);
        }
      }
    }

    // 删除文件记录
    if (agentId) {
      database.exec('DELETE FROM files WHERE account_id = ? AND agent_id = ?', [accountId, agentId]);
    } else {
      database.exec('DELETE FROM files WHERE account_id = ?', [accountId]);
    }
    saveDb();

    return fileIds;
  });
}
