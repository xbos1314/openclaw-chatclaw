import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireAuth, parseBody, sendJson, getMimeTypeFromFileName } from './server.js';
import type { ParsedUrl, RequestContext } from './server.js';
import { logger } from '../util/logger.js';
import * as miniprogramDB from '../db/miniprograms.js';
import * as messageDB from '../db/message.js';
import {
  dispatchMiniprogramContextToAgent,
  dispatchMiniprogramCreateToAgent,
  dispatchMiniprogramEditToAgent,
} from '../miniprogram/dispatcher.js';
import {
  getMiniprogramProjectDir,
  getProjectFileTree,
  readProjectTextFile,
  writeProjectTextFile,
} from '../miniprogram/storage.js';
import {
  issueMiniprogramSessionCookie,
  requireMiniprogramGatewaySession,
} from '../miniprogram/gateway-session.js';
import {
  deleteMiniprogramFile,
  readMiniprogramFile,
  saveMiniprogramFile,
} from '../miniprogram/file-storage.js';
import { sendToClientByAccountId } from '../websocket/server.js';
import { buildMiniprogramProject } from '../miniprogram/build.js';
import { handleMiniprogramCustomApi, reloadMiniprogramCustomApi } from '../miniprogram/custom-api.js';
import { formatValidationErrors, validateMiniprogramProject } from '../miniprogram/validator.js';

interface CreateBody {
  name?: string;
  prompt?: string;
  agent_id?: string;
  notes?: string;
}

interface SaveProjectFileBody {
  path?: string;
  content?: string;
}

interface MiniprogramUploadBody {
  file_name?: string;
  content_type?: string;
  data?: string;
}

interface ParsedMiniprogramUpload {
  fileName: string;
  contentType?: string;
  buffer: Buffer;
}

function sendOk(res: http.ServerResponse, data: unknown): void {
  sendJson(res, 200, { code: 0, data });
}

async function appSummary(project: miniprogramDB.Miniprogram) {
  const latestTask = await miniprogramDB.getLatestTaskByAppId(
    project.accountId,
    project.appId,
  );
  return {
    app_id: project.appId,
    name: project.name,
    summary: project.summary,
    description: project.description,
    status: project.status,
    publicUrl: project.publicUrl,
    lastError: project.lastError,
    agentId: project.agentId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    latestTask: latestTask == null
        ? null
        : {
            id: latestTask.id,
            app_id: latestTask.appId,
            taskType: latestTask.taskType,
            status: latestTask.status,
            prompt: latestTask.prompt,
            notes: latestTask.notes,
            errorMessage: latestTask.errorMessage,
            createdAt: latestTask.createdAt,
            updatedAt: latestTask.updatedAt,
          },
  };
}

function extractAppId(pathname: string): string {
  return path.basename(pathname);
}

function extractAppIdFromPublicPath(pathname: string): string {
  const rest = pathname.replace(/^\/miniprogram\//, '');
  return rest.split('/')[0] || '';
}

function extractAppIdFromApiPath(pathname: string): string {
  return pathname.split('/')[3] || '';
}

function extractFileIdFromApiPath(pathname: string): string {
  return decodeURIComponent(pathname.split('/')[5] || '');
}

async function requireMiniprogramProject(
  appId: string,
  ctx: RequestContext | null,
  options: { allowPublicReady?: boolean } = {},
): Promise<miniprogramDB.Miniprogram | null> {
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    return null;
  }
  if (ctx?.accountId) {
    if (project.accountId !== ctx.accountId) {
      throw new Error('Not authorized');
    }
    return project;
  }
  if (options.allowPublicReady && project.status === 'ready') {
    return project;
  }
  throw new Error('Unauthorized');
}

