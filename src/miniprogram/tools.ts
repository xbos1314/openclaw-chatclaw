import { Type } from '@sinclair/typebox';
import path from 'node:path';
import { logger } from '../util/logger.js';
import * as miniprogramDB from '../db/miniprograms.js';
import * as messageDB from '../db/message.js';
import * as storage from './storage.js';
import { sendToClientByAccountId } from '../websocket/server.js';
import { buildMiniprogramProject } from './build.js';
import { reloadMiniprogramCustomApi } from './custom-api.js';
import { formatValidationErrors, validateMiniprogramProject } from './validator.js';

interface MiniprogramToolParams {
  action: 'create' | 'get' | 'update' | 'list' | 'list_files' | 'build' | 'set_ready' | 'set_failed' | 'create_task' | 'update_task' | 'validate_project';
  accountId?: string;
  task_id?: string;
  agentId?: string;
  app_id?: string;
  name?: string;
  prompt?: string;
  notes?: string;
  task_type?: 'create' | 'update' | 'build' | 'manual_update';
  task_status?: 'pending' | 'running' | 'completed' | 'failed';
  templateName?: string;
  page?: number;
  page_size?: number;
  subdir?: string;
  summary?: string;
  description?: string;
  sqlite_path?: string;
  public_url?: string;
  error?: string;
  result_message_id?: string;
  request_message_id?: string;
}

const ChatClawMiniprogramSchema = Type.Object({
  action: Type.Union([
    Type.Literal('create'),
    Type.Literal('get'),
    Type.Literal('update'),
    Type.Literal('list'),
    Type.Literal('list_files'),
    Type.Literal('build'),
    Type.Literal('set_ready'),
    Type.Literal('set_failed'),
    Type.Literal('create_task'),
    Type.Literal('update_task'),
    Type.Literal('validate_project'),
  ]),
  accountId: Type.Optional(Type.String()),
  task_id: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  app_id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  task_type: Type.Optional(Type.Union([
    Type.Literal('create'),
    Type.Literal('update'),
    Type.Literal('build'),
    Type.Literal('manual_update'),
  ])),
  task_status: Type.Optional(Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ])),
  templateName: Type.Optional(Type.String()),
  page: Type.Optional(Type.Number()),
  page_size: Type.Optional(Type.Number()),
  subdir: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  sqlite_path: Type.Optional(Type.String()),
  public_url: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  result_message_id: Type.Optional(Type.String()),
  request_message_id: Type.Optional(Type.String()),
});

export function registerChatClawMiniprogramTools(api: any): void {
  api.registerTool({
    name: 'chatclaw_miniprogram',
    description: 'ChatClaw 小程序工具：创建、查询、更新、列出项目',
    parameters: ChatClawMiniprogramSchema,
    execute: async (_toolCallId: string, params: MiniprogramToolParams) => {
      try {
        switch (params.action) {
          case 'create':
            return await handleCreate(params);
          case 'get':
            return await handleGet(params);
          case 'update':
            return await handleUpdate(params);
          case 'list':
            return await handleList(params);
          case 'list_files':
            return await handleListFiles(params);
          case 'build':
            return await handleBuild(params);
          case 'set_ready':
            return await handleSetReady(params);
          case 'set_failed':
            return await handleSetFailed(params);
          case 'create_task':
            return await handleCreateTask(params);
          case 'update_task':
            return await handleUpdateTask(params);
          case 'validate_project':
            return await handleValidateProject(params);
          default:
            return { ok: false, error: `Unknown action: ${params.action}` };
        }
      } catch (err: any) {
        logger.error(`chatclaw_miniprogram[${params.action}] failed: ${err}`);
        return { ok: false, error: err.message };
      }
    },
  });
}

