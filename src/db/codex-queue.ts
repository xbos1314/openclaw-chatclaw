import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CODEX_AUTHORIZATION_MODE, isFullAccessAuthorization, normalizeCodexAuthorizationMode, type CodexAuthorizationMode } from "../codex/authorization.js";

export interface CodexQueueItem { id: string; accountId: string; sessionId: string; content: string; attachments: string; authorizationMode: CodexAuthorizationMode; position: number; createdAt: number; }
let db: SqlJsDatabase | null = null;
const DB_DIR = path.join(process.env.HOME || "/root", ".openclaw", "openclaw-chatclaw");
const DB_PATH = path.join(DB_DIR, "codex-queue.db");

async function database(): Promise<SqlJsDatabase> {
  if (db) return db;
  const SQL = await initSqlJs();
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run("CREATE TABLE IF NOT EXISTS codex_queue (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, attachments TEXT NOT NULL, full_auto INTEGER NOT NULL, authorization_mode TEXT NOT NULL DEFAULT 'request_approval', position INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  const columns = db.exec("PRAGMA table_info(codex_queue)")[0]?.values.map((row: any[]) => String(row[1])) ?? [];
  let migrated = false;
  if (!columns.includes("authorization_mode")) {
    db.run("ALTER TABLE codex_queue ADD COLUMN authorization_mode TEXT");
    db.run("UPDATE codex_queue SET authorization_mode=CASE WHEN full_auto=1 THEN 'full_access' ELSE 'request_approval' END WHERE authorization_mode IS NULL");
    migrated = true;
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_codex_queue_session ON codex_queue(account_id, session_id, position)");
  if (migrated) save();
  return db;
}
function save(): void { if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
function map(row: any[]): CodexQueueItem { return { id: String(row[0]), accountId: String(row[1]), sessionId: String(row[2]), content: String(row[3]), attachments: String(row[4]), authorizationMode: normalizeCodexAuthorizationMode(row[6], row[5]), position: Number(row[7]), createdAt: Number(row[8]) }; }
export async function listQueue(accountId: string, sessionId: string): Promise<CodexQueueItem[]> { const d = await database(); const r = d.exec("SELECT id,account_id,session_id,content,attachments,full_auto,authorization_mode,position,created_at FROM codex_queue WHERE account_id=? AND session_id=? ORDER BY position", [accountId, sessionId]); return r[0]?.values.map(map) ?? []; }
export async function enqueue(accountId: string, sessionId: string, content: string, attachments: string, authorizationMode: CodexAuthorizationMode = DEFAULT_CODEX_AUTHORIZATION_MODE): Promise<CodexQueueItem> { const d = await database(); const position = Number(d.exec("SELECT COALESCE(MAX(position), 0) FROM codex_queue WHERE account_id=? AND session_id=?", [accountId, sessionId])[0]?.values[0]?.[0] ?? 0) + 1; const item: CodexQueueItem = { id: randomUUID(), accountId, sessionId, content, attachments, authorizationMode, position, createdAt: Date.now() }; d.run("INSERT INTO codex_queue (id,account_id,session_id,content,attachments,full_auto,authorization_mode,position,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [item.id,item.accountId,item.sessionId,item.content,item.attachments,isFullAccessAuthorization(item.authorizationMode)?1:0,item.authorizationMode,item.position,item.createdAt]); save(); return item; }
export async function removeQueueItem(accountId: string, sessionId: string, id: string): Promise<boolean> { const d = await database(); if (!(await listQueue(accountId, sessionId)).some((item) => item.id === id)) return false; d.run("DELETE FROM codex_queue WHERE id=? AND account_id=? AND session_id=?", [id,accountId,sessionId]); save(); return true; }
export async function updateQueueItem(accountId: string, sessionId: string, id: string, content: string): Promise<CodexQueueItem | null> { const d = await database(); if (!(await listQueue(accountId, sessionId)).some((item) => item.id === id)) return null; d.run("UPDATE codex_queue SET content=? WHERE id=? AND account_id=? AND session_id=?", [content,id,accountId,sessionId]); save(); return (await listQueue(accountId, sessionId)).find((item) => item.id === id) ?? null; }