export async function handleMiniprogramCreate(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const body = await parseBody<CreateBody>(req);
  if (!body.prompt || body.prompt.trim().length < 10) {
    sendJson(res, 400, { code: 4001, error: 'prompt must be at least 10 characters' });
    return;
  }
  const agentId = body.agent_id || 'nova';
  const requestContent = JSON.stringify({
    type: 'miniprogram_request',
    name: body.name?.trim() || '',
    prompt: body.prompt.trim(),
    notes: body.notes?.trim() || '',
    agent_id: agentId,
    task_type: 'create',
  });
  const savedMsg = await messageDB.createMessage({
    accountId: authCtx.accountId,
    agentId,
    direction: 'inbound',
    contentType: 'miniprogram_request',
    content: requestContent,
  });
  sendToClientByAccountId(authCtx.accountId, {
    type: 'message',
    id: savedMsg.id,
    agent_id: agentId,
    direction: 'inbound',
    contentType: 'miniprogram_request',
    content: savedMsg.content,
    read: savedMsg.read,
    timestamp: savedMsg.createdAt,
  });
  const task = await miniprogramDB.createMiniprogramTask({
    accountId: authCtx.accountId,
    agentId,
    taskType: 'create',
    status: 'pending',
    prompt: body.prompt.trim(),
    notes: body.notes?.trim() || '',
    requestMessageId: savedMsg.id,
  });
  void dispatchMiniprogramCreateToAgent(authCtx.accountId, agentId, {
    name: body.name?.trim() || '',
    prompt: body.prompt.trim(),
    notes: body.notes?.trim() || '',
    taskId: task.id,
  }).catch((err) => logger.error(`dispatchMiniprogramCreateToAgent failed: ${err}`));
  sendOk(res, {
    taskId: task.id,
    taskType: task.taskType,
    status: 'creating',
    agentId,
  });
}

export async function handleMiniprogramList(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(parsedUrl.searchParams.get('page_size') || '20', 10);
  const result = await miniprogramDB.queryMiniprograms({ accountId: authCtx.accountId, page, pageSize });
  const items = await Promise.all(result.data.map((project) => appSummary(project)));
  sendOk(res, {
    items,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages: result.totalPages,
  });
}

export async function handleMiniprogramGet(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = extractAppId(parsedUrl.pathname);
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }
  sendOk(res, await appSummary(project));
}

export async function handleMiniprogramProjectFiles(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = extractAppIdFromApiPath(parsedUrl.pathname);
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const filePath = parsedUrl.searchParams.get('path')?.trim();
      if (filePath) {
        sendOk(res, readProjectTextFile(appId, filePath));
        return;
      }
      sendOk(res, {
        items: getProjectFileTree(appId),
      });
      return;
    }

    if (req.method === 'PUT') {
      const body = await parseBody<SaveProjectFileBody>(req);
      const filePath = body.path?.trim() || '';
      if (!filePath) {
        sendJson(res, 400, { code: 4001, error: 'path is required' });
        return;
      }
      if (typeof body.content !== 'string') {
        sendJson(res, 400, { code: 4001, error: 'content must be a string' });
        return;
      }
      sendOk(res, writeProjectTextFile(appId, filePath, body.content));
      return;
    }

    sendJson(res, 405, { code: 4050, error: 'Method not allowed' });
  } catch (error: any) {
    const message = error?.message || 'Project file request failed';
    if (
      message.startsWith('File not found:') ||
      message.startsWith('Miniprogram not found:')
    ) {
      sendJson(res, 404, { code: 4004, error: message });
      return;
    }
    if (
      message.startsWith('Invalid file path:') ||
      message.startsWith('Unsupported file path:') ||
      message.startsWith('Binary file is not supported:') ||
      message.startsWith('File is too large to edit:') ||
      message.startsWith('Not a file:') ||
      message.startsWith('Path escapes project directory:')
    ) {
      sendJson(res, 400, { code: 4001, error: message });
      return;
    }
    logger.error(`handleMiniprogramProjectFiles failed: ${message}`);
    sendJson(res, 500, { code: 5001, error: message });
  }
}

