import { Type } from "@sinclair/typebox";
import * as manager from "./manager.js";
import { logger } from "../util/logger.js";

/**
 * codex_manager 工具：在 agent 会话中管理本机 Codex 的项目/会话/消息。
 *
 * - 只读 action（projects/find/sessions/read/status/recent）：直接执行
 * - 写 action（send/new）：首次调用返回 need_confirm，需用户确认后带 confirmed=true 再次调用
 */

const CodexManagerSchema = Type.Object({
  action: Type.Union([
    Type.Literal("projects"),
    Type.Literal("find"),
    Type.Literal("sessions"),
    Type.Literal("read"),
    Type.Literal("status"),
    Type.Literal("recent"),
    Type.Literal("send"),
    Type.Literal("new"),
  ]),
  keyword: Type.Optional(Type.String()), // find：项目关键词
  project: Type.Optional(Type.String()), // sessions 过滤 / new：项目路径
  session_id: Type.Optional(Type.String()), // read/status/recent/send：会话 id（支持前缀）
  message: Type.Optional(Type.String()), // send/new：消息内容
  authorization_mode: Type.Optional(Type.Union([Type.Literal("request_approval"), Type.Literal("auto_review"), Type.Literal("full_access")])), // send/new：授权策略
  full_auto: Type.Optional(Type.Boolean()), // 兼容旧调用：true 等同 full_access
  confirmed: Type.Optional(Type.Boolean()), // send/new：用户确认标记
  limit: Type.Optional(Type.Number()), // read：条数
  seconds: Type.Optional(Type.Number()), // recent：秒数
});

interface CodexToolParams {
  action: string;
  keyword?: string;
  project?: string;
  session_id?: string;
  message?: string;
  authorization_mode?: manager.CodexAuthorizationMode;
  full_auto?: boolean;
  confirmed?: boolean;
  limit?: number;
  seconds?: number;
}

export function registerCodexManagerTools(api: any): void {
  api.registerTool({
    name: "codex_manager",
    description:
      "Codex 项目管理工具：查看本机 Codex 的项目/会话/任务状态、读取对话、向会话发消息、新建任务。" +
      "只读操作（projects/find/sessions/read/status/recent）可直接执行；" +
      "send（唤醒会话续跑，可能打断运行中的任务）和 new（新建任务，会修改项目文件）属于外部动作，首次调用返回 need_confirm，需用户明确确认后带 confirmed=true 再次调用。" +
      "authorization_mode 可选 request_approval（请求用户批准）、auto_review（替用户自动审批）或 full_access（完全访问）；完全访问高危，必须用户确认。",
    parameters: CodexManagerSchema,
    execute: async (_toolCallId: string, params: CodexToolParams) => {
      try {
        switch (params.action) {
          case "projects": {
            const page = await manager.listProjects();
            return { ok: true, projects: page.items, has_more: page.has_more };
          }
          case "find": {
            if (!params.keyword?.trim()) {
              return { ok: false, error: "keyword 必填" };
            }
            const page = await manager.listProjects(undefined, undefined, params.keyword.trim());
            return { ok: true, keyword: params.keyword, projects: page.items, has_more: page.has_more };
          }
          case "sessions": {
            const page = await manager.listSessions(params.project?.trim() || undefined);
            return { ok: true, sessions: page.items, has_more: page.has_more };
          }
          case "read": {
            if (!params.session_id?.trim()) {
              return { ok: false, error: "session_id 必填" };
            }
            const result = await manager.getSnapshot(params.session_id.trim(), params.limit ?? 20);
            return { ok: true, ...result };
          }
          case "status": {
            if (!params.session_id?.trim()) {
              return { ok: false, error: "session_id 必填" };
            }
            const result = await manager.getSnapshot(params.session_id.trim(), 1);
            return { ok: true, status: result.status };
          }
          case "recent": {
            if (!params.session_id?.trim()) {
              return { ok: false, error: "session_id 必填" };
            }
            const snapshot = await manager.getSnapshot(params.session_id.trim(), 50);
            const result = await manager.getUpdates(params.session_id.trim(), snapshot.cursor);
            return { ok: true, ...result };
          }
          case "send": {
            if (!params.session_id?.trim() || !params.message?.trim()) {
              return { ok: false, error: "session_id 和 message 必填" };
            }
            const authorizationMode = params.authorization_mode ?? (params.full_auto ? "full_access" : "request_approval");
            if (!params.confirmed) {
              return {
                ok: false,
                need_confirm: true,
                detail:
                  `将唤醒会话 ${params.session_id} 并发送消息，可能打断正在运行的任务。` +
                  `${authorizationMode === "full_access" ? "已开启完全访问模式（Codex 可自主执行所有操作）。" : authorizationMode === "auto_review" ? "将由 Codex 替用户审查需批准的操作。" : ""}` +
                  `请用户确认后以 confirmed=true 重新调用。`,
              };
            }
            const result = await manager.sendMessage(params.session_id.trim(), params.message.trim(), {
              authorizationMode,
            });
            return { ok: true, ...result, authorization_mode: authorizationMode };
          }
          case "new": {
            if (!params.project?.trim() || !params.message?.trim()) {
              return { ok: false, error: "project 和 message 必填" };
            }
            const authorizationMode = params.authorization_mode ?? (params.full_auto ? "full_access" : "request_approval");
            if (!params.confirmed) {
              return {
                ok: false,
                need_confirm: true,
                detail:
                  `将在 ${params.project} 开启新 Codex 任务并修改项目文件。` +
                  `${authorizationMode === "full_access" ? "已开启完全访问模式（Codex 可自主执行所有操作）。" : authorizationMode === "auto_review" ? "将由 Codex 替用户审查需批准的操作。" : ""}` +
                  `请用户确认后以 confirmed=true 重新调用。`,
              };
            }
            const result = await manager.newSession(params.project.trim(), params.message.trim(), {
              authorizationMode,
            });
            return { ok: true, ...result, authorization_mode: authorizationMode };
          }
          default:
            return { ok: false, error: `Unknown action: ${params.action}` };
        }
      } catch (err: any) {
        logger.error(`codex_manager[${params.action}] failed: ${err}`);
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  });
}
