import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import argon2 from "argon2";

import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Account data types
// ---------------------------------------------------------------------------

export interface ChatClawAccountData {
  username: string;
  passwordHash: string;
  accountId: string;
  createdAt: string;
  lastConnected?: string;
  avatarUrl?: string;
  agentIds?: string[];
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

export function resolveChatClawStateDir(): string {
  // Use openclaw's state dir
  const baseDir = process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw");
  return path.join(baseDir, "openclaw-chatclaw");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveChatClawStateDir(), "accounts.json");
}

/** Returns all registered accountIds */
export function listIndexedChatClawAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/** Add accountId to the persistent index */
export function registerChatClawAccountId(accountId: string): void {
  const dir = resolveChatClawStateDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = listIndexedChatClawAccountIds();
  if (existing.includes(accountId)) return;

  const updated = [...existing, accountId];
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

/** Remove accountId from the persistent index */
export function unregisterChatClawAccountId(accountId: string): void {
  const existing = listIndexedChatClawAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

function resolveAccountsDir(): string {
  return path.join(resolveChatClawStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

function readAccountFile(filePath: string): ChatClawAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ChatClawAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID */
export function loadChatClawAccount(accountId: string): ChatClawAccountData | null {
  return readAccountFile(resolveAccountPath(accountId));
}

/** Generate accountId from username */
export function generateAccountIdFromUsername(username: string): string {
  const hash = crypto.createHash("sha256").update(username.toLowerCase()).digest("hex").slice(0, 16);
  return `chatclaw_${hash}`;
}

/** Hash password */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

/** Verify password */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return argon2.verify(passwordHash, password);
}

/** Persist account data */
export function saveChatClawAccount(data: ChatClawAccountData): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const normalizedData: ChatClawAccountData = {
    ...data,
    agentIds: Array.isArray(data.agentIds)
      ? Array.from(new Set(data.agentIds.map((id) => id.trim()).filter((id) => id.length > 0)))
      : undefined,
  };

  const filePath = resolveAccountPath(normalizedData.accountId);
  fs.writeFileSync(filePath, JSON.stringify(normalizedData, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** Remove all files associated with an account */
export function clearChatClawAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  try {
    fs.unlinkSync(path.join(dir, `${accountId}.json`));
  } catch {
    // ignore if not found
  }
}

/** Update account avatar */
export function updateChatClawAccountAvatar(accountId: string, avatarUrl: string): ChatClawAccountData | null {
  const account = loadChatClawAccount(accountId);
  if (!account) {
    return null;
  }

  account.avatarUrl = avatarUrl;
  saveChatClawAccount(account);
  logger.info(`Updated avatar for account ${accountId}: ${avatarUrl}`);
  return account;
}

/** Find account by username */
export function findAccountByUsername(username: string): ChatClawAccountData | null {
  const accountId = generateAccountIdFromUsername(username);
  return loadChatClawAccount(accountId);
}

/** Create new account */
export async function createAccount(username: string, password: string): Promise<ChatClawAccountData> {
  const accountId = generateAccountIdFromUsername(username);
  const passwordHash = await hashPassword(password);

  const newAccount: ChatClawAccountData = {
    username,
    passwordHash,
    accountId,
    createdAt: new Date().toISOString(),
    lastConnected: new Date().toISOString(),
  };

  saveChatClawAccount(newAccount);
  registerChatClawAccountId(accountId);

  logger.info(`Created new chatclaw account: ${accountId} (username: ${username})`);
  return newAccount;
}

/** Authenticate user */
export async function authenticateUser(username: string, password: string): Promise<ChatClawAccountData | null> {
  const account = findAccountByUsername(username);

  if (!account) {
    return null;
  }

  if (!(await verifyPassword(password, account.passwordHash))) {
    return null;
  }

  // Update last connected time
  account.lastConnected = new Date().toISOString();
  saveChatClawAccount(account);

  return account;
}

/** Reset account password by username */
export async function resetAccountPassword(username: string, newPassword: string): Promise<ChatClawAccountData | null> {
  const account = findAccountByUsername(username);
  if (!account) {
    return null;
  }

  account.passwordHash = await hashPassword(newPassword);
  account.lastConnected = new Date().toISOString();
  saveChatClawAccount(account);
  logger.info(`Reset password for chatclaw account: ${account.accountId} (username: ${username})`);
  return account;
}

export function listAllowedAgentIds(accountId: string): string[] {
  const account = loadChatClawAccount(accountId);
  if (!Array.isArray(account?.agentIds)) {
    return [];
  }
  return account.agentIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function canAccountAccessAgent(accountId: string, agentId: string): boolean {
  const allowedAgentIds = listAllowedAgentIds(accountId);
  if (allowedAgentIds.length === 0) {
    return true;
  }
  return allowedAgentIds.includes(agentId);
}

export function setAllowedAgentIds(accountId: string, agentIds: string[]): ChatClawAccountData | null {
  const account = loadChatClawAccount(accountId);
  if (!account) {
    return null;
  }

  account.agentIds = agentIds;
  saveChatClawAccount(account);
  return loadChatClawAccount(accountId);
}

export function clearAllowedAgentIds(accountId: string): ChatClawAccountData | null {
  const account = loadChatClawAccount(accountId);
  if (!account) {
    return null;
  }

  delete account.agentIds;
  saveChatClawAccount(account);
  return loadChatClawAccount(accountId);
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------


export type ResolvedChatClawAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  username?: string;
};

type ChatClawAccountConfig = {
  name?: string;
  enabled?: boolean;
};

type ChatClawSectionConfig = ChatClawAccountConfig & {
  accounts?: Record<string, ChatClawAccountConfig>;
};

/** List accountIds from the index file */
export function listChatClawAccountIds(cfg: OpenClawConfig): string[] {
  void cfg;
  return listIndexedChatClawAccountIds();
}

/** Resolve a chatclaw account by ID */
export function resolveChatClawAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedChatClawAccount {
  const raw = accountId?.trim();
  if (!raw) {
    throw new Error("chatclaw: accountId is required");
  }

  const id = normalizeAccountId(raw);

  const section = cfg.channels?.["openclaw-chatclaw"] as ChatClawSectionConfig | undefined;
  const accountCfg: ChatClawAccountConfig = section?.accounts?.[id] ?? section ?? {};

  const accountData = loadChatClawAccount(id);

  return {
    accountId: id,
    enabled: accountCfg.enabled !== false,
    configured: Boolean(accountData?.username && accountData?.passwordHash),
    name: accountCfg.name?.trim() || accountData?.username,
    username: accountData?.username,
  };
}