export async function handleMiniprogramFileUpload(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const appId = extractAppIdFromApiPath(parsedUrl.pathname);
  if (!requireMiniprogramGatewaySession(req, res, appId)) {
    return;
  }
  let project: miniprogramDB.Miniprogram | null = null;
  try {
    project = await requireMiniprogramProject(appId, ctx, { allowPublicReady: true });
  } catch (error) {
    sendJson(res, String(error) === 'Error: Not authorized' ? 403 : 401, {
      code: String(error) === 'Error: Not authorized' ? 4030 : 4010,
      error: String(error) === 'Error: Not authorized' ? 'Not authorized' : 'Unauthorized',
    });
    return;
  }
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }

  try {
    const upload = await parseMiniprogramUpload(req);
    const stored = await saveMiniprogramFile(
      project.appId,
      upload.buffer,
      upload.fileName,
      upload.contentType,
    );
    sendOk(res, {
      file_id: stored.fileId,
      file_name: stored.fileName,
      content_type: stored.contentType,
      file_size: stored.fileSize,
      url: stored.url,
      preview_url: stored.url,
      download_url: stored.downloadUrl,
      created_at: stored.createdAt,
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to upload file';
    if (message === 'Missing file data' || message === 'Missing file_name' || message === 'Invalid JSON') {
      sendJson(res, 400, { code: 4001, error: message });
      return;
    }
    logger.error(`handleMiniprogramFileUpload failed: ${message}`);
    sendJson(res, 500, { code: 5001, error: message });
  }
}

export async function handleMiniprogramFileRead(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const appId = extractAppIdFromApiPath(parsedUrl.pathname);
  if (!requireMiniprogramGatewaySession(req, res, appId)) {
    return;
  }
  let project: miniprogramDB.Miniprogram | null = null;
  try {
    project = await requireMiniprogramProject(appId, ctx, { allowPublicReady: true });
  } catch (error) {
    sendJson(res, String(error) === 'Error: Not authorized' ? 403 : 401, {
      code: String(error) === 'Error: Not authorized' ? 4030 : 4010,
      error: String(error) === 'Error: Not authorized' ? 'Not authorized' : 'Unauthorized',
    });
    return;
  }
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }

  try {
    const fileId = extractFileIdFromApiPath(parsedUrl.pathname);
    const file = readMiniprogramFile(project.appId, fileId);
    if (!file) {
      sendJson(res, 404, { code: 4004, error: `File not found: ${fileId}` });
      return;
    }
    const disposition = parsedUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', file.info.contentType);
    res.setHeader('Content-Length', file.info.fileSize);
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.info.fileName)}"`);
    res.writeHead(200);
    fs.createReadStream(file.filePath).pipe(res);
  } catch (error: any) {
    const message = error?.message || 'Failed to read file';
    if (message.startsWith('Invalid file id:')) {
      sendJson(res, 400, { code: 4001, error: message });
      return;
    }
    logger.error(`handleMiniprogramFileRead failed: ${message}`);
    sendJson(res, 500, { code: 5001, error: message });
  }
}

export async function handleMiniprogramFileDelete(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const appId = extractAppIdFromApiPath(parsedUrl.pathname);
  if (!requireMiniprogramGatewaySession(req, res, appId)) {
    return;
  }
  let project: miniprogramDB.Miniprogram | null = null;
  try {
    project = await requireMiniprogramProject(appId, ctx, { allowPublicReady: true });
  } catch (error) {
    sendJson(res, String(error) === 'Error: Not authorized' ? 403 : 401, {
      code: String(error) === 'Error: Not authorized' ? 4030 : 4010,
      error: String(error) === 'Error: Not authorized' ? 'Not authorized' : 'Unauthorized',
    });
    return;
  }
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }

  try {
    const fileId = extractFileIdFromApiPath(parsedUrl.pathname);
    const deleted = deleteMiniprogramFile(project.appId, fileId);
    if (!deleted) {
      sendJson(res, 404, { code: 4004, error: `File not found: ${fileId}` });
      return;
    }
    sendOk(res, { file_id: fileId, deleted: true });
  } catch (error: any) {
    const message = error?.message || 'Failed to delete file';
    if (message.startsWith('Invalid file id:')) {
      sendJson(res, 400, { code: 4001, error: message });
      return;
    }
    logger.error(`handleMiniprogramFileDelete failed: ${message}`);
    sendJson(res, 500, { code: 5001, error: message });
  }
}

