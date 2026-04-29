import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_DIR = path.join(os.homedir(), '.openclaw', 'openclaw-chatclaw', 'miniprogram');

export interface MiniprogramProjectPaths {
  rootDir: string;
  appDir: string;
  docsDir: string;
  dataDir: string;
  distDir: string;
  serverDir: string;
  readmePath: string;
}

interface MiniprogramServerConfig {
  enabled?: boolean;
}

export interface MiniprogramTemplateInput {
  appId: string;
  name?: string;
  prompt?: string;
  notes?: string;
}

export interface ProjectFileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: ProjectFileTreeNode[];
}

export interface ProjectTextFile {
  path: string;
  content: string;
  size: number;
  updatedAt: number;
}

export function getMiniprogramRootDir(): string {
  return ROOT_DIR;
}

export function getMiniprogramProjectDir(appId: string): string {
  return path.join(ROOT_DIR, appId);
}

export function getMiniprogramProjectPaths(appId: string): MiniprogramProjectPaths {
  const rootDir = getMiniprogramProjectDir(appId);
  return {
    rootDir,
    appDir: path.join(rootDir, 'app'),
    docsDir: path.join(rootDir, 'docs'),
    dataDir: path.join(rootDir, 'data'),
    distDir: path.join(rootDir, 'dist'),
    serverDir: path.join(rootDir, 'server'),
    readmePath: path.join(rootDir, 'README.md'),
  };
}

export function getDefaultServerEntryTemplate(): string {
  return `// 项目后端入口必须直接导出 handle(req, ctx)。
// 注意：这里的 req.path 是网关裁掉 /api/miniprogram/{appId} 之后的子路径。
// 例如外部请求 /api/miniprogram/{appId}/hello，进入这里应匹配 /hello。
// 不要在这里创建 express()/Router()/app.listen()，也不要写完整网关前缀路由。
export async function handle(req, ctx) {
  if (req.path === '/hello' && req.method === 'GET') {
    return {
      status: 200,
      body: {
        ok: true,
        appId: ctx.appId,
        message: 'Hello from custom API',
      },
    };
  }

  return {
    status: 404,
    body: {
      error: 'Custom API not found',
      path: req.path,
      method: req.method,
    },
  };
}
`;
}

export function getServerConfigPath(appId: string): string {
  return path.join(getMiniprogramProjectPaths(appId).serverDir, 'openclaw.server.json');
}

export function isMiniprogramCustomApiEnabled(appId: string): boolean {
  const paths = getMiniprogramProjectPaths(appId);
  const configPath = getServerConfigPath(appId);
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as MiniprogramServerConfig;
      return config.enabled === true;
    } catch {
      return false;
    }
  }
  const entryPath = path.join(paths.serverDir, 'index.js');
  if (!fs.existsSync(entryPath)) {
    return false;
  }
  const current = fs.readFileSync(entryPath, 'utf8').trim();
  const defaultTemplate = getDefaultServerEntryTemplate().trim();
  return current !== defaultTemplate;
}

export function ensureMiniprogramRoot(): void {
  if (!fs.existsSync(ROOT_DIR)) {
    fs.mkdirSync(ROOT_DIR, { recursive: true });
  }
}

