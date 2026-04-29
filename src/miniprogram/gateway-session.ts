import http from 'node:http';

import {
  generateMiniprogramSessionCookieToken,
  getMiniprogramSessionCookieName,
  verifyMiniprogramSessionCookieToken,
} from '../auth/token.js';
import { sendJson } from '../http/server.js';

export function issueMiniprogramSessionCookie(
  res: http.ServerResponse,
  appId: string,
): void {
  const { token, expiresAt } = generateMiniprogramSessionCookieToken(appId);
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${getMiniprogramSessionCookieName(appId)}=${encodeURIComponent(token)}; Path=/api/miniprogram/${appId}/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

export function requireMiniprogramGatewaySession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  appId: string,
): boolean {
  if (!validateMiniprogramGatewayReferer(req, appId)) {
    sendJson(res, 403, { code: 4031, error: 'Invalid referer' });
    return false;
  }
  if (!hasValidMiniprogramSessionCookie(req, appId)) {
    sendJson(res, 401, { code: 4011, error: 'Invalid miniprogram session cookie' });
    return false;
  }
  return true;
}

function validateMiniprogramGatewayReferer(
  req: http.IncomingMessage,
  appId: string,
): boolean {
  const rawReferer = String(req.headers.referer || '').trim();
  if (rawReferer === '') {
    return false;
  }
  try {
    const refererUrl = new URL(rawReferer);
    const pathname = refererUrl.pathname || '/';
    return pathname === `/miniprogram/${appId}` || pathname.startsWith(`/miniprogram/${appId}/`);
  } catch {
    return false;
  }
}

function hasValidMiniprogramSessionCookie(
  req: http.IncomingMessage,
  appId: string,
): boolean {
  const cookies = parseCookies(req);
  const token = cookies[getMiniprogramSessionCookieName(appId)];
  if (!token) {
    return false;
  }
  return verifyMiniprogramSessionCookieToken(token, appId) != null;
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const rawCookie = String(req.headers.cookie || '');
  const result: Record<string, string> = {};
  for (const item of rawCookie.split(';')) {
    const trimmed = item.trim();
    if (trimmed === '') continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}