export async function handleMiniprogramDelete(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = extractAppId(parsedUrl.pathname);
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }

  if (fs.existsSync(project.rootDir)) {
    fs.rmSync(project.rootDir, { recursive: true, force: true });
  }
  await miniprogramDB.deleteMiniprogram(appId);
  sendOk(res, { deleted: true, app_id: appId });
}

export async function handleMiniprogramRevise(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = parsedUrl.pathname.split('/')[3] || '';
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }
  const body = await parseBody<CreateBody>(req);
  if (!body.prompt || body.prompt.trim().length < 2) {
    sendJson(res, 400, { code: 4001, error: 'prompt is required' });
    return;
  }
  const agentId = body.agent_id || project.agentId;
  const content = JSON.stringify({
    type: 'miniprogram_edit_request',
    app_id: appId,
    prompt: body.prompt.trim(),
    notes: body.notes?.trim() || '',
    agent_id: agentId,
    task_type: 'update',
  });
  const savedMsg = await messageDB.createMessage({
    accountId: authCtx.accountId,
    agentId,
    direction: 'inbound',
    contentType: 'miniprogram_edit_request',
    content,
  });
  sendToClientByAccountId(authCtx.accountId, {
    type: 'message',
    id: savedMsg.id,
    agent_id: agentId,
    direction: 'inbound',
    contentType: 'miniprogram_edit_request',
    content: savedMsg.content,
    app_id: appId,
    read: savedMsg.read,
    timestamp: savedMsg.createdAt,
  });
  const task = await miniprogramDB.createMiniprogramTask({
    appId,
    accountId: authCtx.accountId,
    agentId,
    taskType: 'update',
    status: 'pending',
    prompt: body.prompt.trim(),
    notes: body.notes?.trim() || '',
    requestMessageId: savedMsg.id,
  });
  await miniprogramDB.updateMiniprogram(appId, { status: 'creating', lastError: '' });
  void dispatchMiniprogramEditToAgent(authCtx.accountId, appId, agentId, {
    prompt: body.prompt.trim(),
    notes: body.notes?.trim() || '',
    taskId: task.id,
  }).catch((err) => logger.error(`dispatchMiniprogramEditToAgent failed: ${err}`));
  sendOk(res, { app_id: appId, taskType: 'update', status: 'creating' });
}

export async function handleMiniprogramSend(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = parsedUrl.pathname.split('/')[3] || '';
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }

  const body = await parseBody<CreateBody>(req);
  const agentId = body.agent_id || project.agentId;
  await miniprogramDB.updateMiniprogram(appId, { agentId });

  const content = JSON.stringify({
    type: 'miniprogram_context_request',
    app_id: appId,
    name: project.name,
    summary: project.summary,
    agent_id: agentId,
  });
  const savedMsg = await messageDB.createMessage({
    accountId: authCtx.accountId,
    agentId,
    direction: 'inbound',
    contentType: 'miniprogram_context_request',
    content,
  });
  sendToClientByAccountId(authCtx.accountId, {
    type: 'message',
    id: savedMsg.id,
    agent_id: agentId,
    direction: 'inbound',
    contentType: 'miniprogram_context_request',
    content: savedMsg.content,
    app_id: appId,
    title: project.name,
    summary: project.summary,
    read: savedMsg.read,
    timestamp: savedMsg.createdAt,
  });

  void dispatchMiniprogramContextToAgent(authCtx.accountId, appId, agentId, {
    title: project.name,
    summary: project.summary,
  }).catch((err) => logger.error(`dispatchMiniprogramContextToAgent failed: ${err}`));

  sendOk(res, {
    app_id: appId,
    agentId,
    status: project.status,
  });
}

