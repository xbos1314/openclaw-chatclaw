import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ParsedUrl } from '../http/server.js';
import { sendJson } from '../http/server.js';
import type { Miniprogram } from '../db/miniprograms.js';
import { logger } from '../util/logger.js';
import { getMiniprogramProjectPaths, isMiniprogramCustomApiEnabled } from './storage.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const workerScriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../bin/miniprogram-custom-api-worker.mjs',
);

interface CustomApiRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  body: unknown;
  rawBody: string;
  params: Record<string, string>;
}

interface CustomApiContext {
  appId: string;
  projectDir: string;
  publicBaseUrl: string;
  dataDir: string;
  distDir: string;
  requestId: string;
}

interface CustomApiResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface WorkerResponseMessage {
  id: string;
  ok: boolean;
  response?: CustomApiResponse;
  error?: {
    message: string;
    statusCode?: number;
  };
}

interface WorkerPendingRequest {
  reject: (error: Error & { statusCode?: number }) => void;
  resolve: (value: CustomApiResponse) => void;
  timer: NodeJS.Timeout;
}

interface WorkerState {
  appId: string;
  child: ChildProcess;
  pending: Map<string, WorkerPendingRequest>;
}

const workers = new Map<string, WorkerState>();
let cleanupRegistered = false;

export async function handleMiniprogramCustomApi(
  project: Miniprogram,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  res: http.ServerResponse,
): Promise<void> {
  if (!isMiniprogramCustomApiEnabled(project.appId)) {
    sendJson(res, 404, {
      code: 4004,
      error: 'Custom API is disabled for this project',
    });
    return;
  }
  const request = await buildCustomApiRequest(project.appId, req, parsedUrl);
  const context = buildCustomApiContext(project);
  try {
    const worker = ensureWorker(project);
    const response = await sendWorkerMessage(worker, {
      kind: 'execute',
      request,
      context,
    });
    await clearProjectRuntimeError(project);
    writeCustomApiResponse(res, response);
  } catch (error: any) {
    await setProjectRuntimeError(project, error);
    sendJson(res, error?.statusCode || 500, {
      code: error?.statusCode || 5001,
      error: error?.message || 'Custom API handler failed',
    });
  }
}

export async function reloadMiniprogramCustomApi(project: Miniprogram): Promise<{ entry: string; reloaded: boolean; pid: number | null }> {
  if (!isMiniprogramCustomApiEnabled(project.appId)) {
    stopWorker(project.appId, 'custom_api_disabled');
    await clearProjectRuntimeError(project);
    return {
      entry: getServerEntryPath(project.appId),
      reloaded: false,
      pid: null,
    };
  }
  const worker = restartWorker(project);
  await sendWorkerMessage(worker, { kind: 'reload' });
  await clearProjectRuntimeError(project);
  return {
    entry: getServerEntryPath(project.appId),
    reloaded: true,
    pid: worker.child.pid ?? null,
  };
}

function ensureWorker(project: Miniprogram): WorkerState {
  const existing = workers.get(project.appId);
  if (existing && existing.child.exitCode == null && !existing.child.killed && existing.child.connected) {
    return existing;
  }
  return spawnWorker(project);
}

function restartWorker(project: Miniprogram): WorkerState {
  stopWorker(project.appId, 'restart');
  return spawnWorker(project);
}

