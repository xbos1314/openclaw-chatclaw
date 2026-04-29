import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const appId = process.env.MINIPROGRAM_APP_ID || '';
const entryPath = process.env.MINIPROGRAM_ENTRY_PATH || '';

let cachedHandler = null;
let cachedMtimeMs = 0;

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') {
    return;
  }
  const { id, kind } = message;
  if (typeof id !== 'string' || typeof kind !== 'string') {
    return;
  }
  try {
    if (kind === 'reload') {
      await loadHandler(true);
      respond(id, true, { status: 200, body: { ok: true, appId } });
      return;
    }
    if (kind === 'execute') {
      const handler = await loadHandler(false);
      const response = await handler(message.request || {}, message.context || {});
      respond(id, true, response || {});
      return;
    }
    throw createWorkerError(`Unknown worker message kind: ${kind}`, 400);
  } catch (error) {
    respond(id, false, null, normalizeError(error));
  }
});

process.on('uncaughtException', (error) => {
  console.error(`[worker:${appId}] uncaughtException`, error);
});

process.on('unhandledRejection', (error) => {
  console.error(`[worker:${appId}] unhandledRejection`, error);
});

async function loadHandler(forceReload) {
  if (entryPath === '') {
    throw createWorkerError('MINIPROGRAM_ENTRY_PATH is missing', 500);
  }
  if (!fs.existsSync(entryPath)) {
    throw createWorkerError(`Custom API entry not found: ${entryPath}`, 404);
  }
  const stat = fs.statSync(entryPath);
  if (!forceReload && cachedHandler && cachedMtimeMs === stat.mtimeMs) {
    return cachedHandler;
  }
  const entryUrl = pathToFileURL(entryPath);
  entryUrl.searchParams.set('mtime', String(stat.mtimeMs));
  const mod = await import(entryUrl.href);
  if (typeof mod.handle !== 'function') {
    throw createWorkerError(`Custom API entry must export handle(): ${entryPath}`, 500);
  }
  cachedHandler = mod.handle;
  cachedMtimeMs = stat.mtimeMs;
  return cachedHandler;
}

function respond(id, ok, response = null, error = null) {
  if (typeof process.send === 'function') {
    process.send({ id, ok, response, error });
  }
}

function normalizeError(error) {
  if (error && typeof error === 'object') {
    return {
      message: error.message || String(error),
      statusCode: error.statusCode,
    };
  }
  return {
    message: String(error),
  };
}

function createWorkerError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
