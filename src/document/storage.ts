import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_DIR = path.join(
  os.homedir(),
  '.openclaw',
  'openclaw-chatclaw',
  'documents',
);

export interface DocumentFileRef {
  fileName: string;
  filePath: string;
}

export interface DocumentTextFile extends DocumentFileRef {
  content: string;
  size: number;
  updatedAt: number;
}

export function getDocumentRootDir(): string {
  return ROOT_DIR;
}

export function getAccountDocumentDir(accountId: string): string {
  return path.join(ROOT_DIR, accountId);
}

export function ensureAccountDocumentDir(accountId: string): string {
  ensureDir(ROOT_DIR);
  const dir = getAccountDocumentDir(accountId);
  ensureDir(dir);
  return dir;
}

export function normalizeDocumentFileName(input: string): string {
  const raw = path.basename(String(input || '').trim());
  const parsed = path.parse(raw);
  const baseName = sanitizeBaseName(parsed.name || parsed.base || '未命名文档');
  return `${baseName}.md`;
}

export function createEmptyDocumentFile(
  accountId: string,
  fileNameInput: string,
): DocumentFileRef {
  const dir = ensureAccountDocumentDir(accountId);
  const normalized = normalizeDocumentFileName(fileNameInput);
  const parsed = path.parse(normalized);

  let fileName = normalized;
  let filePath = path.join(dir, fileName);
  let suffix = 2;

  while (fs.existsSync(filePath)) {
    fileName = `${parsed.name}_${suffix}${parsed.ext || '.md'}`;
    filePath = path.join(dir, fileName);
    suffix += 1;
  }

  fs.writeFileSync(filePath, '', 'utf8');
  return { fileName, filePath };
}

export function readDocumentTextFile(filePath: string): DocumentTextFile {
  const resolvedPath = assertDocumentPath(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolvedPath}`);
  }
  return {
    fileName: path.basename(resolvedPath),
    filePath: resolvedPath,
    content: fs.readFileSync(resolvedPath, 'utf8'),
    size: stat.size,
    updatedAt: stat.mtimeMs,
  };
}

export function writeDocumentTextFile(
  filePath: string,
  content: string,
): DocumentTextFile {
  const resolvedPath = assertDocumentPath(filePath);
  ensureDir(path.dirname(resolvedPath));
  fs.writeFileSync(resolvedPath, content, 'utf8');
  return readDocumentTextFile(resolvedPath);
}

export function renameDocumentFile(
  accountId: string,
  currentFilePath: string,
  nextFileNameInput: string,
): DocumentFileRef {
  const currentPath = assertDocumentPath(currentFilePath);
  if (!fs.existsSync(currentPath)) {
    throw new Error(`File not found: ${currentPath}`);
  }

  const dir = ensureAccountDocumentDir(accountId);
  const normalized = normalizeDocumentFileName(nextFileNameInput);
  const parsed = path.parse(normalized);

  let fileName = normalized;
  let filePath = path.join(dir, fileName);
  let suffix = 2;

  while (
    fs.existsSync(filePath) &&
    path.resolve(filePath) !== path.resolve(currentPath)
  ) {
    fileName = `${parsed.name}_${suffix}${parsed.ext || '.md'}`;
    filePath = path.join(dir, fileName);
    suffix += 1;
  }

  if (path.resolve(filePath) !== path.resolve(currentPath)) {
    fs.renameSync(currentPath, filePath);
  }

  return { fileName, filePath };
}

export function deleteDocumentFile(filePath: string): void {
  const resolvedPath = assertDocumentPath(filePath);
  if (fs.existsSync(resolvedPath)) {
    fs.unlinkSync(resolvedPath);
  }
}

function sanitizeBaseName(input: string): string {
  const sanitized = input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return sanitized || '未命名文档';
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function assertDocumentPath(filePath: string): string {
  const resolvedRoot = path.resolve(ROOT_DIR);
  const resolvedPath = path.resolve(filePath);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Path escapes document root: ${resolvedPath}`);
  }
  return resolvedPath;
}
