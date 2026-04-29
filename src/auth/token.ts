import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";

// 同步加载 .env 文件（使用插件目录的绝对路径）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// ============ Types ============

export interface TokenPayload {
  accountId: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthToken {
  token: string;
  expiresAt: number;
}

export interface MiniprogramSessionCookiePayload {
  appId: string;
  createdAt: number;
  expiresAt: number;
}

// ============ Configuration ============

const TOKEN_SECRET = process.env.CHATCLAW_TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const DOWNLOAD_SECRET = process.env.CHATCLAW_TOKEN_SECRET!;
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DOWNLOAD_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MINIPROGRAM_SESSION_COOKIE_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours

// ============ Token Management ============

/**
 * Generate a new auth token for an account
 */
export function generateAuthToken(accountId: string, username: string): AuthToken {
  const now = Date.now();
  const expiresAt = now + TOKEN_EXPIRY_MS;

  const payload: TokenPayload = {
    accountId,
    username,
    createdAt: now,
    expiresAt,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson).toString("base64url");

  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  const token = `${payloadBase64}.${signature}`;

  return { token, expiresAt };
}

/**
 * Verify and decode an auth token
 */
export function verifyAuthToken(token: string): TokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return null;
    }

    const [payloadBase64, signature] = parts;

    // Verify signature
    const expectedSignature = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(payloadBase64)
      .digest("base64url");

    if (signature !== expectedSignature) {
      return null;
    }

    // Decode payload
    const payloadJson = Buffer.from(payloadBase64, "base64url").toString("utf-8");
    const payload: TokenPayload = JSON.parse(payloadJson);

    // Check expiry
    if (Date.now() > payload.expiresAt) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract token from Authorization header
 */
export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Get account ID from Authorization header
 */
export function getAccountIdFromAuth(authHeader: string | undefined): string | null {
  const token = extractTokenFromHeader(authHeader);
  if (!token) {
    return null;
  }

  const payload = verifyAuthToken(token);
  return payload?.accountId ?? null;
}

/**
 * Verify token and get account info (for WebSocket auth)
 */
export function verifyTokenGetAccount(token: string): { accountId: string; username: string } | null {
  const payload = verifyAuthToken(token);
  if (!payload) {
    return null;
  }
  return {
    accountId: payload.accountId,
    username: payload.username,
  };
}

// ============ Download Token Management ============

/**
 * Generate a download token for file/voice download URLs
 * Format: expiresAt:nonce:signature
 */
export function generateDownloadToken(accountId: string): string {
  const now = Date.now();
  const expiresAt = now + DOWNLOAD_TOKEN_EXPIRY_MS;
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${accountId}:${expiresAt}:${nonce}`;
  const signature = crypto
    .createHmac("sha256", DOWNLOAD_SECRET)
    .update(payload)
    .digest("hex");
  return `${expiresAt}:${nonce}:${signature}`;
}

/**
 * Verify a download token
 */
export function verifyDownloadToken(token: string, accountId: string): boolean {
  try {
    const parts = token.split(":");
    if (parts.length !== 3) {
      return false;
    }

    const [expiresAtStr, nonce, signature] = parts;
    const expiresAt = Number(expiresAtStr);

    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      return false;
    }

    const payload = `${accountId}:${expiresAt}:${nonce}`;
    const expected = crypto
      .createHmac("sha256", DOWNLOAD_SECRET)
      .update(payload)
      .digest("hex");

    return signature === expected;
  } catch {
    return false;
  }
}

export function getMiniprogramSessionCookieName(appId: string): string {
  return `chatclaw_mp_session_${appId}`;
}

export function generateMiniprogramSessionCookieToken(appId: string): { token: string; expiresAt: number } {
  const now = Date.now();
  const expiresAt = now + MINIPROGRAM_SESSION_COOKIE_EXPIRY_MS;
  const payload: MiniprogramSessionCookiePayload = {
    appId,
    createdAt: now,
    expiresAt,
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`miniprogram_file:${payloadBase64}`)
    .digest("base64url");
  return {
    token: `${payloadBase64}.${signature}`,
    expiresAt,
  };
}

export function verifyMiniprogramSessionCookieToken(token: string, appId: string): MiniprogramSessionCookiePayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return null;
    }
    const [payloadBase64, signature] = parts;
    const expectedSignature = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(`miniprogram_file:${payloadBase64}`)
      .digest("base64url");
    if (signature !== expectedSignature) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf-8")) as MiniprogramSessionCookiePayload;
    if (payload.appId !== appId || Date.now() > payload.expiresAt) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