async function handleCreate(params: MiniprogramToolParams): Promise<any> {
  const { accountId, agentId } = requireAccountContext(params, { requireAgentId: true });
  const appId = `mp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const projectPaths = storage.initializeProjectTemplate({
    appId,
    name: params.name,
    prompt: params.prompt,
    notes: params.notes,
  });
  const publicUrl = params.public_url || `/miniprogram/${appId}`;
  const project = await miniprogramDB.createMiniprogram({
    appId,
    accountId,
    agentId,
    name: params.name?.trim() || appId,
    rootDir: projectPaths.rootDir,
    appDir: projectPaths.appDir,
    dataDir: projectPaths.dataDir,
    distDir: projectPaths.distDir,
    publicPath: `/miniprogram/${appId}`,
    publicUrl,
    templateName: params.templateName || 'base',
  });
  if (params.task_id != null && params.task_id != '') {
    await miniprogramDB.updateMiniprogramTask(params.task_id, {
      appId,
      status: 'running',
    });
  }
  return {
    ok: true,
    project: formatProject(project, projectPaths),
  };
}

async function handleGet(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  return { ok: true, project: formatProject(project) };
}

async function handleUpdate(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  if (params.sqlite_path) {
    storage.assertPathInsideProject(project.appId, params.sqlite_path);
  }
  const updated = await miniprogramDB.updateMiniprogram(params.app_id, {
    name: params.name,
    summary: params.summary,
    description: params.description,
    sqlitePath: params.sqlite_path,
    publicUrl: params.public_url,
  });
  return { ok: true, project: formatProject(updated!) };
}

async function handleList(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  const result = await miniprogramDB.queryMiniprograms({
    accountId,
    page: params.page || 1,
    pageSize: params.page_size || 20,
  });
  return {
    ok: true,
    page: result.page,
    page_size: result.pageSize,
    total: result.total,
    items: result.data.map((project) => formatProject(project)),
  };
}

async function handleListFiles(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  const files = storage.listProjectFiles(project.appId, params.subdir || '');
  return {
    ok: true,
    app_id: project.appId,
    base_dir: params.subdir ? path.join(project.rootDir, params.subdir) : project.rootDir,
    files,
  };
}

async function handleBuild(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  const result = await buildMiniprogramProject(project.appId);
  const reloadResult = await reloadMiniprogramCustomApi(project);
  const validation = validateMiniprogramProject(project.appId);
  if (!validation.ok) {
    const message = formatValidationErrors(validation);
    await miniprogramDB.updateMiniprogram(project.appId, {
      status: 'failed',
      lastError: message,
    });
    return {
      ok: false,
      error: message,
      validation,
    };
  }
  await miniprogramDB.updateMiniprogram(project.appId, {
    status: 'ready',
    lastError: '',
  });
  return {
    ok: true,
    app_id: project.appId,
    dist_index_path: result.dist_index_path,
    install_output: result.install_output,
    build_output: result.build_output,
    custom_api_reloaded: reloadResult.reloaded,
    custom_api_pid: reloadResult.pid,
  };
}

async function handleSetReady(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  const validation = validateMiniprogramProject(project.appId);
  if (!validation.ok) {
    const message = formatValidationErrors(validation);
    await miniprogramDB.updateMiniprogram(project.appId, {
      status: 'failed',
      lastError: message,
    });
    return {
      ok: false,
      error: message,
      validation,
    };
  }
  const updated = await miniprogramDB.updateMiniprogram(project.appId, {
    status: 'ready',
    summary: params.summary ?? project.summary,
    lastError: '',
  });
  const targetTask = params.task_id != null && params.task_id != ''
    ? await miniprogramDB.getMiniprogramTaskById(params.task_id)
    : await miniprogramDB.getLatestTaskByAppId(project.accountId, project.appId);
  const nextVersion = await miniprogramDB.getNextMiniprogramRevisionVersion(project.appId);
  await miniprogramDB.createMiniprogramRevision({
    appId: project.appId,
    accountId: project.accountId,
    agentId: project.agentId,
    version: nextVersion,
    changeSummary: params.summary ?? project.summary,
    promptSnapshot: targetTask?.prompt ?? '',
    createdAt: Date.now(),
  });
  const payload = {
    type: 'miniprogram_result',
    app_id: updated!.appId,
    name: updated!.name,
    summary: updated!.summary,
    status: updated!.status,
    public_url: updated!.publicUrl,
    agent_id: updated!.agentId,
  };
  const savedMsg = await messageDB.createMessage({
    accountId: project.accountId,
    agentId: project.agentId,
    direction: 'outbound',
    contentType: 'miniprogram_result',
    content: JSON.stringify(payload),
  });
  sendToClientByAccountId(project.accountId, {
    type: 'message',
    id: savedMsg.id,
    agent_id: project.agentId,
    direction: 'outbound',
    contentType: 'miniprogram_result',
    content: savedMsg.content,
    app_id: project.appId,
    title: updated!.name,
    summary: updated!.summary,
    timestamp: savedMsg.createdAt,
    read: savedMsg.read,
  });
  if (targetTask != null) {
    await miniprogramDB.updateMiniprogramTask(targetTask.id, {
      status: 'completed',
      resultMessageId: savedMsg.id,
      errorMessage: '',
    });
  }
  return { ok: true, project: formatProject(updated!) };
}

async function handleSetFailed(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  const updated = await miniprogramDB.updateMiniprogram(project.appId, {
    status: 'failed',
    lastError: params.error || 'Unknown error',
  });
  const targetTask = params.task_id != null && params.task_id != ''
    ? await miniprogramDB.getMiniprogramTaskById(params.task_id)
    : await miniprogramDB.getLatestTaskByAppId(project.accountId, project.appId);
  if (targetTask != null) {
    await miniprogramDB.updateMiniprogramTask(targetTask.id, {
      status: 'failed',
      errorMessage: params.error || 'Unknown error',
    });
  }
  return { ok: true, project: formatProject(updated!) };
}

async function handleCreateTask(params: MiniprogramToolParams): Promise<any> {
  const { accountId, agentId } = requireAccountContext(params, { requireAgentId: true });
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  const task = await miniprogramDB.createMiniprogramTask({
    appId: project.appId,
    accountId: project.accountId,
    agentId,
    taskType: params.task_type || 'manual_update',
    status: params.task_status || 'running',
    prompt: params.prompt || '智能体开始执行项目修改',
    notes: params.notes || '',
    requestMessageId: params.request_message_id || '',
  });
  return {
    ok: true,
    task: formatTask(task),
  };
}

async function handleUpdateTask(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.task_id) {
    return { ok: false, error: 'task_id is required' };
  }
  const task = await miniprogramDB.getMiniprogramTaskById(params.task_id);
  if (!task) {
    return { ok: false, error: `Task not found: ${params.task_id}` };
  }
  if (task.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  const updated = await miniprogramDB.updateMiniprogramTask(params.task_id, {
    appId: params.app_id,
    taskType: params.task_type,
    prompt: params.prompt,
    notes: params.notes,
    status: params.task_status,
    requestMessageId: params.request_message_id,
    resultMessageId: params.result_message_id,
    errorMessage: params.error,
  });
  return {
    ok: true,
    task: updated ? formatTask(updated) : null,
  };
}

async function handleValidateProject(params: MiniprogramToolParams): Promise<any> {
  const { accountId } = requireAccountContext(params);
  if (!params.app_id) {
    return { ok: false, error: 'app_id is required' };
  }
  const project = await miniprogramDB.getMiniprogramByAppId(params.app_id);
  if (!project) {
    return { ok: false, error: `Project not found: ${params.app_id}` };
  }
  if (project.accountId !== accountId) {
    return { ok: false, error: 'Not authorized' };
  }
  const validation = validateMiniprogramProject(project.appId);
  if (!validation.ok) {
    return {
      ok: false,
      error: formatValidationErrors(validation),
      validation,
    };
  }
  return {
    ok: true,
    validation,
  };
}

function requireAccountContext(
  params: MiniprogramToolParams,
  options: { requireAgentId?: boolean } = {},
): { accountId: string; agentId: string } {
  if (!params.accountId) {
    throw new Error('accountId is required');
  }
  const accountId = params.accountId.trim();
  if (!accountId.startsWith('chatclaw_')) {
    throw new Error(`Invalid accountId: ${params.accountId}`);
  }
  const agentId = params.agentId?.trim() || 'nova';
  if (options.requireAgentId && !params.agentId?.trim()) {
    throw new Error('agentId is required');
  }
  return { accountId, agentId };
}

function formatProject(project: miniprogramDB.Miniprogram, projectPaths?: storage.MiniprogramProjectPaths) {
  const paths = projectPaths ?? storage.getMiniprogramProjectPaths(project.appId);
  return {
    app_id: project.appId,
    name: project.name,
    summary: project.summary,
    status: project.status,
    agent_id: project.agentId,
    public_url: project.publicUrl,
    project_dir: project.rootDir,
    app_dir: paths.appDir,
    docs_dir: paths.docsDir,
    data_dir: paths.dataDir,
    dist_dir: paths.distDir,
    server_dir: paths.serverDir,
    readme_path: paths.readmePath,
    sqlite_path: project.sqlitePath,
    last_error: project.lastError,
  };
}

function formatTask(task: miniprogramDB.MiniprogramTask) {
  return {
    id: task.id,
    app_id: task.appId,
    account_id: task.accountId,
    agent_id: task.agentId,
    task_type: task.taskType,
    status: task.status,
    prompt: task.prompt,
    notes: task.notes,
    request_message_id: task.requestMessageId,
    result_message_id: task.resultMessageId,
    error_message: task.errorMessage,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}
