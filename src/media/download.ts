import axios from 'axios';
import fs from 'fs';
import path from 'path';
import * as fileStorage from './fileStorage.js';

/**
 * 下载文件并保存到本地存储
 * @param fileUrl 文件URL（支持远程URL或本地路径如 /files/download/accountId/fileId）
 * @param accountId 用户账号ID
 * @returns 本地文件路径
 */
export async function downloadAndSaveFile(fileUrl: string, accountId: string): Promise<string> {
  // 如果是本地文件URL路径（/files/download/accountId/fileId），直接返回本地路径
  if (fileUrl.startsWith('/files/download/')) {
    // 新格式: /files/download/accountId/fileId
    const parts = fileUrl.replace('/files/download/', '').split('/');
    const fileId = parts.pop();
    const storedAccountId = parts.join('/');
    if (fileId && storedAccountId) {
      const localPath = fileStorage.getFilePath(fileId, storedAccountId);
      if (fs.existsSync(localPath)) {
        return localPath;
      }
      // 文件不存在，抛出错误
      throw new Error(`File not found: ${fileId}`);
    }
  }

  // 如果是本地文件路径且文件存在，直接返回
  if (fs.existsSync(fileUrl)) {
    return fileUrl;
  }

  // 如果是远程 URL，下载到本地
  if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
    const response = await axios.get(fileUrl, { responseType: 'stream' });

    // 从 Content-Disposition header 获取文件名，或从 URL 提取
    let fileName = 'file';
    const contentDisposition = response.headers['content-disposition'];
    if (contentDisposition) {
      const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match) {
        fileName = match[1].replace(/['"]/g, '');
      }
    }
    if (fileName === 'file') {
      fileName = path.basename(fileUrl) || 'file';
    }

    // 获取 content-type
    const contentType = (response.headers['content-type'] as string) || 'application/octet-stream';

    // 确保存储目录存在
    fileStorage.ensureStorageDir(accountId);

    // 使用原始方式保存文件（流式写入）
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tempPath = fileStorage.getFilePath(tempId, accountId);

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', async () => {
        try {
          // 文件下载完成后，保存到正式路径
          const fileInfo = await fileStorage.saveFile(
            fs.readFileSync(tempPath),
            accountId,
            fileName,
            contentType
          );
          // 删除临时文件
          fs.unlinkSync(tempPath);
          resolve(fileStorage.getFilePath(fileInfo.id, accountId));
        } catch (err) {
          reject(err);
        }
      });
      writer.on('error', reject);
    });
  }

  // 未知格式的 URL
  throw new Error(`Unsupported file URL format: ${fileUrl}`);
}

/**
 * 读取本地文件（如果已是本地路径）
 * @param filePath 本地文件路径
 * @returns 文件内容
 */
export function readLocalFile(filePath: string): Buffer | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath);
}