export async function handleMiniprogramBuild(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = parsedUrl.pathname.split('/')[3] || '';
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }

  await miniprogramDB.updateMiniprogram(appId, { status: 'creating', lastError: '' });
  const task = await miniprogramDB.createMiniprogramTask({
    appId,
    accountId: authCtx.accountId,
    agentId: project.agentId,
    taskType: 'build',
    status: 'running',
    prompt: '手动构建小程序项目',
    notes: '',
  });

  try {
    const result = await buildMiniprogramProject(appId);
    const reloadResult = await reloadMiniprogramCustomApi(project);
    const validation = validateMiniprogramProject(appId);
    if (!validation.ok) {
      const message = formatValidationErrors(validation);
      await miniprogramDB.updateMiniprogram(appId, { status: 'failed', lastError: message });
      await miniprogramDB.updateMiniprogramTask(task.id, {
        status: 'failed',
        errorMessage: message,
      });
      sendJson(res, 400, {
        code: 4002,
        error: message,
        validation,
      });
      return;
    }
    await miniprogramDB.updateMiniprogram(appId, { status: 'ready', lastError: '' });
    await miniprogramDB.updateMiniprogramTask(task.id, {
      status: 'completed',
      errorMessage: '',
    });
    sendOk(res, {
      app_id: appId,
      status: 'ready',
      taskId: task.id,
      build_output: result.build_output,
      dist_index_path: result.dist_index_path,
      custom_api_reloaded: reloadResult.reloaded,
      custom_api_pid: reloadResult.pid,
    });
  } catch (error: any) {
    const message = error?.message || 'Build failed';
    await miniprogramDB.updateMiniprogram(appId, { status: 'failed', lastError: message });
    await miniprogramDB.updateMiniprogramTask(task.id, {
      status: 'failed',
      errorMessage: message,
    });
    sendJson(res, 500, { code: 5001, error: message });
  }
}

