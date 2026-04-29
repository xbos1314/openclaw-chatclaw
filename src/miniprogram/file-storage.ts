import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getMiniprogramProjectPaths } from './storage.js';

const META_SUFFIX = '.meta.json';

export interface MiniprogramStoredFileInfo {
  fileId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  createdAt: number;
  url: string;
  downloadUrl: string;
}

interface MiniprogramFileMetadata {
  fileId: string;
  fileName: string;
  contentType: string;
  createdAt: number;
}

export function getMiniprogramFilesDir(appId: string): string {
  return path.join(getMiniprogramProjectPaths(appId).dataDir, 'files');
}

export function ensureMiniprogramFilesDir(appId: string): string {
  const dir = getMiniprogramFilesDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMiniprogramFileUrl(appId: string, fileId: string): string {
  return `/api/miniprogram/${appId}/file/${encodeURIComponent(fileId)}`;
}

export async function saveMiniprogramFile(
  appId: string,
  buffer: Buffer,
  originalFileName: string,
  contentType?: string,
): Promise<MiniprogramStoredFileInfo> {
  const safeFileName = sanitizeOriginalFileName(originalFileName);
  const fileId = createFileId(safeFileName);
  const filePath = resolveStoredFilePath(appId, fileId);
  fs.writeFileSync(filePath, buffer);
  const stats = fs.statSync(filePath);
  const metadata: MiniprogramFileMetadata = {
    fileId,
    fileName: safeFileName,
    contentType: normalizeContentType(contentType, safeFileName),
    createdAt: Date.now(),
  };
  writeMetadata(appId, fileId, metadata);
  return toStoredFileInfo(appId, metadata, stats.size);
}

export function readMiniprogramFile(
  appId: string,
  fileId: string,
): { filePath: string; info: MiniprogramStoredFileInfo } | null {
  const safeFileId = sanitizeFileId(fileId);
  const filePath = resolveStoredFilePath(appId, safeFileId);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  const stats = fs.statSync(filePath);
  const metadata = readMetadata(appId, safeFileId);
  const info = metadata == null
    ? toStoredFileInfo(appId, {
        fileId: safeFileId,
        fileName: safeFileId,
      contentType: getMimeTypeFromFileName(safeFileId),
        createdAt: stats.birthtimeMs || stats.mtimeMs,
      }, stats.size)
    : toStoredFileInfo(appId, metadata, stats.size);
  return { filePath, info };
}

export function deleteMiniprogramFile(appId: string, fileId: string): boolean {
  const safeFileId = sanitizeFileId(fileId);
  const filePath = resolveStoredFilePath(appId, safeFileId);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  const metadataPath = getMetadataPath(appId, safeFileId);
  if (fs.existsSync(metadataPath)) {
    fs.unlinkSync(metadataPath);
  }
  return true;
}

function toStoredFileInfo(
  appId: string,
  metadata: MiniprogramFileMetadata,
  fileSize: number,
): MiniprogramStoredFileInfo {
  const url = getMiniprogramFileUrl(appId, metadata.fileId);
  return {
    fileId: metadata.fileId,
    fileName: metadata.fileName,
    contentType: metadata.contentType,
    fileSize,
    createdAt: metadata.createdAt,
    url,
    downloadUrl: `${url}?download=1`,
  };
}

function writeMetadata(appId: string, fileId: string, metadata: MiniprogramFileMetadata): void {
  fs.writeFileSync(getMetadataPath(appId, fileId), JSON.stringify(metadata, null, 2), 'utf8');
}

function readMetadata(appId: string, fileId: string): MiniprogramFileMetadata | null {
  const metadataPath = getMetadataPath(appId, fileId);
  if (!fs.existsSync(metadataPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as MiniprogramFileMetadata;
  } catch {
    return null;
  }
}

function getMetadataPath(appId: string, fileId: string): string {
  return `${resolveStoredFilePath(appId, fileId)}${META_SUFFIX}`;
}

function resolveStoredFilePath(appId: string, fileId: string): string {
  const safeFileId = sanitizeFileId(fileId);
  return path.join(ensureMiniprogramFilesDir(appId), safeFileId);
}

function sanitizeOriginalFileName(fileName: string): string {
  const normalized = path.basename(String(fileName || '').trim());
  return normalized === '' ? 'file' : normalized;
}

function sanitizeFileId(fileId: string): string {
  const normalized = path.basename(String(fileId || '').trim());
  if (normalized === '' || normalized !== fileId || normalized.endsWith(META_SUFFIX)) {
    throw new Error(`Invalid file id: ${fileId}`);
  }
  return normalized;
}

function createFileId(fileName: string): string {
  const ext = path.extname(fileName);
  const uuid = randomUUID();
  return ext === '' ? uuid : `${uuid}${ext}`;
}

function normalizeContentType(contentType: string | undefined, fileName: string): string {
  const trimmed = String(contentType || '').trim();
  return trimmed === '' ? getMimeTypeFromFileName(fileName) : trimmed;
}

function getMimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
