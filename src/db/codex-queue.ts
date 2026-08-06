import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CodexQueueItem { id: string; accountId: string; sessionId: string; content: string; attachments: string; fullAuto: boolean; position: number; createdAt: number; }
let db: SqlJsDatabase | null = null;
const DB_DIR = path.join(process.env.HOME || "/root", ".openclaw", "openclaw-chatclaw");
const DB_PATH = path.join(DB_DIR, "codex-queue.db");

async function database(): Promise<SqlJsDatabase> {
  if (db) return db;
  const SQL = await initSqlJs();
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run("CREATE TABLE IF NOT EXISTS codex_queue (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, attachments TEXT NOT NULL, full_auto INTEGER NOT NULL, position INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS idx_codex_queue_session ON codex_queue(account_id, session_id, position)");
  return db;
}
function save(): void { if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
function map(row: any[]): CodexQueueItem { return { id: String(row[0]), accountId: String(row[1]), sessionId: String(row[2]), content: String(row[3]), attachments: String(row[4]), fullAuto: Boolean(row[5]), position: Number(row[6]), createdAt: Number(row[7]) }; }
export async function listQueue(accountId: string, sessionId: string): Promise<CodexQueueItem[]> { const d = await database(); const r = d.exec("SELECT id,account_id,session_id,content,attachments,full_auto,position,created_at FROM codex_queue WHERE account_id=? AND session_id=? ORDER BY position", [accountId, sessionId]); return r[0]?.values.map(map) ?? []; }
export async function enqueue(accountId: string, sessionId: string, content: string, attachments: string, fullAuto: boolean): Promise<CodexQueueItem> { const d = await database(); const position = Number(d.exec("SELECT COALESCE(MAX(position), 0) FROM codex_queue WHERE account_id=? AND session_id=?", [accountId, sessionId])[0]?.values[0]?.[0] ?? 0) + 1; const item: CodexQueueItem = { id: randomUUID(), accountId, sessionId, content, attachments, fullAuto, position, createdAt: Date.now() }; d.run("INSERT INTO codex_queue VALUES (?,?,?,?,?,?,?,?)", [item.id,item.accountId,item.sessionId,item.content,item.attachments,item.fullAuto?1:0,item.position,item.createdAt]); save(); return item; }
export async function removeQueueItem(accountId: string, sessionId: string, id: string): Promise<boolean> { const d = await database(); if (!(await listQueue(accountId, sessionId)).some((item) => item.id === id)) return false; d.run("DELETE FROM codex_queue WHERE id=? AND account_id=? AND session_id=?", [id,accountId,sessionId]); save(); return true; }
export async function updateQueueItem(accountId: string, sessionId: string, id: string, content: string): Promise<CodexQueueItem | null> { const d = await database(); if (!(await listQueue(accountId, sessionId)).some((item) => item.id === id)) return null; d.run("UPDATE codex_queue SET content=? WHERE id=? AND account_id=? AND session_id=?", [content,id,accountId,sessionId]); save(); return (await listQueue(accountId, sessionId)).find((item) => item.id === id) ?? null; }
