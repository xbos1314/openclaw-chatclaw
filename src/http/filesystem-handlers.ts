import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireAuth, sendJson } from "./server.js";
import type { ParsedUrl, RequestContext } from "./server.js";
import { logger } from "../util/logger.js";

export interface FileSystemEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modified_at: number;
}

export interface FileSystemListing {
  path: string;
  home_path: string;
  parent_path: string | null;
  entries: FileSystemEntry[];
}

class FileSystemBrowseError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export function listHomeFileSystem(
  requestedPath?: string | null,
  options: { homeDir?: string } = {},
): FileSystemListing {
  const homePath = path.resolve(options.homeDir || os.homedir());
  const targetPath = resolveRequestedPath(requestedPath, homePath);
  const homeRealPath = safeRealpath(homePath, 500, "Home directory is unavailable");
  const targetRealPath = safeRealpath(targetPath, 404, "Path not found");

  if (!isSameOrChildPath(targetRealPath, homeRealPath)) {
    throw new FileSystemBrowseError(403, "Path is outside home directory");
  }

  const targetStat = safeStat(targetRealPath, 404, "Path not found");
  if (!targetStat.isDirectory()) {
    throw new FileSystemBrowseError(400, "Path is not a directory");
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(targetRealPath, { withFileTypes: true });
  } catch (err) {
    throw mapFsError(err, "Failed to list directory");
  }

  const entries = dirents
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => toFileSystemEntry(entry, targetRealPath, targetPath))
    .filter((entry): entry is FileSystemEntry => entry != null)
    .sort(compareEntries);

  return {
    path: targetPath,
    home_path: homePath,
    parent_path: isSameOrChildPath(homeRealPath, targetRealPath)
      ? null
      : path.dirname(targetPath),
    entries,
  };
}

export async function handleFileSystemList(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  requireAuth(ctx);

  try {
    const listing = listHomeFileSystem(parsedUrl.searchParams.get("path"));
    sendJson(res, 200, { code: 0, data: listing });
  } catch (err) {
    if (err instanceof FileSystemBrowseError) {
      sendJson(res, err.statusCode, { error: err.message });
      return;
    }
    logger.error(`filesystem_list failed: ${err}`);
    sendJson(res, 500, { error: "Failed to list directory" });
  }
}

function resolveRequestedPath(requestedPath: string | null | undefined, homePath: string): string {
  const rawPath = (requestedPath || "").trim();
  if (!rawPath || rawPath === "~") {
    return homePath;
  }
  if (rawPath.startsWith("~/")) {
    return path.resolve(homePath, rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return path.resolve(rawPath);
  }
  return path.resolve(homePath, rawPath);
}

function safeRealpath(targetPath: string, missingStatus: number, missingMessage: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch (err) {
    throw mapFsError(err, missingMessage, missingStatus);
  }
}

function safeStat(targetPath: string, missingStatus: number, missingMessage: string): fs.Stats {
  try {
    return fs.statSync(targetPath);
  } catch (err) {
    throw mapFsError(err, missingMessage, missingStatus);
  }
}

function toFileSystemEntry(
  dirent: fs.Dirent,
  realParentPath: string,
  displayParentPath: string,
): FileSystemEntry | null {
  const realEntryPath = path.join(realParentPath, dirent.name);
  const displayEntryPath = path.join(displayParentPath, dirent.name);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(realEntryPath);
  } catch {
    return null;
  }

  if (!stats.isDirectory() && !stats.isFile()) {
    return null;
  }

  return {
    name: dirent.name,
    path: displayEntryPath,
    type: stats.isDirectory() ? "directory" : "file",
    size: stats.size,
    modified_at: stats.mtimeMs,
  };
}

function compareEntries(a: FileSystemEntry, b: FileSystemEntry): number {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function isSameOrChildPath(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function mapFsError(err: unknown, fallbackMessage: string, missingStatus = 404): FileSystemBrowseError {
  const code = typeof err === "object" && err != null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new FileSystemBrowseError(missingStatus, fallbackMessage);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FileSystemBrowseError(403, "Permission denied");
  }
  return new FileSystemBrowseError(500, fallbackMessage);
}
