import fs from 'node:fs';
import path from 'node:path';
import {
  getDefaultServerEntryTemplate,
  getMiniprogramProjectPaths,
  getServerConfigPath,
  isMiniprogramCustomApiEnabled,
} from './storage.js';

export interface MiniprogramValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
}

export interface MiniprogramValidationReport {
  ok: boolean;
  app_id: string;
  errors: MiniprogramValidationIssue[];
  warnings: MiniprogramValidationIssue[];
  checks: {
    custom_api_enabled: boolean;
    server_entry_exists: boolean;
    server_entry_exports_handle: boolean;
    server_entry_is_default_template: boolean;
    frontend_uses_project_api_prefix: boolean;
    server_entry_uses_express_wrapper: boolean;
    server_entry_uses_gateway_prefixed_routes: boolean;
    vite_config_exists: boolean;
    vite_uses_relative_base: boolean;
    dist_uses_relative_assets: boolean;
  };
  frontend_project_routes: string[];
  server_handled_routes: string[];
}

export function validateMiniprogramProject(appId: string): MiniprogramValidationReport {
  const paths = getMiniprogramProjectPaths(appId);
  const issues: MiniprogramValidationIssue[] = [];
  const enabled = isMiniprogramCustomApiEnabled(appId);
  const serverEntryPath = path.join(paths.serverDir, 'index.js');
  const serverConfigPath = getServerConfigPath(appId);
  const viteConfigPath = path.join(paths.appDir, 'vite.config.js');
  const distIndexPath = path.join(paths.distDir, 'index.html');
  const serverEntryExists = fs.existsSync(serverEntryPath);
  const viteConfigExists = fs.existsSync(viteConfigPath);
  const serverEntry = serverEntryExists ? fs.readFileSync(serverEntryPath, 'utf8') : '';
  const serverEntryWithoutComments = stripComments(serverEntry);
  const viteConfig = viteConfigExists ? fs.readFileSync(viteConfigPath, 'utf8') : '';
  const distIndex = fs.existsSync(distIndexPath) ? fs.readFileSync(distIndexPath, 'utf8') : '';
  const serverEntryExportsHandle = /\bexport\s+async\s+function\s+handle\b|\bexport\s+function\s+handle\b|\bexport\s*\{\s*handle\s*\}/.test(serverEntryWithoutComments);
  const serverEntryIsDefaultTemplate = serverEntryExists && serverEntry.trim() === getDefaultServerEntryTemplate().trim();
  const serverEntryUsesExpressWrapper = containsExpressWrapper(serverEntryWithoutComments);
  const serverEntryUsesGatewayPrefixedRoutes = containsGatewayPrefixedRoutes(serverEntryWithoutComments);
  const viteUsesRelativeBase = containsRelativeViteBase(viteConfig);
  const distUsesRelativeAssets = !containsRootAssetPaths(distIndex);
  const appSources = collectSourceFiles(paths.appDir);
  const serverSources = collectSourceFiles(paths.serverDir);
  const frontendProjectRoutes = extractFrontendProjectRoutes(appSources, appId);
  const serverHandledRoutes = extractServerHandledRoutes(serverEntryWithoutComments);
  const frontendUsesProjectApiPrefix = frontendProjectRoutes.length > 0 || !containsNakedApiCall(appSources);

  if (!serverEntryExists) {
    issues.push({
      severity: 'error',
      code: 'missing_server_entry',
      message: '缺少 server/index.js，项目后端入口不存在。',
      file: serverEntryPath,
    });
  }

  if (enabled && !serverEntryExportsHandle) {
    issues.push({
      severity: 'error',
      code: 'missing_handle_export',
      message: 'server/index.js 未按规范导出 handle(req, ctx)。',
      file: serverEntryPath,
    });
  }

  if (enabled && serverEntryUsesExpressWrapper) {
    issues.push({
      severity: 'error',
      code: 'express_wrapper_forbidden',
      message: 'server/index.js 不得创建 Express/Router 包装层。项目后端必须直接导出 handle(req, ctx)，并返回 { status, headers, body }。',
      file: serverEntryPath,
    });
  }

  if (enabled && serverEntryUsesGatewayPrefixedRoutes) {
    issues.push({
      severity: 'error',
      code: 'gateway_prefixed_server_route',
      message: 'server/index.js 中不得写 /api/miniprogram/{appId}/... 或 /miniprogram/... 全路径。项目后端只应匹配 req.path 子路径，例如 /qrcode/generate。',
      file: serverEntryPath,
    });
  }

  if (!viteConfigExists) {
    issues.push({
      severity: 'error',
      code: 'missing_vite_config',
      message: '缺少 app/vite.config.js，无法保证前端构建输出适配 /miniprogram/{appId}/ 页面挂载路径。',
      file: viteConfigPath,
    });
  } else if (!viteUsesRelativeBase) {
    issues.push({
      severity: 'error',
      code: 'vite_missing_relative_base',
      message: 'app/vite.config.js 未配置相对 base。请显式设置 Vite `base: \'./\'`，否则构建后静态资源可能被输出为 /assets/... 根路径。',
      file: viteConfigPath,
    });
  }

  for (const badApiCall of findNakedApiCalls(appSources)) {
    issues.push({
      severity: 'error',
      code: 'naked_api_path',
      message: `前端不得直接调用裸 /api 路径：${badApiCall.snippet}`,
      file: badApiCall.file,
    });
  }

  if (enabled && serverEntryIsDefaultTemplate && frontendProjectRoutes.some((route) => route !== '/hello')) {
    issues.push({
      severity: 'error',
      code: 'default_server_template',
      message: '前端已调用项目自定义接口，但 server/index.js 仍是默认模板，未接入真实后端实现。',
      file: serverEntryPath,
    });
  }

  for (const route of frontendProjectRoutes) {
    if (!serverHandledRoutes.includes(route)) {
      issues.push({
        severity: 'error',
        code: 'frontend_backend_route_mismatch',
        message: `前端使用了项目接口 ${route}，但 server/index.js 未实现对应 req.path 处理。`,
        file: serverEntryPath,
      });
    }
  }

  for (const standaloneEntry of findStandaloneServerEntries(serverSources)) {
    issues.push({
      severity: 'error',
      code: 'standalone_server_entry',
      message: '检测到独立 Node/Express 服务入口。当前规范要求后端逻辑通过 server/index.js 导出的 handle(req, ctx) 接入网关，不能自行 app.listen(...)。',
      file: standaloneEntry,
    });
  }

  if (fs.existsSync(serverConfigPath) && !enabled && frontendProjectRoutes.length > 0) {
    issues.push({
      severity: 'error',
      code: 'custom_api_disabled',
      message: '前端已调用项目自定义接口，但 server/openclaw.server.json 当前为 disabled。',
      file: serverConfigPath,
    });
  }

  if (fs.existsSync(distIndexPath) && !distUsesRelativeAssets) {
    issues.push({
      severity: 'error',
      code: 'dist_root_asset_path',
      message: 'dist/index.html 仍在使用 /assets/... 根路径，页面挂载到 /miniprogram/{appId}/ 时会空白。请将前端构建配置改为相对资源路径，例如 Vite `base: \'./\'`，并重新 build。',
      file: distIndexPath,
    });
  }

  if (serverSources.some((source) => source.file !== serverEntryPath && /app\.listen\(|createServer\(/.test(source.content))) {
    issues.push({
      severity: 'warning',
      code: 'extra_server_runtime',
      message: 'server/ 下存在额外运行时入口文件，建议将后端逻辑统一收敛到 server/index.js 的 handle(req, ctx)。',
    });
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    app_id: appId,
    errors: issues.filter((issue) => issue.severity === 'error'),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
    checks: {
      custom_api_enabled: enabled,
      server_entry_exists: serverEntryExists,
      server_entry_exports_handle: serverEntryExportsHandle,
      server_entry_is_default_template: serverEntryIsDefaultTemplate,
      frontend_uses_project_api_prefix: frontendUsesProjectApiPrefix,
      server_entry_uses_express_wrapper: serverEntryUsesExpressWrapper,
      server_entry_uses_gateway_prefixed_routes: serverEntryUsesGatewayPrefixedRoutes,
      vite_config_exists: viteConfigExists,
      vite_uses_relative_base: viteUsesRelativeBase,
      dist_uses_relative_assets: distUsesRelativeAssets,
    },
    frontend_project_routes: dedupe(frontendProjectRoutes),
    server_handled_routes: dedupe(serverHandledRoutes),
  };
}

export function formatValidationErrors(report: MiniprogramValidationReport): string {
  const lines = report.errors.map((issue) => {
    const fileSuffix = issue.file ? ` [${issue.file}]` : '';
    return `${issue.code}: ${issue.message}${fileSuffix}`;
  });
  return lines.join('\n');
}

function collectSourceFiles(rootDir: string): Array<{ file: string; content: string }> {
  if (!fs.existsSync(rootDir)) return [];
  const result: Array<{ file: string; content: string }> = [];
  walk(rootDir, result);
  return result;
}

function walk(current: string, result: Array<{ file: string; content: string }>): void {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, result);
      continue;
    }
    if (!/\.(js|ts|vue|json|mjs|cjs)$/.test(entry.name)) {
      continue;
    }
    result.push({
      file: fullPath,
      content: fs.readFileSync(fullPath, 'utf8'),
    });
  }
}