export function ensureProjectSkeleton(appId: string): MiniprogramProjectPaths {
  ensureMiniprogramRoot();
  const paths = getMiniprogramProjectPaths(appId);
  for (const dir of [paths.rootDir, paths.appDir, paths.docsDir, paths.dataDir, paths.distDir, paths.serverDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  ensureFile(paths.readmePath, `# ${appId}\n\n由 ChatClaw 小程序工具初始化。\n`);
  ensureFile(path.join(paths.docsDir, 'requirement.md'), '# Requirement\n\n');
  ensureFile(path.join(paths.docsDir, 'architecture.md'), '# Architecture\n\n');
  ensureFile(path.join(paths.docsDir, 'database.md'), '# Database\n\n');
  ensureFile(path.join(paths.docsDir, 'api.md'), '# API\n\n');
  ensureFile(path.join(paths.docsDir, 'deploy.md'), '# Deploy\n\n');
  return paths;
}

export function initializeProjectTemplate(input: MiniprogramTemplateInput): MiniprogramProjectPaths {
  const paths = ensureProjectSkeleton(input.appId);
  const displayName = input.name?.trim() || input.appId;
  const prompt = input.prompt?.trim() || '待补充需求';
  const notes = input.notes?.trim() || '无';
  const escapedName = escapeHtml(displayName);
  const escapedPrompt = escapeHtml(prompt);
  const escapedNotes = escapeHtml(notes);

  writeFile(
    paths.readmePath,
    `# ${displayName}

这是一个由 ChatClaw 网关初始化的小程序项目。

## 项目信息

- App ID: \`${input.appId}\`
- 技术栈: Node + Vue + SQLite
- 访问路径: \`/miniprogram/${input.appId}\`
- 项目目录: \`${paths.rootDir}\`

## 当前状态

项目已完成初始化，包含：

- 可直接访问的 \`dist/index.html\` 占位页面
- 基础 Vue 源码目录 \`app/\`
- 需求、架构、数据库、接口、部署文档
- 运行时数据目录 \`data/\`
- 自定义 API 入口目录 \`server/\`

## 初始需求

${prompt}

## 备注

${notes}

## 开发约束

1. 所有代码、文档、构建产物、数据库文件都必须保留在当前项目目录内。
2. 对外访问统一走网关：\`/miniprogram/${input.appId}\`。
3. 项目默认数据接口前缀为：\`/api/miniprogram/${input.appId}\`。
4. 网关内置文件上传接口：\`POST /api/miniprogram/${input.appId}/file/upload\`。
5. 网关内置文件预览/下载接口：\`GET /api/miniprogram/${input.appId}/file/{fileId}\`。
6. 网关内置文件删除接口：\`DELETE /api/miniprogram/${input.appId}/file/{fileId}\`。
   上传请求体示例：
   \`\`\`json
   {
     "file_name": "avatar.png",
     "content_type": "image/png",
     "data": "<base64>"
   }
   \`\`\`
   上传成功响应示例：
   \`\`\`json
   {
     "code": 0,
     "data": {
       "file_id": "uuid.png",
       "file_name": "avatar.png",
       "content_type": "image/png",
       "file_size": 12345,
       "url": "/api/miniprogram/${input.appId}/file/uuid.png",
       "preview_url": "/api/miniprogram/${input.appId}/file/uuid.png",
       "download_url": "/api/miniprogram/${input.appId}/file/uuid.png?download=1",
       "created_at": 1712345678901
     }
   }
   \`\`\`
7. 上述 \`/file/*\` 接口在项目发布且状态为 \`ready\` 后可访问，不检查 token；但浏览器必须先访问当前小程序公开页面以获得小程序会话 Cookie。该 Cookie 的 Path 作用域为 \`/api/miniprogram/${input.appId}/\`，可供后续其他网关保留接口复用，且请求的 \`Referer\` 必须来自当前小程序页面。
8. 项目默认启用自定义 API；如需关闭，可将 \`server/openclaw.server.json\` 中的 \`enabled\` 设为 \`false\`。
9. 自定义 API 统一从 \`server/index.js\` 导出 \`handle(req, ctx)\`。
10. \`server/index.js\` 内只处理子路径：例如外部 \`/api/miniprogram/${input.appId}/qrcode/generate\`，在后端中应匹配 \`req.path === '/qrcode/generate'\`。
11. 禁止在 \`server/\` 中创建独立 Express/Node 服务，禁止 \`express()\`、\`Router()\`、\`app.listen()\`，也禁止写 \`/api/miniprogram/${input.appId}/...\` 这种全路径路由。
12. 前端功能和页面修改应优先修改 \`app/\`；后端接口和业务逻辑应优先修改 \`server/\`。
13. 前端访问项目后端时，必须统一使用 \`/api/miniprogram/${input.appId}/...\` 前缀，禁止直接写 \`/api/xxx\` 裸路径。
14. 文件列表、业务表关联、权限语义和删除前校验必须由项目自己维护；网关只负责文件上传、文件流返回和物理删除。
15. \`dist/\` 是构建产物目录，默认不作为源码目录直接编辑；修改前端源码后应重新构建生成 \`dist/\`。
16. 若后续由智能体继续完善，需要同步更新 \`README.md\` 和 \`docs/\` 文档。
`,
  );

  writeFile(
    path.join(paths.docsDir, 'requirement.md'),
    `# Requirement

## App Info

- App ID: \`${input.appId}\`
- Name: ${displayName}

## User Prompt

${prompt}

## Notes

${notes}

## Delivery Goal

创建后即可通过浏览器访问，优先适配移动端；后续由智能体在当前目录内持续迭代。
`,
  );

  writeFile(
    path.join(paths.docsDir, 'architecture.md'),
    `# Architecture

## Stack

- Frontend: Vue 3
- Runtime access: Gateway static hosting from \`dist/\`
- Backend: Custom API worker from \`server/\`

## Suggested Structure

- \`app/\`: Node + Vue 源码与构建配置
- \`dist/\`: 可直接被网关托管访问的静态产物
- \`data/\`: 项目运行数据目录（按需使用）
- \`server/\`: 项目自定义 API 入口与后端逻辑
- \`docs/\`: 项目文档

## Notes

初始化阶段已提供一个可访问的静态预览页，后续可替换为正式构建结果。前端源码应维护在 \`app/\`，后端源码应维护在 \`server/\`，\`dist/\` 仅作为构建产物目录使用。项目后端不要创建独立 Express 服务，而应直接在 \`server/index.js\` 的 \`handle(req, ctx)\` 中按 \`req.path\` 子路径处理请求。
`,
  );

  writeFile(
    path.join(paths.docsDir, 'database.md'),
    `# Database

## Data Directory

- 项目运行数据默认放在 \`data/\`
- 如需附件上传，网关会把文件物理存储到 \`data/files/\`
- 网关不再为小程序提供内置表结构或默认 CRUD 接口
- 如需存储数据，请在项目自定义 API 中自行定义文件、SQLite 或其他存储方案

## Constraint

如需扩展数据结构，数据库文件必须保留在当前项目目录内。若使用网关内置文件上传能力，项目自身仍需保存文件元数据、业务表关联和删除语义。
`,
  );

  writeFile(
    path.join(paths.docsDir, 'api.md'),
    `# API

## Custom API Entry

- \`server/index.js\` 必须导出 \`handle(req, ctx)\`
- \`server/openclaw.server.json\` 默认 \`enabled=true\`，项目后端 worker 会随自定义接口一起启用
- 项目自定义接口统一挂在 \`/api/miniprogram/${input.appId}/*\`
- 平台保留接口优先级高于项目自定义接口
- 传入 \`handle(req, ctx)\` 的 \`req.path\` 已去掉前缀 \`/api/miniprogram/${input.appId}\`
- 例如外部请求 \`POST /api/miniprogram/${input.appId}/qrcode/generate\`，后端中应匹配 \`req.method === 'POST' && req.path === '/qrcode/generate'\`
- 禁止在 \`server/index.js\` 中使用 \`express()\`、\`Router()\`、\`app.listen()\` 或写完整网关路径

## Frontend Call Rule

- 前端请求项目后端时，必须使用 \`/api/miniprogram/${input.appId}/...\`
- 推荐在前端维护：\`const baseApi = '/api/miniprogram/${input.appId}'\`
- 自定义接口应写成：\`fetch(baseApi + '/parse')\`
- 禁止直接写：\`fetch('/api/parse')\`
- 网关保留文件接口统一走：\`baseApi + '/file/...'\`
- 上传接口：\`POST baseApi + '/file/upload'\`
- 文件预览：\`GET baseApi + '/file/{fileId}'\`
- 文件下载：\`GET baseApi + '/file/{fileId}?download=1'\`
- 文件物理删除：\`DELETE baseApi + '/file/{fileId}'\`
- 上传请求体 JSON 示例：
  \`\`\`json
  {
    "file_name": "avatar.png",
    "content_type": "image/png",
    "data": "<base64>"
  }
  \`\`\`
- 上传成功响应 JSON 示例：
  \`\`\`json
  {
    "code": 0,
    "data": {
      "file_id": "uuid.png",
      "file_name": "avatar.png",
      "content_type": "image/png",
      "file_size": 12345,
      "url": "/api/miniprogram/${input.appId}/file/uuid.png",
      "preview_url": "/api/miniprogram/${input.appId}/file/uuid.png",
      "download_url": "/api/miniprogram/${input.appId}/file/uuid.png?download=1",
      "created_at": 1712345678901
    }
  }
  \`\`\`
- 上述 \`/file/*\` 接口在项目为 \`ready\` 时可访问，不检查 token；但浏览器必须先访问当前小程序公开页面以获得小程序会话 Cookie。该 Cookie 的 Path 作用域为 \`/api/miniprogram/${input.appId}/\`，且请求的 \`Referer\` 必须来自当前小程序页面
- 上传成功后，项目自身必须保存 \`file_id\`、\`file_name\`、\`content_type\`、\`file_size\`、\`url\` 等元数据，用于列表、业务关联和后续删除
- \`/file/*\` 属于网关保留能力，不需要在 \`server/index.js\` 中重复实现

## Public Entry

- \`GET /miniprogram/${input.appId}\`

## Notes

当前默认模板支持公开访问，前端应优先使用当前网关下的统一接口前缀访问项目后端；若需要登录、鉴权、会话能力，应由项目自身在 \`server/\` 中维护。不要直接修改 \`dist/\` 来实现前端功能变更，也不要绕开 \`/api/miniprogram/${input.appId}/...\` 前缀。\`/file/*\` 接口在项目为 \`ready\` 时可访问，不检查 token；但浏览器必须先访问当前小程序公开页面以获得小程序会话 Cookie。该 Cookie 的 Path 作用域为 \`/api/miniprogram/${input.appId}/\`，且请求的 \`Referer\` 必须来自当前小程序页面。文件管理列表、业务表关联和删除前校验应由项目自己的后端或数据库维护，网关只负责文件上传、文件流返回和物理删除。
`,
  );

  writeFile(
    path.join(paths.docsDir, 'deploy.md'),
    `# Deploy

## Public URL

\`/miniprogram/${input.appId}\`

## Delivery Rule

1. 网关直接托管 \`dist/\` 目录。
2. 前端源码应优先维护在 \`app/\`，不要直接编辑 \`dist/\`。
3. 若修改前端源码，需要同步生成或更新 \`dist/\`。
4. 所有依赖、构建配置和项目文件必须留在当前项目目录中。
`,
  );

  writeFile(
    path.join(paths.serverDir, 'package.json'),
    `{
  "name": "${sanitizePackageName(input.appId)}-server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "check": "node index.js"
  },
  "dependencies": {}
}
`,
  );

  writeFile(
    path.join(paths.serverDir, 'openclaw.server.json'),
    `{
  "enabled": true
}
`,
  );

  writeFile(
    path.join(paths.serverDir, 'index.js'),
    getDefaultServerEntryTemplate(),
  );

  writeFile(
    path.join(paths.appDir, 'package.json'),
    `{
  "name": "${sanitizePackageName(input.appId)}",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "vue": "^3.5.13"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "vite": "^5.4.10"
  }
}
`,
  );

  writeFile(
    path.join(paths.appDir, 'vite.config.js'),
    `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: '../dist',
    emptyOutDir: false,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
`,
  );

  writeFile(
    path.join(paths.appDir, 'index.html'),
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedName}</title>
    <script type="module" src="/src/main.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`,
  );

  ensureDir(path.join(paths.appDir, 'src'));
  writeFile(
    path.join(paths.appDir, 'src', 'main.js'),
    `import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
`,
  );

  writeFile(
    path.join(paths.appDir, 'src', 'App.vue'),
    `<script setup>
import { onMounted, reactive } from 'vue';

const appId = '${input.appId}';
const name = '${escapeJsString(displayName)}';
const prompt = '${escapeJsString(prompt)}';
const notes = '${escapeJsString(notes)}';
const baseApi = '/api/miniprogram/' + appId;

const state = reactive({
  loading: false,
  error: '',
  response: null,
});

async function callHello() {
  state.loading = true;
  state.error = '';
  try {
    const response = await fetch(baseApi + '/hello');
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || '调用失败');
    }
    state.response = result;
  } catch (error) {
    state.error = error.message || '调用失败';
  } finally {
    state.loading = false;
  }
}

onMounted(async () => {
  try {
    await callHello();
  } catch (error) {
    state.error = error.message || '初始化失败';
  }
});
</script>

<template>
  <main class="page">
    <section class="hero">
      <p class="badge">ChatClaw Mini Program</p>
      <h1>{{ name }}</h1>
      <p class="summary">项目已初始化。网关不再提供内置数据接口，当前页面只演示如何调用项目自定义 API。</p>
    </section>

    <section class="grid">
      <article class="card">
        <h2>初始需求</h2>
        <p>{{ prompt }}</p>
      </article>
      <article class="card">
        <h2>访问信息</h2>
        <ul>
          <li>App ID: {{ appId }}</li>
          <li>入口路径: /miniprogram/{{ appId }}</li>
          <li>示例接口: /api/miniprogram/{{ appId }}/hello</li>
          <li>文件上传: /api/miniprogram/{{ appId }}/file/upload</li>
        </ul>
      </article>
    </section>

    <section class="card">
      <div class="section-head">
        <div>
          <h2>自定义 API 示例</h2>
          <p class="hint">默认模板只保留自定义后端能力。请在 \`server/index.js\` 中扩展业务接口。</p>
        </div>
        <button class="ghost-button" type="button" @click="callHello">重新调用</button>
      </div>
      <div class="actions">
        <button class="primary-button" type="button" :disabled="state.loading" @click="callHello">
          {{ state.loading ? '调用中...' : '调用 /hello' }}
        </button>
        <p class="hint">备注：{{ notes }}</p>
      </div>
      <p v-if="state.error" class="error">{{ state.error }}</p>
      <pre class="empty-state">{{ state.response ? JSON.stringify(state.response, null, 2) : '等待调用结果...' }}</pre>
    </section>
  </main>
</template>
`,
  );

  writeFile(
    path.join(paths.appDir, 'src', 'style.css'),
    `:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
  background: #f4f7fb;
  color: #162033;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at top right, rgba(29, 122, 255, 0.16), transparent 28%),
    linear-gradient(180deg, #f8fbff 0%, #eef3f8 100%);
}

.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 16px 40px;
}

.hero {
  padding: 24px;
  border-radius: 24px;
  background: linear-gradient(135deg, #0f5bd8, #28a7ff);
  color: #fff;
  box-shadow: 0 20px 40px rgba(22, 57, 115, 0.18);
}

.badge {
  display: inline-block;
  margin: 0 0 12px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  font-size: 12px;
}

h1,
h2,
p,
ul {
  margin: 0;
}

.summary {
  margin-top: 12px;
  line-height: 1.6;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.card {
  margin-top: 16px;
  padding: 20px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 12px 30px rgba(47, 71, 112, 0.1);
  backdrop-filter: blur(10px);
}

.card p,
.card li {
  margin-top: 10px;
  line-height: 1.7;
  color: #41506a;
}

.card ul {
  padding-left: 18px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.hint {
  margin-top: 8px;
  color: #64748b;
  font-size: 14px;
}

.form-grid {
  display: grid;
  gap: 14px;
  margin-top: 18px;
}

.field {
  display: grid;
  gap: 8px;
  font-size: 14px;
  color: #334155;
}

.required {
  margin-left: 4px;
  color: #dc2626;
  font-style: normal;
}

.field input,
.field textarea {
  width: 100%;
  border: 1px solid #d7dfeb;
  border-radius: 14px;
  padding: 12px 14px;
  font: inherit;
  background: #f8fbff;
}

.switch-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}

.actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.primary-button,
.ghost-button,
.danger-button {
  border: none;
  border-radius: 999px;
  padding: 10px 16px;
  font: inherit;
  cursor: pointer;
}

.button-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.primary-button {
  background: #2563eb;
  color: #fff;
}

.ghost-button {
  background: #e8f0ff;
  color: #2563eb;
}

.danger-button {
  background: #fee2e2;
  color: #dc2626;
}

.primary-button:disabled,
.danger-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.count {
  color: #2563eb;
  font-size: 14px;
  font-weight: 600;
}

.record-list {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}

.record-item {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
  padding: 16px;
  border-radius: 18px;
  background: #f8fbff;
}

.record-main h3 {
  margin: 0;
  font-size: 16px;
}

.record-main p {
  margin-top: 8px;
}

.empty-state {
  margin-top: 18px;
  padding: 20px;
  border-radius: 18px;
  text-align: center;
  color: #64748b;
  background: #f8fbff;
}

.error {
  margin-top: 14px;
  color: #dc2626;
}

@media (max-width: 640px) {
  .actions,
  .section-head,
  .record-item {
    flex-direction: column;
  }

  .button-row,
  .primary-button,
  .ghost-button,
  .danger-button {
    width: 100%;
  }
}
`,
  );

  writeFile(
    path.join(paths.distDir, 'index.html'),
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedName}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top right, rgba(29, 122, 255, 0.18), transparent 26%),
          linear-gradient(180deg, #f8fbff 0%, #eef3f8 100%);
        color: #162033;
      }
      .page {
        max-width: 960px;
        margin: 0 auto;
        padding: 24px 16px 48px;
      }
      .hero {
        padding: 24px;
        border-radius: 24px;
        background: linear-gradient(135deg, #0f5bd8, #28a7ff);
        color: #fff;
        box-shadow: 0 20px 40px rgba(22, 57, 115, 0.18);
      }
      .badge {
        display: inline-block;
        margin-bottom: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,.18);
        font-size: 12px;
      }
      .card {
        margin-top: 16px;
        padding: 20px;
        border-radius: 20px;
        background: rgba(255,255,255,.9);
        box-shadow: 0 12px 30px rgba(47, 71, 112, 0.1);
      }
      .muted {
        color: #4a5974;
        line-height: 1.7;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }
      code {
        padding: 2px 6px;
        border-radius: 8px;
        background: #eef3fb;
      }
      .footer { margin-top: 20px; font-size: 13px; color: #71809b; }
      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }
      .hint { margin-top: 8px; color: #64748b; font-size: 14px; line-height: 1.6; }
      .form-grid, .record-list { display: grid; gap: 14px; margin-top: 18px; }
      .field { display: grid; gap: 8px; font-size: 14px; color: #334155; }
      .required { margin-left: 4px; color: #dc2626; font-style: normal; }
      .field input, .field textarea {
        width: 100%;
        border: 1px solid #d7dfeb;
        border-radius: 14px;
        padding: 12px 14px;
        font: inherit;
        background: #f8fbff;
      }
      .switch-field { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; }
      .actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-top: 16px;
      }
      .primary-button, .ghost-button, .danger-button {
        border: 0;
        border-radius: 999px;
        padding: 10px 16px;
        font: inherit;
        cursor: pointer;
      }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .primary-button { background: #2563eb; color: #fff; }
      .ghost-button { background: #e8f0ff; color: #2563eb; }
      .danger-button { background: #fee2e2; color: #dc2626; }
      .primary-button:disabled, .danger-button:disabled { opacity: .6; cursor: default; }
      .count { color: #2563eb; font-size: 14px; font-weight: 600; }
      .record-item {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: flex-start;
        padding: 16px;
        border-radius: 18px;
        background: #f8fbff;
      }
      .record-main h3 { margin: 0; font-size: 16px; }
      .record-main p { margin-top: 8px; }
      .empty-state {
        margin-top: 18px;
        padding: 20px;
        border-radius: 18px;
        text-align: center;
        color: #64748b;
        background: #f8fbff;
      }
      .error { margin-top: 14px; color: #dc2626; }
      @media (max-width: 640px) {
        .actions, .section-head, .record-item { flex-direction: column; }
        .button-row, .primary-button, .ghost-button, .danger-button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <div class="badge">ChatClaw Mini Program</div>
        <h1>${escapedName}</h1>
        <p class="muted" style="color: rgba(255,255,255,.92);">项目已由网关完成初始化。默认模板不再依赖内置数据接口，当前页面仅演示项目自定义 API。</p>
      </section>
      <section class="grid">
        <article class="card">
          <h2>初始需求</h2>
          <p class="muted">${escapedPrompt}</p>
        </article>
        <article class="card">
          <h2>访问信息</h2>
          <p class="muted">App ID：<code>${input.appId}</code></p>
          <p class="muted">公开入口：<code>/miniprogram/${input.appId}</code></p>
          <p class="muted">示例接口：<code>/api/miniprogram/${input.appId}/hello</code></p>
        </article>
      </section>
      <section class="card">
        <div class="section-head">
          <div>
            <h2>自定义 API 示例</h2>
            <p class="hint">请在 <code>server/index.js</code> 中扩展业务接口，前端统一通过 <code>/api/miniprogram/${input.appId}/*</code> 访问。</p>
          </div>
          <button id="callButton" class="ghost-button" type="button">调用 /hello</button>
        </div>
        <div class="actions">
          <button id="callPrimaryButton" class="primary-button" type="button">调用 /hello</button>
          <p class="hint">备注：${escapedNotes}</p>
        </div>
        <p id="errorText" class="error" hidden></p>
        <pre id="responseBox" class="empty-state">等待调用结果...</pre>
      </section>
      <p class="footer">如需正式功能，请继续让智能体在当前项目目录内完善 <code>app/</code>、<code>docs/</code> 和 <code>dist/</code>。</p>
    </main>
    <script>
      const baseApi = '/api/miniprogram/${input.appId}';
      const elements = {
        call: document.getElementById('callButton'),
        primaryCall: document.getElementById('callPrimaryButton'),
        error: document.getElementById('errorText'),
        response: document.getElementById('responseBox'),
      };
      let loading = false;

      function setError(message) {
        if (!message) {
          elements.error.hidden = true;
          elements.error.textContent = '';
          return;
        }
        elements.error.hidden = false;
        elements.error.textContent = message;
      }

      function setLoading(nextLoading) {
        loading = nextLoading;
        elements.call.disabled = nextLoading;
        elements.primaryCall.disabled = nextLoading;
        elements.call.textContent = nextLoading ? '调用中...' : '调用 /hello';
        elements.primaryCall.textContent = nextLoading ? '调用中...' : '调用 /hello';
      }

      async function callHello() {
        setError('');
        setLoading(true);
        try {
          const response = await fetch(baseApi + '/hello');
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || '调用失败');
          }
          elements.response.textContent = JSON.stringify(result, null, 2);
        } catch (error) {
          setError(error.message || '调用失败');
        } finally {
          setLoading(false);
        }
      }

      elements.call.addEventListener('click', callHello);
      elements.primaryCall.addEventListener('click', callHello);
      Promise.resolve().then(callHello).catch((error) => setError(error.message || '初始化失败'));
    </script>
  </body>
</html>
`,
  );

  return paths;
}

function ensureFile(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizePackageName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function assertPathInsideProject(appId: string, targetPath: string): string {
  const projectDir = path.resolve(getMiniprogramProjectDir(appId));
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== projectDir && !resolvedTarget.startsWith(`${projectDir}${path.sep}`)) {
    throw new Error(`Path escapes project directory: ${targetPath}`);
  }
  return resolvedTarget;
}

export function listProjectFiles(appId: string, subdir = ''): Array<{ path: string; type: 'file' | 'dir' }> {
  const paths = getMiniprogramProjectPaths(appId);
  const allowed = new Set(['', 'app', 'docs', 'data', 'dist', 'server']);
  if (!allowed.has(subdir)) {
    throw new Error(`Unsupported subdir: ${subdir}`);
  }
  const baseDir = subdir ? path.join(paths.rootDir, subdir) : paths.rootDir;
  const safeBase = assertPathInsideProject(appId, baseDir);
  if (!fs.existsSync(safeBase)) return [];
  return fs.readdirSync(safeBase, { withFileTypes: true }).map((entry) => ({
    path: subdir ? path.posix.join(subdir, entry.name) : entry.name,
    type: entry.isDirectory() ? 'dir' : 'file',
  }));
}

const BLOCKED_DIR_NAMES = new Set([
  '.git',
  '.DS_Store',
  'dist',
  'node_modules',
]);

const MAX_EDITABLE_FILE_SIZE = 1024 * 1024;

function normalizeProjectRelativePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.trim().replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '/') {
    throw new Error('File path is required');
  }
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid file path: ${filePath}`);
  }
  return normalized.replace(/^\/+/, '');
}

function assertNoBlockedPathSegment(relativePath: string): void {
  const segments = relativePath.split('/').filter(Boolean);
  if (
    segments.some(
      (segment) => BLOCKED_DIR_NAMES.has(segment) || segment.startsWith('.'),
    )
  ) {
    throw new Error(`Unsupported file path: ${relativePath}`);
  }
}

export function resolveProjectFilePath(appId: string, filePath: string): string {
  const relativePath = normalizeProjectRelativePath(filePath);
  assertNoBlockedPathSegment(relativePath);
  return assertPathInsideProject(
    appId,
    path.join(getMiniprogramProjectDir(appId), relativePath),
  );
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 1024);
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function buildProjectTree(
  appId: string,
  currentDir: string,
  relativeDir: string,
): ProjectFileTreeNode[] {
  const safeDir = assertPathInsideProject(appId, currentDir);
  if (!fs.existsSync(safeDir)) {
    return [];
  }

  const entries = fs.readdirSync(safeDir, { withFileTypes: true })
    .filter(
      (entry) =>
          !BLOCKED_DIR_NAMES.has(entry.name) && !entry.name.startsWith('.'),
    )
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map((entry) => {
    const entryPath = relativeDir
      ? path.posix.join(relativeDir, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: entryPath,
        type: 'dir' as const,
        children: buildProjectTree(
          appId,
          path.join(safeDir, entry.name),
          entryPath,
        ),
      };
    }
    return {
      name: entry.name,
      path: entryPath,
      type: 'file' as const,
    };
  });
}

export function getProjectFileTree(appId: string): ProjectFileTreeNode[] {
  return buildProjectTree(appId, getMiniprogramProjectDir(appId), '');
}

export function readProjectTextFile(appId: string, filePath: string): ProjectTextFile {
  const normalizedPath = normalizeProjectRelativePath(filePath);
  const resolvedPath = resolveProjectFilePath(appId, normalizedPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${normalizedPath}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${normalizedPath}`);
  }
  if (stat.size > MAX_EDITABLE_FILE_SIZE) {
    throw new Error(`File is too large to edit: ${normalizedPath}`);
  }
  const buffer = fs.readFileSync(resolvedPath);
  if (isLikelyBinary(buffer)) {
    throw new Error(`Binary file is not supported: ${normalizedPath}`);
  }
  return {
    path: normalizedPath,
    content: buffer.toString('utf8'),
    size: stat.size,
    updatedAt: stat.mtimeMs,
  };
}

export function writeProjectTextFile(
  appId: string,
  filePath: string,
  content: string,
): ProjectTextFile {
  const normalizedPath = normalizeProjectRelativePath(filePath);
  const resolvedPath = resolveProjectFilePath(appId, normalizedPath);
  const existing = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath) : null;
  if (existing && !existing.isFile()) {
    throw new Error(`Not a file: ${normalizedPath}`);
  }
  ensureDir(path.dirname(resolvedPath));
  fs.writeFileSync(resolvedPath, content, 'utf8');
  return readProjectTextFile(appId, normalizedPath);
}