function spawnWorker(project: Miniprogram): WorkerState {
  registerCleanupHooks();
  if (!fs.existsSync(workerScriptPath)) {
    throw createHttpError(500, `Worker script not found: ${workerScriptPath}`);
  }
  const child = spawn(process.execPath, [workerScriptPath], {
    cwd: project.rootDir,
    env: {
      ...process.env,
      MINIPROGRAM_APP_ID: project.appId,
      MINIPROGRAM_ENTRY_PATH: getServerEntryPath(project.appId),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const state: WorkerState = {
    appId: project.appId,
    child,
    pending: new Map(),
  };
  child.on('message', (message) => {
    handleWorkerMessage(state, message);
  });
  child.on('exit', (code, signal) => {
    if (workers.get(project.appId) === state) {
      workers.delete(project.appId);
    }
    rejectPending(state, createHttpError(503, `Custom API worker exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
  });
  child.on('error', (error) => {
    logger.error(`miniprogram custom worker error [${project.appId}]: ${String(error)}`);
  });
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text !== '') {
      logger.info(`[miniprogram-worker:${project.appId}] ${text}`);
    }
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text !== '') {
      logger.error(`[miniprogram-worker:${project.appId}] ${text}`);
    }
  });
  workers.set(project.appId, state);
  return state;
}

function registerCleanupHooks(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  const shutdown = () => {
    for (const appId of [...workers.keys()]) {
      stopWorker(appId, 'gateway_shutdown');
    }
  };
  process.once('exit', shutdown);
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
}

function stopWorker(appId: string, reason: string): void {
  const state = workers.get(appId);
  if (!state) return;
  workers.delete(appId);
  rejectPending(state, createHttpError(503, `Custom API worker stopped: ${reason}`));
  if (state.child.exitCode == null && !state.child.killed) {
    state.child.kill();
  }
}

function rejectPending(state: WorkerState, error: Error & { statusCode?: number }): void {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
}

async function sendWorkerMessage(
  state: WorkerState,
  payload: Record<string, unknown>,
): Promise<CustomApiResponse> {
  if (!state.child.connected) {
    throw createHttpError(503, 'Custom API worker is not connected');
  }
  const id = `wrk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const responsePromise = new Promise<CustomApiResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      stopWorker(state.appId, 'timeout');
      reject(createHttpError(504, `Custom API worker timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);
    state.pending.set(id, { resolve, reject, timer });
  });
  state.child.send({ id, ...payload });
  return responsePromise;
}

function handleWorkerMessage(state: WorkerState, message: unknown): void {
  if (!isWorkerResponseMessage(message)) {
    logger.error(`Invalid custom API worker message [${state.appId}]`);
    return;
  }
  const pending = state.pending.get(message.id);
  if (!pending) {
    return;
  }
  state.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.ok) {
    pending.resolve(message.response ?? {});
    return;
  }
  pending.reject(createHttpError(message.error?.statusCode || 500, message.error?.message || 'Custom API worker failed'));
}

function isWorkerResponseMessage(message: unknown): message is WorkerResponseMessage {
  if (typeof message !== 'object' || message == null) {
    return false;
  }
  return typeof (message as WorkerResponseMessage).id === 'string' && typeof (message as WorkerResponseMessage).ok === 'boolean';
}

function getServerEntryPath(appId: string): string {
  return path.join(getMiniprogramProjectPaths(appId).serverDir, 'index.js');
}

async function buildCustomApiRequest(
  appId: string,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
): Promise<CustomApiRequest> {
  const { body, rawBody } = await parseRequestBody(req);
  return {
    method: req.method || 'GET',
    path: extractCustomPath(appId, parsedUrl.pathname),
    query: parseQuery(parsedUrl.searchParams),
    headers: normalizeHeaders(req.headers),
    body,
    rawBody,
    params: {},
  };
}

function buildCustomApiContext(project: Miniprogram): CustomApiContext {
  const paths = getMiniprogramProjectPaths(project.appId);
  return {
    appId: project.appId,
    projectDir: paths.rootDir,
    publicBaseUrl: `/miniprogram/${project.appId}`,
    dataDir: paths.dataDir,
    distDir: paths.distDir,
    requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

function extractCustomPath(appId: string, pathname: string): string {
  const prefix = `/api/miniprogram/${appId}`;
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  return rest === '' ? '/' : rest;
}

function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key);
    query[key] = values.length <= 1 ? (values[0] ?? '') : values;
  }
  return query;
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value : (value ?? ''),
    ]),
  );
}

async function parseRequestBody(req: http.IncomingMessage): Promise<{ body: unknown; rawBody: string }> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return { body: null, rawBody: '' };
  }
  const buffer = await readRequestBuffer(req);
  if (buffer.length === 0) {
    return { body: null, rawBody: '' };
  }
  const rawBody = buffer.toString('utf8');
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(rawBody), rawBody };
    } catch {
      throw createHttpError(400, 'Invalid JSON');
    }
  }
  return { body: rawBody, rawBody };
}

async function readRequestBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function writeCustomApiResponse(res: http.ServerResponse, response: CustomApiResponse | undefined): void {
  const status = response?.status ?? 200;
  const headers = response?.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  const body = response?.body;
  if (body == null) {
    res.writeHead(status);
    res.end();
    return;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (!res.hasHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    res.writeHead(status);
    res.end(body);
    return;
  }
  if (typeof body === 'string') {
    if (!res.hasHeader('Content-Type')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.writeHead(status);
    res.end(body);
    return;
  }
  if (!res.hasHeader('Content-Type')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function createHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

async function setProjectRuntimeError(project: Miniprogram, error: unknown): Promise<void> {
  const { updateMiniprogram } = await import('../db/miniprograms.js');
  await updateMiniprogram(project.appId, {
    lastError: `custom_api: ${String((error as Error)?.message || error)}`,
  });
}

async function clearProjectRuntimeError(project: Miniprogram): Promise<void> {
  const { updateMiniprogram } = await import('../db/miniprograms.js');
  await updateMiniprogram(project.appId, {
    lastError: '',
  });
}
