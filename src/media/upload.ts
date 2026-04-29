import fs from 'fs';
import path from 'path';
import { resolveAudioDurationMs, shouldResolveAudioDuration } from './audioDuration.js';
import * as fileStorage from './fileStorage.js';

export interface UploadResult {
  id: string;
  fileName: string;
  fileUrl: string;
  coverUrl?: string;
  fileType: string;
  fileSize: string;
  createTime: string;
  duration?: number;
}

function shouldResolveVideoCover(params: {
  contentType?: string;
  fileName?: string;
  mimeType?: string;
}): boolean {
  if (params.contentType === 'video') {
    return true;
  }
  const mimeType = params.mimeType || '';
  if (mimeType.startsWith('video/')) {
    return true;
  }
  const fileName = params.fileName?.toLowerCase() || '';
  return (
    fileName.endsWith('.mp4') ||
    fileName.endsWith('.mov') ||
    fileName.endsWith('.avi') ||
    fileName.endsWith('.mkv') ||
    fileName.endsWith('.webm')
  );
}

/**
 * 上传文件并返回完整的上传结果
 * @param filePath 文件路径
 * @param accountId 用户账号ID
 * @param contentType 文件MIME类型（可选）
 * @returns UploadResult 包含完整的文件信息
 */
export async function uploadFile(filePath: string, accountId: string, contentType?: string): Promise<UploadResult> {
  // 如果已经是 http/https URL，构造一个简单的 UploadResult 返回
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    const fileName = filePath.split('/').pop() || 'file';
    const fileType = contentType || '';
    return {
      id: '',
      fileName: fileName,
      fileUrl: filePath,
      fileType,
      fileSize: '',
      createTime: new Date().toISOString(),
      duration: shouldResolveAudioDuration({
        fileName,
        mimeType: fileType,
      })
        ? await resolveAudioDurationMs(filePath)
        : undefined,
    };
  }

  // 如果是本地文件URL路径（/files/download/开头），直接返回
  if (filePath.startsWith('/files/download/')) {
    // 新格式: /files/download/accountId/fileId
    const parts = filePath.replace('/files/download/', '').split('/');
    const fileId = parts.pop();
    const storedAccountId = parts.join('/');
    if (fileId && storedAccountId) {
      const rawFileType = fileStorage.getContentTypeFromFileId(fileId);
      if (shouldResolveVideoCover({ fileName: fileId, mimeType: rawFileType })) {
        await fileStorage.ensureVideoCover(fileId, storedAccountId);
      }
      const fileInfo = fileStorage.getFileInfo(fileId, storedAccountId);
      if (fileInfo) {
        const fileType = fileInfo.contentType;
        const coverUrl = shouldResolveVideoCover({
          fileName: fileInfo.fileName,
          mimeType: fileType,
        })
          ? fileInfo.coverUrl
          : undefined;
        return {
          id: fileInfo.id,
          fileName: fileInfo.fileName,
          fileUrl: fileInfo.fileUrl,
          coverUrl,
          fileType,
          fileSize: String(fileInfo.fileSize),
          createTime: new Date(fileInfo.createdAt).toISOString(),
          duration: shouldResolveAudioDuration({
            fileName: fileInfo.fileName,
            mimeType: fileType,
          })
            ? await resolveAudioDurationMs(fileStorage.getFilePath(fileInfo.id, storedAccountId))
            : undefined,
        };
      }
    }
  }

  // 如果是 /file 开头，转换为本地存储URL
  if (filePath.startsWith('/file')) {
    const fileName = filePath.split('/').pop() || 'file';
    const fileId = path.basename(filePath);
    const fileType = guessContentType(fileName);
    return {
      id: fileId,
      fileName: fileName,
      fileUrl: `/files/download/${accountId}/${fileId}`,
      fileType,
      fileSize: '',
      createTime: new Date().toISOString(),
      duration: shouldResolveAudioDuration({
        fileName,
        mimeType: fileType,
      })
        ? await resolveAudioDurationMs(filePath)
        : undefined,
    };
  }

  // 否则上传文件到本地存储
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const detectedContentType = contentType || guessContentType(fileName);

  const fileInfo = await fileStorage.saveFile(fileBuffer, accountId, fileName, detectedContentType);

  return {
    id: fileInfo.id,
    fileName: fileInfo.fileName,
    fileUrl: fileInfo.fileUrl,
    coverUrl: fileInfo.coverUrl,
    fileType: fileInfo.contentType,
    fileSize: String(fileInfo.fileSize),
    createTime: new Date(fileInfo.createdAt).toISOString(),
    duration: shouldResolveAudioDuration({
      fileName: fileInfo.fileName,
      mimeType: fileInfo.contentType,
    })
      ? await resolveAudioDurationMs(filePath)
      : undefined,
  };
}

export async function uploadFileAs(
  filePath: string,
  accountId: string,
  fileName: string,
  contentType?: string,
): Promise<UploadResult> {
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    const fileType = contentType || '';
    return {
      id: '',
      fileName,
      fileUrl: filePath,
      fileType,
      fileSize: '',
      createTime: new Date().toISOString(),
      duration: shouldResolveAudioDuration({
        fileName,
        mimeType: fileType,
      })
        ? await resolveAudioDurationMs(filePath)
        : undefined,
    };
  }

  if (filePath.startsWith('/files/download/')) {
    const result = await uploadFile(filePath, accountId, contentType);
    return {
      ...result,
      fileName,
    };
  }

  if (filePath.startsWith('/file')) {
    const fileId = path.basename(filePath);
    const fileType = contentType || guessContentType(fileName);
    return {
      id: fileId,
      fileName,
      fileUrl: `/files/download/${accountId}/${fileId}`,
      fileType,
      fileSize: '',
      createTime: new Date().toISOString(),
      duration: shouldResolveAudioDuration({
        fileName,
        mimeType: fileType,
      })
        ? await resolveAudioDurationMs(filePath)
        : undefined,
    };
  }

  const fileBuffer = fs.readFileSync(filePath);
  const detectedContentType = contentType || guessContentType(fileName);
  const fileInfo = await fileStorage.saveFile(fileBuffer, accountId, fileName, detectedContentType);

  return {
    id: fileInfo.id,
    fileName: fileInfo.fileName,
    fileUrl: fileInfo.fileUrl,
    coverUrl: fileInfo.coverUrl,
    fileType: fileInfo.contentType,
    fileSize: String(fileInfo.fileSize),
    createTime: new Date(fileInfo.createdAt).toISOString(),
    duration: shouldResolveAudioDuration({
      fileName: fileInfo.fileName,
      mimeType: fileInfo.contentType,
    })
      ? await resolveAudioDurationMs(filePath)
      : undefined,
  };
}

/**
 * 删除本地文件
 * @param fileId 文件ID
 * @param accountId 用户账号ID
 * @returns 是否删除成功
 */
export async function deleteFile(fileId: string, accountId: string): Promise<boolean> {
  if (!fileId || fileId.trim() === '') {
    return false;
  }

  return fileStorage.deleteLocalFile(fileId, accountId);
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
