import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DB_DIR = path.join(os.homedir(), '.openclaw', 'openclaw-chatclaw');
const DB_PATH = path.join(DB_DIR, 'memos.db');

let db: SqlJsDatabase | null = null;

// ============ Types ============

export interface Memo {
  id: string;
  accountId: string;
  agentId: string;
  title: string;
  summary: string;
  content: string;
  keywords: string;      // JSON array string
  voiceUrl: string;
  voicePath: string;
  originalText: string;
  status: 'processing' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

export interface CreateMemoParams {
  accountId: string;
  agentId: string;
  voiceUrl: string;
  voicePath: string;
}

export interface UpdateMemoParams {
  agentId?: string;
  title?: string;
  summary?: string;
  content?: string;
  keywords?: string[];
  originalText?: string;
  status?: 'processing' | 'completed' | 'failed';
}

export interface QueryMemosParams {
  accountId: string;
  agentId?: string;
  page?: number;
  pageSize?: number;
}

export interface QueryResult {
  data: Memo[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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
    CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT DEFAULT '',
      content TEXT DEFAULT '',
      keywords TEXT DEFAULT '[]',
      voice_url TEXT DEFAULT '',
      voice_path TEXT DEFAULT '',
      original_text TEXT DEFAULT '',
      status TEXT DEFAULT 'processing',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Create indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_memos_account ON memos(account_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memos_agent ON memos(account_id, agent_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memos_status ON memos(account_id, status)`);

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

// ============ Memo Operations ============

export async function createMemo(params: CreateMemoParams): Promise<Memo> {
  return withDb((database) => {
    const id = `memo_${randomUUID()}`;
    const now = Date.now();

    database.run(`
      INSERT INTO memos (id, account_id, agent_id, voice_url, voice_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)
    `, [
      id,
      params.accountId,
      params.agentId,
      params.voiceUrl,
      params.voicePath,
      now,
      now,
    ]);

    saveDb();

    return {
      id,
      accountId: params.accountId,
      agentId: params.agentId,
      title: '',
      summary: '',
      content: '',
      keywords: '[]',
      voiceUrl: params.voiceUrl,
      voicePath: params.voicePath,
      originalText: '',
      status: 'processing',
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function getMemoById(id: string): Promise<Memo | null> {
  return withDb((database) => {
    const result = database.exec(`SELECT * FROM memos WHERE id = ?`, [id]);

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    return rowToMemo(result[0].columns, result[0].values[0]);
  });
}

export async function queryMemos(params: QueryMemosParams): Promise<QueryResult> {
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

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = database.exec(`SELECT COUNT(*) FROM memos WHERE ${whereClause}`, values);
    const total = countResult[0]?.values[0]?.[0] as number ?? 0;

    // Get data with pagination
    const dataResult = database.exec(`
      SELECT * FROM memos WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...values, pageSize, offset]);

    const data: Memo[] = dataResult.length > 0
      ? dataResult[0].values.map((row) => rowToMemo(dataResult[0].columns, row))
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

export async function updateMemo(id: string, updates: UpdateMemoParams): Promise<Memo | null> {
  return withDb((database) => {
    const setClause: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [Date.now()];

    if (updates.agentId !== undefined) {
      setClause.push('agent_id = ?');
      values.push(updates.agentId);
    }
    if (updates.title !== undefined) {
      setClause.push('title = ?');
      values.push(updates.title);
    }
    if (updates.summary !== undefined) {
      setClause.push('summary = ?');
      values.push(updates.summary);
    }
    if (updates.content !== undefined) {
      setClause.push('content = ?');
      values.push(updates.content);
    }
    if (updates.keywords !== undefined) {
      setClause.push('keywords = ?');
      values.push(JSON.stringify(updates.keywords));
    }
    if (updates.originalText !== undefined) {
      setClause.push('original_text = ?');
      values.push(updates.originalText);
    }
    if (updates.status !== undefined) {
      setClause.push('status = ?');
      values.push(updates.status);
    }

    values.push(id);

    database.run(`UPDATE memos SET ${setClause.join(', ')} WHERE id = ?`, values);
    saveDb();

    return getMemoById(id);
  });
}

export async function deleteMemo(id: string): Promise<boolean> {
  return withDb((database) => {
    database.run('DELETE FROM memos WHERE id = ?', [id]);
    saveDb();
    return true;
  });
}

export async function getMemosByAgentId(accountId: string, agentId: string): Promise<Memo[]> {
  return withDb((database) => {
    const result = database.exec(`
      SELECT * FROM memos
      WHERE account_id = ? AND agent_id = ?
      ORDER BY created_at DESC
    `, [accountId, agentId]);

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => rowToMemo(result[0].columns, row));
  });
}

// ============ Helper ============

function rowToMemo(columns: string[], values: any[]): Memo {
  const row: Record<string, any> = {};
  columns.forEach((col, i) => {
    row[col] = values[i];
  });

  return {
    id: row.id as string,
    accountId: row.account_id as string,
    agentId: row.agent_id as string,
    title: row.title as string || '',
    summary: row.summary as string || '',
    content: row.content as string || '',
    keywords: row.keywords as string || '[]',
    voiceUrl: row.voice_url as string || '',
    voicePath: row.voice_path as string || '',
    originalText: row.original_text as string || '',
    status: (row.status as string || 'processing') as 'processing' | 'completed' | 'failed',
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
