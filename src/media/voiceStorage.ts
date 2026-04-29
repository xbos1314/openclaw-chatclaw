import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VOICE_STORAGE_DIR = path.join(process.env.HOME || '~', '.openclaw', 'openclaw-chatclaw', 'voices');

export interface VoiceFileInfo {
  id: string;
  fileName: string;
  fileUrl: string;
  filePath: string;
  contentType: string;
  createdAt: number;
}

/**
 * 获取用户语音存储目录
 */
export function getUserVoiceDir(accountId: string): string {
  return path.join(VOICE_STORAGE_DIR, accountId);
}

/**
 * 确保存储目录存在
 */
export function ensureVoiceDir(accountId: string): void {
  const userDir = getUserVoiceDir(accountId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
}

/**
 * 获取语音文件的绝对路径
 */
export function getVoicePath(voiceId: string, accountId: string): string {
  return path.join(getUserVoiceDir(accountId), voiceId);
}

/**
 * 获取语音文件的 URL 路径
 */
export function getVoiceUrlPath(voiceId: string, accountId: string): string {
  return `/voices/download/${accountId}/${voiceId}`;
}

/**
 * 保存语音文件
 * @param buffer 文件内容
 * @param accountId 用户账号ID
 * @param originalFileName 原始文件名
 * @param contentType 文件MIME类型
 * @returns VoiceFileInfo
 */
export async function saveVoiceFile(
  buffer: Buffer,
  accountId: string,
  originalFileName: string,
  contentType: string
): Promise<VoiceFileInfo> {
  ensureVoiceDir(accountId);

  // 生成带后缀的 voiceId：UUID_原始文件名
  const uuid = randomUUID();
  const ext = originalFileName.includes('.') ? '.' + originalFileName.split('.').pop() : '';
  const voiceId = ext ? `${uuid}${ext}` : uuid;
  const filePath = getVoicePath(voiceId, accountId);

  // 保存文件
  fs.writeFileSync(filePath, buffer);

  return {
    id: voiceId,
    fileName: originalFileName,
    fileUrl: getVoiceUrlPath(voiceId, accountId),
    filePath: filePath,
    contentType,
    createdAt: Date.now(),
  };
}

/**
 * 读取语音文件
 */
export function readVoiceFile(voiceId: string, accountId: string): Buffer | null {
  const filePath = getVoicePath(voiceId, accountId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath);
}

/**
 * 检查语音文件是否存在
 */
export function voiceFileExists(voiceId: string, accountId: string): boolean {
  return fs.existsSync(getVoicePath(voiceId, accountId));
}

/**
 * 删除语音文件
 */
export function deleteVoiceFile(voiceId: string, accountId: string): boolean {
  const filePath = getVoicePath(voiceId, accountId);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取文件 MIME 类型
 */
export function getContentTypeFromVoiceId(voiceId: string): string {
  const ext = path.extname(voiceId).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.amr': 'audio/amr',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
  };
  return mimeTypes[ext] || 'audio/ogg';
}

/**
 * 从 voiceId 获取文件名
 */
export function getFileNameFromVoiceId(voiceId: string): string {
  return path.basename(voiceId);
}
