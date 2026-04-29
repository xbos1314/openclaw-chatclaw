import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { logger } from '../util/logger.js';

const execFileAsync = promisify(execFile);

function isAudioContentType(contentType?: string): boolean {
  return typeof contentType === 'string' && contentType.startsWith('audio/');
}

function isAudioFileName(fileName?: string): boolean {
  if (!fileName) {
    return false;
  }
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith('.aac') ||
    lower.endsWith('.amr') ||
    lower.endsWith('.m4a') ||
    lower.endsWith('.mp3') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.opus') ||
    lower.endsWith('.wav')
  );
}

export function shouldResolveAudioDuration(params: {
  contentType?: string;
  fileName?: string;
  mimeType?: string;
}): boolean {
  if (params.contentType === 'voice' || params.contentType === 'audio') {
    return true;
  }

  return isAudioContentType(params.mimeType) || isAudioFileName(params.fileName);
}

export async function resolveAudioDurationMs(filePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const durationSeconds = Number((stdout || '').trim());
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return undefined;
    }
    return Math.round(durationSeconds * 1000);
  } catch (err) {
    logger.warn(`Failed to resolve audio duration for ${filePath}: ${String(err)}`);
    return undefined;
  }
}
