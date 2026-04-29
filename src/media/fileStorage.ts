import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const FILE_STORAGE_DIR = path.join(process.env.HOME || '~', '.openclaw', 'openclaw-chatclaw', 'files');
const PUBLIC_FILES_DIR = path.join(FILE_STORAGE_DIR, 'public');
const execFileAsync = promisify(execFile);

export interface LocalFileInfo {
  id: string;
  fileName: string;
  fileUrl: string;
  coverUrl?: string;
  fileSize: number;
  contentType: string;
  createdAt: number;
}

/**
 * 获取用户存储目录
 */
export function getUserStorageDir(accountId: string): string {
  return path.join(FILE_STORAGE_DIR, accountId);
}

/**
 * 确保存储目录存在（按用户区分）
 * @param accountId 用户账号ID
 */
export function ensureStorageDir(accountId: string): void {
  const userDir = getUserStorageDir(accountId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
}

/**
 * 根据文件ID和用户ID获取本地文件路径
 */
export function getFilePath(fileId: string, accountId: string): string {
  return path.join(getUserStorageDir(accountId), fileId);
}

/**
 * 根据文件ID和用户ID获取文件URL路径
 */
export function getFileUrlPath(fileId: string, accountId: string): string {
  return `/files/download/${accountId}/${fileId}`;
}

export function getPublicFilePath(fileId: string): string {
  return path.join(PUBLIC_FILES_DIR, fileId);
}

export function getPublicFileUrlPath(fileId: string): string {
  return `/files/download/public/${fileId}`;
}

export function readPublicFile(fileId: string): Buffer | null {
  const filePath = getPublicFilePath(fileId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath);
}

export function ensurePublicStorageDir(): void {
  if (!fs.existsSync(PUBLIC_FILES_DIR)) {
    fs.mkdirSync(PUBLIC_FILES_DIR, { recursive: true });
  }
}

export function savePublicFile(fileBuffer: Buffer, fileId: string): string {
  ensurePublicStorageDir();
  const filePath = getPublicFilePath(fileId);
  fs.writeFileSync(filePath, fileBuffer);
  return getPublicFileUrlPath(fileId);
}

export function getVideoCoverFileId(fileId: string): string {
  return `${fileId}.cover.jpg`;
}

export function getVideoCoverPath(fileId: string, accountId: string): string {
  return getFilePath(getVideoCoverFileId(fileId), accountId);
}

export function getVideoCoverUrlPath(fileId: string, accountId: string): string {
  return getFileUrlPath(getVideoCoverFileId(fileId), accountId);
}

function isVideoContentType(contentType?: string): boolean {
  return typeof contentType === 'string' && contentType.startsWith('video/');
}

export function readVideoCover(fileId: string, accountId: string): Buffer | null {
  const coverPath = getVideoCoverPath(fileId, accountId);
  if (!fs.existsSync(coverPath)) {
    return null;
  }
  return fs.readFileSync(coverPath);
}

export async function ensureVideoCover(fileId: string, accountId: string): Promise<string> {
  const filePath = getFilePath(fileId, accountId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${fileId}`);
  }

  const contentType = getContentTypeFromFileId(fileId);
  if (!contentType.startsWith('video/')) {
    throw new Error('Not a video file');
  }

  const coverPath = getVideoCoverPath(fileId, accountId);
  if (fs.existsSync(coverPath)) {
    return coverPath;
  }

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      '00:00:01.000',
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      coverPath,
    ]);
  } catch {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      coverPath,
    ]);
  }

  if (!fs.existsSync(coverPath)) {
    throw new Error('Failed to generate video cover');
  }

  return coverPath;
}

/**
 * 保存文件到本地存储（按用户区分）
 * @param buffer 文件内容
 * @param accountId 用户账号ID
 * @param originalFileName 原始文件名
 * @param contentType 文件MIME类型
 * @returns LocalFileInfo 文件信息
 */
export async function saveFile(
  buffer: Buffer,
  accountId: string,
  originalFileName: string,
  contentType: string
): Promise<LocalFileInfo> {
  ensureStorageDir(accountId);

  // 生成带后缀的fileId：UUID_原始文件名
  const uuid = randomUUID();
  const ext = originalFileName.includes('.') ? '.' + originalFileName.split('.').pop() : '';
  const fileId = ext ? `${uuid}${ext}` : uuid;
  const filePath = getFilePath(fileId, accountId);

  // 保存文件
  fs.writeFileSync(filePath, buffer);

  const stats = fs.statSync(filePath);
  const coverUrl = isVideoContentType(contentType)
    ? (await ensureVideoCover(fileId, accountId), getVideoCoverUrlPath(fileId, accountId))
    : undefined;

  return {
    id: fileId,
    fileName: originalFileName,
    fileUrl: getFileUrlPath(fileId, accountId),
    coverUrl,
    fileSize: stats.size,
    contentType,
    createdAt: Date.now(),
  };
}

/**
 * 保存上传的文件（ multipart/form-data 的 file 字段，按用户区分）
 * @param filePath 上传的临时文件路径
 * @param accountId 用户账号ID
 * @param originalFileName 原始文件名
 * @param contentType 文件MIME类型
 * @returns LocalFileInfo 文件信息
 */
export async function saveUploadedFile(
  filePath: string,
  accountId: string,
  originalFileName: string,
  contentType: string
): Promise<LocalFileInfo> {
  ensureStorageDir(accountId);

  // 生成带后缀的fileId：UUID_原始文件名
  const uuid = randomUUID();
  const ext = originalFileName.includes('.') ? '.' + originalFileName.split('.').pop() : '';
  const fileId = ext ? `${uuid}${ext}` : uuid;
  const destPath = getFilePath(fileId, accountId);

  // 移动临时文件到存储目录
  fs.copyFileSync(filePath, destPath);

  // 删除临时文件
  try {
    fs.unlinkSync(filePath);
  } catch {
    // 忽略临时文件删除错误
  }

  const stats = fs.statSync(destPath);
  const coverUrl = isVideoContentType(contentType)
    ? (await ensureVideoCover(fileId, accountId), getVideoCoverUrlPath(fileId, accountId))
    : undefined;

  return {
    id: fileId,
    fileName: originalFileName,
    fileUrl: getFileUrlPath(fileId, accountId),
    coverUrl,
    fileSize: stats.size,
    contentType,
    createdAt: Date.now(),
  };
}

/**
 * 读取本地存储的文件
 * @param fileId 文件ID
 * @param accountId 用户账号ID
 * @returns Buffer 文件内容
 */
export function readFile(fileId: string, accountId: string): Buffer | null {
  const filePath = getFilePath(fileId, accountId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath);
}

/**
 * 检查文件是否存在
 * @param fileId 文件ID
 * @param accountId 用户账号ID
 * @returns boolean
 */
export function fileExists(fileId: string, accountId: string): boolean {
  return fs.existsSync(getFilePath(fileId, accountId));
}

/**
 * 删除本地文件
 * @param fileId 文件ID
 * @param accountId 用户账号ID
 * @returns boolean 是否删除成功
 */
export function deleteLocalFile(fileId: string, accountId: string): boolean {
  const filePath = getFilePath(fileId, accountId);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    fs.unlinkSync(filePath);
    const coverPath = getVideoCoverPath(fileId, accountId);
    if (fs.existsSync(coverPath)) {
      fs.unlinkSync(coverPath);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取文件信息
 * @param fileId 文件ID
 * @param accountId 用户账号ID
 * @returns LocalFileInfo | null
 */
export function getFileInfo(fileId: string, accountId: string): LocalFileInfo | null {
  const filePath = getFilePath(fileId, accountId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stats = fs.statSync(filePath);
  const fileName = path.basename(filePath);

  return {
    id: fileId,
    fileName,
    fileUrl: getFileUrlPath(fileId, accountId),
    coverUrl: fs.existsSync(getVideoCoverPath(fileId, accountId))
      ? getVideoCoverUrlPath(fileId, accountId)
      : undefined,
    fileSize: stats.size,
    contentType: guessContentType(fileName),
    createdAt: stats.birthtimeMs,
  };
}

/**
 * 根据文件名猜测MIME类型
 */
function guessContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * 从文件ID获取MIME类型
 */
export function getContentTypeFromFileId(fileId: string): string {
  return guessContentType(fileId);
}

/**
 * 从文件ID获取文件名
 */
export function getFileNameFromFileId(fileId: string): string {
  return path.basename(fileId);
}
