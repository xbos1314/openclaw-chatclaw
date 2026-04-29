import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DB_DIR = path.join(os.homedir(), '.openclaw', 'openclaw-chatclaw', 'miniprogram');
const DB_PATH = path.join(DB_DIR, 'projects.db');

let db: SqlJsDatabase | null = null;

export type MiniprogramStatus = 'creating' | 'ready' | 'failed' | 'archived';
export type MiniprogramTaskType = 'create' | 'update' | 'build' | 'manual_update';
export type MiniprogramTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Miniprogram {
  id: string;
  appId: string;
  accountId: string;
  agentId: string;
  name: string;
  summary: string;
  description: string;
  status: MiniprogramStatus;
  rootDir: string;
  appDir: string;
  dataDir: string;
  distDir: string;
  publicPath: string;
  publicUrl: string;
  iconUrl: string;
  techStack: string;
  templateName: string;
  sqlitePath: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
}

export interface MiniprogramTask {
  id: string;
  appId: string | null;
  accountId: string;
  agentId: string;
  taskType: MiniprogramTaskType;
  status: MiniprogramTaskStatus;
  prompt: string;
  notes: string;
  requestMessageId: string;
  resultMessageId: string;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
}

export interface MiniprogramRevision {
  id: string;
  appId: string;
  accountId: string;
  agentId: string;
  version: number;
  changeSummary: string;
  promptSnapshot: string;
  createdAt: number;
}

export interface CreateMiniprogramParams {
  appId: string;
  accountId: string;
  agentId: string;
  name: string;
  status?: MiniprogramStatus;
  rootDir: string;
  appDir: string;
  dataDir: string;
  distDir: string;
  publicPath: string;
  publicUrl: string;
  templateName?: string;
}

export interface UpdateMiniprogramParams {
  agentId?: string;
  name?: string;
  summary?: string;
  description?: string;
  status?: MiniprogramStatus;
  publicUrl?: string;
  sqlitePath?: string;
  lastError?: string;
  iconUrl?: string;
}

export interface QueryMiniprogramsParams {
  accountId: string;
  status?: MiniprogramStatus;
  page?: number;
  pageSize?: number;
}

export interface QueryResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CreateMiniprogramTaskParams {
  appId?: string | null;
  accountId: string;
  agentId: string;
  taskType: MiniprogramTaskType;
  status?: MiniprogramTaskStatus;
  prompt: string;
  notes?: string;
  requestMessageId?: string;
}

