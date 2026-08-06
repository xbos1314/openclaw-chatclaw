import http from "node:http";

import { requireAuth, sendJson } from "./server.js";
import type { ParsedUrl, RequestContext } from "./server.js";
import { getSystemOverview, getTopHomeDiskUsage, getTopProcesses } from "../system/monitor.js";
import { logger } from "../util/logger.js";

export async function handleSystemOverview(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  requireAuth(ctx);
  try {
    sendJson(res, 200, { code: 0, data: await getSystemOverview() });
  } catch (err) {
    logger.error(`system overview failed: ${err}`);
    sendJson(res, 500, { error: "Failed to collect system overview" });
  }
}

export async function handleSystemProcesses(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  parsedUrl: ParsedUrl,
  ctx: RequestContext | null,
): Promise<void> {
  requireAuth(ctx);
  const sort = parsedUrl.searchParams.get("sort");
  if (sort !== "cpu" && sort !== "memory") {
    sendJson(res, 400, { error: "sort must be cpu or memory" });
    return;
  }
  try {
    sendJson(res, 200, { code: 0, data: { sort, processes: await getTopProcesses(sort) } });
  } catch (err) {
    logger.error(`system processes failed: ${err}`);
    sendJson(res, 500, { error: "Failed to collect system processes" });
  }
}

export async function handleSystemDiskUsage(
  res: http.ServerResponse,
  _req: http.IncomingMessage,
  ctx: RequestContext | null,
): Promise<void> {
  requireAuth(ctx);
  try {
    sendJson(res, 200, { code: 0, data: { scope: "home", ...(await getTopHomeDiskUsage()) } });
  } catch (err) {
    logger.error(`system disk usage failed: ${err}`);
    sendJson(res, 500, { error: "Failed to collect disk usage" });
  }
}
