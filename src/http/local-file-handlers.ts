import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getMimeTypeFromFileName, requireAuth, sendJson } from "./server.js";
import type { ParsedUrl, RequestContext } from "./server.js";
import { verifyDownloadToken } from "../auth/token.js";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".log", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss", ".less",
  ".js", ".jsx", ".ts", ".tsx", ".vue", ".java", ".kt", ".kts", ".py", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".cs", ".php", ".rb", ".sh", ".zsh", ".sql", ".swift", ".dart", ".lua", ".ini", ".env",
]);
const SENSITIVE_HOME_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".npmrc", ".config/gcloud"]);

class LocalFileError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export interface LocalFileInfo {
  filePath: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  extension: string;
  isText: boolean;
  isMarkdown: boolean;
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSensitivePath(realPath: string, homePath: string): boolean {
  const relative = path.relative(homePath, realPath).replace(/\\/g, "/");
  const parts = relative.split("/").filter(Boolean);
  if (!parts.length) return true;
  if (SENSITIVE_HOME_DIRECTORIES.has(parts[0])) return true;
  return SENSITIVE_HOME_DIRECTORIES.has(parts.slice(0, 2).join("/"));
}

export async function resolveLocalFile(requestedPath: string): Promise<LocalFileInfo> {
  const requested = String(requestedPath || "").trim();
  if (!requested || !path.isAbsolute(requested)) throw new LocalFileError(400, "path must be an absolute path");
  // Codex Desktop 的截图常位于 /var/folders；/var 文件仍须通过现有下载令牌鉴权后才能访问。
  const [homePath, varPath, realPath] = await Promise.all([
    fsp.realpath(os.homedir()).catch(() => ""),
    fsp.realpath("/var").catch(() => ""),
    fsp.realpath(requested).catch(() => ""),
  ]);
  if (!homePath || !realPath) throw new LocalFileError(404, "File not found");
  const inHome = isSameOrChildPath(realPath, homePath);
  const inVar = Boolean(varPath) && isSameOrChildPath(realPath, varPath);
  if ((!inHome && !inVar) || (inHome && isSensitivePath(realPath, homePath))) {
    throw new LocalFileError(403, "File path is not allowed");
  }
  const stats = await fsp.stat(realPath).catch(() => null);
  if (!stats?.isFile()) throw new LocalFileError(400, "Path is not a regular file");
  const extension = path.extname(realPath).toLowerCase();
  return {
    filePath: realPath,
    fileName: path.basename(realPath),
    fileSize: stats.size,
    contentType: getMimeTypeFromFileName(realPath),
    extension,
    isText: TEXT_EXTENSIONS.has(extension),
    isMarkdown: extension === ".md" || extension === ".markdown",
  };
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof LocalFileError) {
    sendJson(res, err.statusCode, { error: err.message });
    return;
  }
  sendJson(res, 500, { error: "Failed to access local file" });
}

function metadata(info: LocalFileInfo, accountId = "") {
  return {
    file_name: info.fileName,
    file_path: info.filePath,
    file_size: info.fileSize,
    content_type: info.contentType,
    extension: info.extension,
    is_text: info.isText,
    is_markdown: info.isMarkdown,
    view_url: `/files/local/view?account_id=${encodeURIComponent(accountId)}&path=${encodeURIComponent(info.filePath)}`,
  };
}

export async function handleLocalFileMeta(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  try {
    const info = await resolveLocalFile(parsedUrl.searchParams.get("path") || "");
    sendJson(res, 200, { code: 0, data: metadata(info, authCtx.accountId) });
  } catch (err) {
    sendError(res, err);
  }
}

export async function handleLocalFileText(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  const authCtx = requireAuth(ctx);
  try {
    const info = await resolveLocalFile(parsedUrl.searchParams.get("path") || "");
    if (!info.isText) throw new LocalFileError(415, "This file type cannot be displayed as text");
    if (info.fileSize > MAX_TEXT_BYTES) throw new LocalFileError(413, "Text file exceeds the 2 MB preview limit");
    const content = await fsp.readFile(info.filePath, "utf8");
    sendJson(res, 200, { code: 0, data: { ...metadata(info, authCtx.accountId), content } });
  } catch (err) {
    sendError(res, err);
  }
}

export async function handleLocalFileView(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const accountId = parsedUrl.searchParams.get("account_id") || "";
  const token = parsedUrl.searchParams.get("token") || "";
  if (!accountId || !token || !verifyDownloadToken(token, accountId)) {
    sendJson(res, 401, { error: "Invalid or expired download token" });
    return;
  }
  try {
    const info = await resolveLocalFile(parsedUrl.searchParams.get("path") || "");
    const range = req.headers.range;
    let start = 0;
    let end = info.fileSize - 1;
    if (range) {
      const matched = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!matched) {
        res.setHeader("Content-Range", `bytes */${info.fileSize}`);
        res.writeHead(416).end();
        return;
      }
      start = matched[1] ? Number(matched[1]) : 0;
      end = matched[2] ? Number(matched[2]) : end;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= info.fileSize) {
        res.setHeader("Content-Range", `bytes */${info.fileSize}`);
        res.writeHead(416).end();
        return;
      }
      end = Math.min(end, info.fileSize - 1);
    }
    res.setHeader("Content-Type", info.contentType);
    res.setHeader("Content-Disposition", `inline; filename=\"${encodeURIComponent(info.fileName)}\"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", end - start + 1);
    if (range) {
      res.setHeader("Content-Range", `bytes ${start}-${end}/${info.fileSize}`);
      res.writeHead(206);
    } else {
      res.writeHead(200);
    }
    fs.createReadStream(info.filePath, { start, end }).pipe(res);
  } catch (err) {
    sendError(res, err);
  }
}