export interface UpdateMiniprogramTaskParams {
  appId?: string | null;
  taskType?: MiniprogramTaskType;
  prompt?: string;
  notes?: string;
  status?: MiniprogramTaskStatus;
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
    CREATE TABLE IF NOT EXISTS miniprograms (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      root_dir TEXT NOT NULL,
      app_dir TEXT NOT NULL,
      data_dir TEXT NOT NULL,
      dist_dir TEXT NOT NULL,
      public_path TEXT NOT NULL,
      public_url TEXT NOT NULL,
      icon_url TEXT NOT NULL DEFAULT '',
      tech_stack TEXT NOT NULL DEFAULT 'node+vue+sqlite',
      template_name TEXT NOT NULL DEFAULT 'base',
      sqlite_path TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS miniprogram_tasks (
      id TEXT PRIMARY KEY,
      app_id TEXT,
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
  db.run(`
    CREATE TABLE IF NOT EXISTS miniprogram_revisions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      change_summary TEXT NOT NULL DEFAULT '',
      prompt_snapshot TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_miniprograms_account ON miniprograms(account_id, updated_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_miniprograms_status ON miniprograms(account_id, status, updated_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_miniprogram_tasks_account ON miniprogram_tasks(account_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_miniprogram_tasks_app ON miniprogram_tasks(app_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_miniprogram_revisions_app ON miniprogram_revisions(app_id, version DESC)`);
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

export async function createMiniprogram(params: CreateMiniprogramParams): Promise<Miniprogram> {
  return withDb((database) => {
    const now = Date.now();
    const id = `mpj_${randomUUID()}`;
    database.run(`
      INSERT INTO miniprograms (
        id, app_id, account_id, agent_id, name, status, root_dir, app_dir, data_dir, dist_dir,
        public_path, public_url, template_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      params.appId,
      params.accountId,
      params.agentId,
      params.name,
      params.status ?? 'creating',
      params.rootDir,
      params.appDir,
      params.dataDir,
      params.distDir,
      params.publicPath,
      params.publicUrl,
      params.templateName ?? 'base',
      now,
      now,
    ]);
    saveDb();
    return {
      id,
      appId: params.appId,
      accountId: params.accountId,
      agentId: params.agentId,
      name: params.name,
      summary: '',
      description: '',
      status: params.status ?? 'creating',
      rootDir: params.rootDir,
      appDir: params.appDir,
      dataDir: params.dataDir,
      distDir: params.distDir,
      publicPath: params.publicPath,
      publicUrl: params.publicUrl,
      iconUrl: '',
      techStack: 'node+vue+sqlite',
      templateName: params.templateName ?? 'base',
      sqlitePath: '',
      lastError: '',
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function getMiniprogramByAppId(appId: string): Promise<Miniprogram | null> {
  return withDb((database) => {
    const result = database.exec(`SELECT * FROM miniprograms WHERE app_id = ?`, [appId]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToMiniprogram(result[0].columns, result[0].values[0]);
  });
}

export async function queryMiniprograms(params: QueryMiniprogramsParams): Promise<QueryResult<Miniprogram>> {
  return withDb((database) => {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const conditions = ['account_id = ?'];
    const values: Array<string | number> = [params.accountId];
    if (params.status) {
      conditions.push('status = ?');
      values.push(params.status);
    }
    const whereClause = conditions.join(' AND ');
    const countResult = database.exec(`SELECT COUNT(*) FROM miniprograms WHERE ${whereClause}`, values);
    const total = (countResult[0]?.values[0]?.[0] as number) ?? 0;
    const dataResult = database.exec(`
      SELECT * FROM miniprograms WHERE ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `, [...values, pageSize, offset]);
    const data = dataResult.length > 0
      ? dataResult[0].values.map((row) => rowToMiniprogram(dataResult[0].columns, row))
      : [];
    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });
}

export async function updateMiniprogram(appId: string, updates: UpdateMiniprogramParams): Promise<Miniprogram | null> {
  return withDb((database) => {
    const setClause = ['updated_at = ?'];
    const values: Array<string | number> = [Date.now()];
    if (updates.agentId !== undefined) { setClause.push('agent_id = ?'); values.push(updates.agentId); }
    if (updates.name !== undefined) { setClause.push('name = ?'); values.push(updates.name); }
    if (updates.summary !== undefined) { setClause.push('summary = ?'); values.push(updates.summary); }
    if (updates.description !== undefined) { setClause.push('description = ?'); values.push(updates.description); }
    if (updates.status !== undefined) { setClause.push('status = ?'); values.push(updates.status); }
    if (updates.publicUrl !== undefined) { setClause.push('public_url = ?'); values.push(updates.publicUrl); }
    if (updates.sqlitePath !== undefined) { setClause.push('sqlite_path = ?'); values.push(updates.sqlitePath); }
    if (updates.lastError !== undefined) { setClause.push('last_error = ?'); values.push(updates.lastError); }
    if (updates.iconUrl !== undefined) { setClause.push('icon_url = ?'); values.push(updates.iconUrl); }
    values.push(appId);
    database.run(`UPDATE miniprograms SET ${setClause.join(', ')} WHERE app_id = ?`, values);
    saveDb();
    return getMiniprogramByAppId(appId);
  });
}

export async function deleteMiniprogram(appId: string): Promise<boolean> {
  return withDb((database) => {
    const exists = database.exec(`SELECT id FROM miniprograms WHERE app_id = ? LIMIT 1`, [appId]);
    if (exists.length === 0 || exists[0].values.length === 0) {
      return false;
    }
    database.run(`DELETE FROM miniprogram_revisions WHERE app_id = ?`, [appId]);
    database.run(`DELETE FROM miniprogram_tasks WHERE app_id = ?`, [appId]);
    database.run(`DELETE FROM miniprograms WHERE app_id = ?`, [appId]);
    saveDb();
    return true;
  });
}

export async function createMiniprogramTask(params: CreateMiniprogramTaskParams): Promise<MiniprogramTask> {
  return withDb((database) => {
    const now = Date.now();
    const id = `mpt_${randomUUID()}`;
    database.run(`
      INSERT INTO miniprogram_tasks (
        id, app_id, account_id, agent_id, task_type, status, prompt, notes,
        request_message_id, result_message_id, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
    `, [
      id,
      params.appId ?? null,
      params.accountId,
      params.agentId,
      params.taskType,
      params.status ?? 'pending',
      params.prompt,
      params.notes ?? '',
      params.requestMessageId ?? '',
      now,
      now,
    ]);
    saveDb();
    return {
      id,
      appId: params.appId ?? null,
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

export async function updateMiniprogramTask(taskId: string, updates: UpdateMiniprogramTaskParams): Promise<MiniprogramTask | null> {
  return withDb((database) => {
    const setClause = ['updated_at = ?'];
    const values: Array<string | number | null> = [Date.now()];
    if (updates.appId !== undefined) { setClause.push('app_id = ?'); values.push(updates.appId); }
    if (updates.taskType !== undefined) { setClause.push('task_type = ?'); values.push(updates.taskType); }
    if (updates.prompt !== undefined) { setClause.push('prompt = ?'); values.push(updates.prompt); }
    if (updates.notes !== undefined) { setClause.push('notes = ?'); values.push(updates.notes); }
    if (updates.status !== undefined) { setClause.push('status = ?'); values.push(updates.status); }
    if (updates.requestMessageId !== undefined) { setClause.push('request_message_id = ?'); values.push(updates.requestMessageId); }
    if (updates.resultMessageId !== undefined) { setClause.push('result_message_id = ?'); values.push(updates.resultMessageId); }
    if (updates.errorMessage !== undefined) { setClause.push('error_message = ?'); values.push(updates.errorMessage); }
    values.push(taskId);
    database.run(`UPDATE miniprogram_tasks SET ${setClause.join(', ')} WHERE id = ?`, values);
    saveDb();
    return getMiniprogramTaskById(taskId);
  });
}

export async function getMiniprogramTaskById(taskId: string): Promise<MiniprogramTask | null> {
  return withDb((database) => {
    const result = database.exec(`SELECT * FROM miniprogram_tasks WHERE id = ?`, [taskId]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToTask(result[0].columns, result[0].values[0]);
  });
}

export async function queryMiniprogramTasks(accountId: string, appId: string): Promise<MiniprogramTask[]> {
  return withDb((database) => {
    const result = database.exec(`
      SELECT * FROM miniprogram_tasks
      WHERE account_id = ? AND app_id = ?
      ORDER BY created_at DESC
    `, [accountId, appId]);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToTask(result[0].columns, row));
  });
}

export async function getLatestTaskByAppId(accountId: string, appId: string): Promise<MiniprogramTask | null> {
  return withDb((database) => {
    const result = database.exec(`
      SELECT * FROM miniprogram_tasks
      WHERE account_id = ? AND app_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, [accountId, appId]);
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }
    return rowToTask(result[0].columns, result[0].values[0]);
  });
}

export async function createMiniprogramRevision(params: Omit<MiniprogramRevision, 'id'>): Promise<MiniprogramRevision> {
  return withDb((database) => {
    const id = `mpr_${randomUUID()}`;
    database.run(`
      INSERT INTO miniprogram_revisions (id, app_id, account_id, agent_id, version, change_summary, prompt_snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, params.appId, params.accountId, params.agentId, params.version, params.changeSummary, params.promptSnapshot, params.createdAt]);
    saveDb();
    return { id, ...params };
  });
}

export async function getNextMiniprogramRevisionVersion(appId: string): Promise<number> {
  return withDb((database) => {
    const result = database.exec(
      `
        SELECT COALESCE(MAX(version), 0) AS latest_version
        FROM miniprogram_revisions
        WHERE app_id = ?
      `,
      [appId],
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return 1;
    }
    return Number(result[0].values[0][0] ?? 0) + 1;
  });
}

function rowToMiniprogram(columns: readonly string[], row: readonly unknown[]): Miniprogram {
  const map = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  return {
    id: String(map.id),
    appId: String(map.app_id),
    accountId: String(map.account_id),
    agentId: String(map.agent_id),
    name: String(map.name),
    summary: String(map.summary ?? ''),
    description: String(map.description ?? ''),
    status: map.status as MiniprogramStatus,
    rootDir: String(map.root_dir),
    appDir: String(map.app_dir),
    dataDir: String(map.data_dir),
    distDir: String(map.dist_dir),
    publicPath: String(map.public_path),
    publicUrl: String(map.public_url),
    iconUrl: String(map.icon_url ?? ''),
    techStack: String(map.tech_stack ?? 'node+vue+sqlite'),
    templateName: String(map.template_name ?? 'base'),
    sqlitePath: String(map.sqlite_path ?? ''),
    lastError: String(map.last_error ?? ''),
    createdAt: Number(map.created_at),
    updatedAt: Number(map.updated_at),
  };
}

function rowToTask(columns: readonly string[], row: readonly unknown[]): MiniprogramTask {
  const map = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  return {
    id: String(map.id),
    appId: map.app_id ? String(map.app_id) : null,
    accountId: String(map.account_id),
    agentId: String(map.agent_id),
    taskType: map.task_type as MiniprogramTaskType,
    status: map.status as MiniprogramTaskStatus,
    prompt: String(map.prompt ?? ''),
    notes: String(map.notes ?? ''),
    requestMessageId: String(map.request_message_id ?? ''),
    resultMessageId: String(map.result_message_id ?? ''),
    errorMessage: String(map.error_message ?? ''),
    createdAt: Number(map.created_at),
    updatedAt: Number(map.updated_at),
  };
}