export async function handleMiniprogramTasks(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = parsedUrl.pathname.split('/')[3] || '';
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }
  const items = await miniprogramDB.queryMiniprogramTasks(authCtx.accountId, appId);
  sendOk(res, {
    items: items.map((task) => ({
      id: task.id,
      app_id: task.appId,
      taskType: task.taskType,
      status: task.status,
      prompt: task.prompt,
      notes: task.notes,
      errorMessage: task.errorMessage,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
  });
}

export async function handleMiniprogramReload(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  const appId = parsedUrl.pathname.split('/')[3] || '';
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  if (project.accountId !== authCtx.accountId) {
    sendJson(res, 403, { code: 4030, error: 'Not authorized' });
    return;
  }
  try {
    const result = await reloadMiniprogramCustomApi(project);
    sendOk(res, {
      app_id: appId,
      entry: result.entry,
      reloaded: result.reloaded,
      pid: result.pid,
    });
  } catch (error: any) {
    sendJson(res, error?.statusCode || 500, {
      code: error?.statusCode || 5001,
      error: error?.message || 'Reload failed',
    });
  }
}

export async function handleMiniprogramCustomApiRequest(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const appId = parsedUrl.pathname.split('/')[3] || '';
  let project: miniprogramDB.Miniprogram | null = null;
  try {
    project = await requireMiniprogramProject(appId, ctx, { allowPublicReady: true });
  } catch (error) {
    sendJson(res, String(error) === 'Error: Not authorized' ? 403 : 401, {
      code: String(error) === 'Error: Not authorized' ? 4030 : 4010,
      error: String(error) === 'Error: Not authorized' ? 'Not authorized' : 'Unauthorized',
    });
    return;
  }
  if (!project) {
    sendJson(res, 404, { code: 4004, error: `Miniprogram not found: ${appId}` });
    return;
  }
  await handleMiniprogramCustomApi(project, req, parsedUrl, res);
}

export async function handleMiniprogramPublic(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
): Promise<void> {
  const appId = extractAppIdFromPublicPath(parsedUrl.pathname);
  if (!appId) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Not found</h1>');
    return;
  }
  const project = await miniprogramDB.getMiniprogramByAppId(appId);
  if (!project) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Project not found</h1>');
    return;
  }
  if (project.status !== 'ready') {
    res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Project is not ready</h1>');
    return;
  }
  issueMiniprogramSessionCookie(res, appId);
  if (parsedUrl.pathname === `/miniprogram/${appId}`) {
    const query = parsedUrl.searchParams.toString();
    const location = `/miniprogram/${appId}/${query ? `?${query}` : ''}`;
    res.writeHead(302, { Location: location });
    res.end();
    return;
  }
  const projectDir = getMiniprogramProjectDir(appId);
  const relative = parsedUrl.pathname.replace(`/miniprogram/${appId}`, '') || '/';
  const targetFile = relative === '/' ? path.join(projectDir, 'dist', 'index.html') : path.join(projectDir, 'dist', relative.replace(/^\/+/, ''));
  const safePrefix = path.resolve(path.join(projectDir, 'dist'));
  const safeFile = path.resolve(targetFile);
  if (safeFile !== safePrefix && !safeFile.startsWith(`${safePrefix}${path.sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Forbidden</h1>');
    return;
  }
  if (!fs.existsSync(safeFile) || !fs.statSync(safeFile).isFile()) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Project build artifact missing</h1>');
    return;
  }
  res.writeHead(200, { 'Content-Type': getMimeTypeFromFileName(safeFile) });
  res.end(fs.readFileSync(safeFile));
}

export function generateMiniprogramAppId(): string {
  return `mp_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

async function parseMiniprogramUpload(req: http.IncomingMessage): Promise<ParsedMiniprogramUpload> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const boundary = getMultipartBoundary(String(req.headers['content-type'] || ''));
        if (!boundary) {
          const payload = body.length === 0 ? {} as MiniprogramUploadBody : JSON.parse(body.toString('utf8')) as MiniprogramUploadBody;
          if (!payload.data) {
            throw new Error('Missing file data');
          }
          if (!payload.file_name) {
            throw new Error('Missing file_name');
          }
          resolve({
            fileName: payload.file_name,
            contentType: payload.content_type,
            buffer: Buffer.from(payload.data, 'base64'),
          });
          return;
        }

        const parts = body.toString('binary').split(`--${boundary}`);
        let fileName = '';
        let contentType = '';
        let fileBuffer: Buffer | null = null;

        for (const part of parts) {
          if (!part.includes('filename=')) {
            continue;
          }
          const fileNameMatch = part.match(/filename="([^"]+)"/);
          const contentTypeMatch = part.match(/Content-Type:\s*([^\r\n]+)/i);
          const dataStart = part.indexOf('\r\n\r\n');
          if (!fileNameMatch || dataStart < 0) {
            continue;
          }
          fileName = fileNameMatch[1];
          contentType = contentTypeMatch?.[1]?.trim() || '';
          const fileContent = part.slice(dataStart + 4, part.lastIndexOf('\r\n'));
          fileBuffer = Buffer.from(fileContent, 'binary');
          break;
        }

        if (!fileBuffer || fileName.trim() === '') {
          throw new Error('Missing file data');
        }

        resolve({
          fileName,
          contentType,
          buffer: fileBuffer,
        });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getMultipartBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(.+)$/);
  return match?.[1] || null;
}