function findNakedApiCalls(files: Array<{ file: string; content: string }>): Array<{ file: string; snippet: string }> {
  const results: Array<{ file: string; snippet: string }> = [];
  const regex = /(?:fetch|axios(?:\.\w+)?)\s*\(\s*['"`](\/api\/(?!miniprogram\/)[^'"`]*)['"`]/g;
  for (const file of files) {
    for (const match of file.content.matchAll(regex)) {
      results.push({
        file: file.file,
        snippet: match[1],
      });
    }
  }
  return results;
}

function containsNakedApiCall(files: Array<{ file: string; content: string }>): boolean {
  return findNakedApiCalls(files).length > 0;
}

function extractFrontendProjectRoutes(files: Array<{ file: string; content: string }>, appId: string): string[] {
  const routes: string[] = [];
  const directRegex = new RegExp(`/api/miniprogram/${appId}(/[^'"\\s\\x60)}]+)`, 'g');
  const baseApiConcatRegex = /baseApi\s*\+\s*['"`](\/[^'"`\s]+)['"`]/g;
  const baseApiTemplateRegex = /\$\{baseApi\}(\/[^'"`\s]+)[`'"]/g;
  for (const file of files) {
    for (const match of file.content.matchAll(directRegex)) {
      routes.push(normalizeRoute(match[1]));
    }
    for (const match of file.content.matchAll(baseApiConcatRegex)) {
      routes.push(normalizeRoute(match[1]));
    }
    for (const match of file.content.matchAll(baseApiTemplateRegex)) {
      routes.push(normalizeRoute(match[1]));
    }
  }
  return dedupe(routes).filter((route) => !isReservedGatewayRoute(route));
}

export function extractServerHandledRoutes(serverEntry: string): string[] {
  const routes: string[] = [];
  const pathAliases = collectReqPathAliases(serverEntry);
  for (const alias of pathAliases) {
    const escapedAlias = escapeRegExp(alias);
    const aliasEqualsRegex = new RegExp(`${escapedAlias}\\s*(?:===|==)\\s*['"\`](\\/[^'"\`]+)['"\`]`, 'g');
    const equalsAliasRegex = new RegExp(`['"\`](\\/[^'"\`]+)['"\`]\\s*(?:===|==)\\s*${escapedAlias}`, 'g');
    for (const match of serverEntry.matchAll(aliasEqualsRegex)) {
      routes.push(normalizeRoute(match[1]));
    }
    for (const match of serverEntry.matchAll(equalsAliasRegex)) {
      routes.push(normalizeRoute(match[1]));
    }
  }
  for (const switchBody of extractPathSwitchBodies(serverEntry, pathAliases)) {
    for (const match of switchBody.matchAll(/case\s+['"`](\/[^'"`]+)['"`]/g)) {
      routes.push(normalizeRoute(match[1]));
    }
  }
  return dedupe(routes);
}

function collectReqPathAliases(serverEntry: string): string[] {
  const aliases = new Set<string>(['req.path']);
  const directAssignments = [...serverEntry.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*[;\n]/g)];
  let changed = true;

  while (changed) {
    changed = false;
    for (const match of directAssignments) {
      const lhs = match[1];
      const rhs = match[2];
      if (aliases.has(rhs) && !aliases.has(lhs)) {
        aliases.add(lhs);
        changed = true;
      }
    }
  }

  for (const alias of collectReqPathDestructuredAliases(serverEntry)) {
    aliases.add(alias);
  }

  return [...aliases];
}

function collectReqPathDestructuredAliases(serverEntry: string): string[] {
  const aliases: string[] = [];
  const declarationRegex = /\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*req\b/g;

  for (const match of serverEntry.matchAll(declarationRegex)) {
    const bindings = match[1];
    for (const binding of bindings.split(',')) {
      const normalized = binding.trim().replace(/\s*=\s*[\s\S]+$/, '');
      const aliasMatch = normalized.match(/^path(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
      if (aliasMatch) {
        aliases.push(aliasMatch[1] || 'path');
      }
    }
  }

  return aliases;
}

function extractPathSwitchBodies(serverEntry: string, pathAliases: string[]): string[] {
  const bodies: string[] = [];
  for (const alias of pathAliases.filter((item) => item !== 'req.path')) {
    const switchRegex = new RegExp(`switch\\s*\\(\\s*${escapeRegExp(alias)}\\s*\\)\\s*\\{`, 'g');
    for (const match of serverEntry.matchAll(switchRegex)) {
      const blockStart = match.index != null ? match.index + match[0].length - 1 : -1;
      const blockEnd = findMatchingBrace(serverEntry, blockStart);
      if (blockStart >= 0 && blockEnd > blockStart) {
        bodies.push(serverEntry.slice(blockStart + 1, blockEnd));
      }
    }
  }
  return bodies;
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findStandaloneServerEntries(files: Array<{ file: string; content: string }>): string[] {
  return files
    .filter((file) => file.file.includes(`${path.sep}src${path.sep}`))
    .filter((file) => /app\.listen\(|express\(|createServer\(/.test(file.content))
    .map((file) => file.file);
}

function containsExpressWrapper(serverEntry: string): boolean {
  return /\bfrom\s+['"]express['"]|\brequire\(\s*['"]express['"]\s*\)|\bexpress\s*\(|\bRouter\s*\(/.test(serverEntry);
}

function containsGatewayPrefixedRoutes(serverEntry: string): boolean {
  return /\/api\/miniprogram\/|\/miniprogram\//.test(serverEntry);
}

function containsRootAssetPaths(distIndex: string): boolean {
  return /(?:src|href)=["']\/assets\//.test(distIndex);
}

function containsRelativeViteBase(viteConfig: string): boolean {
  return /\bbase\s*:\s*['"]\.\/['"]/.test(viteConfig);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function normalizeRoute(route: string): string {
  const sanitized = route.split(/[?#]/, 1)[0] || '/';
  return sanitized.startsWith('/') ? sanitized : `/${sanitized}`;
}

function isReservedGatewayRoute(route: string): boolean {
  return ['/build', '/reload', '/tasks', '/send', '/file'].some((prefix) => route === prefix || route.startsWith(`${prefix}/`));
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
