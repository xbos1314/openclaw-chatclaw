import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// mock codex CLI 子进程调用
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile, spawn } from "node:child_process";

type CodexSessionsModule = typeof import("./codex-sessions.js");

type ManagerModule = typeof import("./manager.js");

let tmpDir: string;
let manager: ManagerModule;
let codex: CodexSessionsModule;

const iso = (offsetSec: number): string =>
  new Date(Date.now() - offsetSec * 1000).toISOString();

const SESSION_ID = "019fcccc-1111-2222-3333-444455556666";

function writeActiveSession() {
  const dir = path.join(tmpDir, "sessions", "2026", "08", "05");
  const file = path.join(dir, `rollout-2026-08-05T10-00-00-${SESSION_ID}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: iso(3600),
      type: "session_meta",
      payload: { session_id: SESSION_ID, cwd: "/Users/test/codex-project", originator: "Codex Desktop" },
    }),
    JSON.stringify({
      timestamp: iso(60),
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: "开始任务" }] },
    }),
    JSON.stringify({
      timestamp: iso(30),
      type: "response_item",
      payload: { role: "assistant", content: [{ type: "output_text", text: "任务执行中..." }] },
    }),
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mgr-test-"));
  process.env.CODEX_HOME = tmpDir;
  process.env.CODEX_BIN = "/fake/codex";
  writeActiveSession();
  vi.resetModules();
  codex = await import("./codex-sessions.js");
  manager = await import("./manager.js");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_BIN;
});

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  vi.mocked(spawn).mockReset();
});

describe("manager 服务层 - 只读查询", () => {
  it("listProjects 聚合项目与会话数", () => {
    const projects = manager.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "codex-project",
      path: "/Users/test/codex-project",
      sessions: 1,
    });
    expect(projects[0].last_active).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it("findProject 按关键词过滤（大小写不敏感）", () => {
    expect(manager.findProject("CODEX-PROJECT")).toHaveLength(1);
    expect(manager.findProject("不存在")).toHaveLength(0);
  });

  it("listSessions 返回会话列表（含过滤）", () => {
    const all = manager.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: SESSION_ID, project: "codex-project", origin: "Codex Desktop" });
    expect(manager.listSessions("codex-project")).toHaveLength(1);
    expect(manager.listSessions("other")).toHaveLength(0);
  });

  it("readSession 读取最后 N 条消息", () => {
    const result = manager.readSession(SESSION_ID, 1);
    expect(result.session_id).toBe(SESSION_ID);
    expect(result.total).toBe(2);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: "assistant", text: "任务执行中..." });
  });

  it("sessionStatus 返回 running 状态与最后消息", () => {
    const status = manager.sessionStatus(SESSION_ID);
    expect(status.status).toBe("running");
    expect(status.session_id).toBe(SESSION_ID);
    expect(status.project).toBe("/Users/test/codex-project");
    expect(status.last_write_sec).toBeLessThan(5);
    expect(status.last_message).toMatchObject({ role: "assistant", text: "任务执行中..." });
  });

  it("sessionStatus 识别 completed（写入 task_complete 后）", () => {
    const file = codex.allSessionFiles().find((f) => f.includes(SESSION_ID))!;
    fs.appendFileSync(
      file,
      `${JSON.stringify({ timestamp: iso(1), type: "event_msg", payload: { type: "task_complete" } })}\n`,
    );
    expect(manager.sessionStatus(SESSION_ID).status).toBe("completed");
  });

  it("recentMessages 只返回最近 N 秒消息", () => {
    const recent = manager.recentMessages(SESSION_ID, 300);
    expect(recent.total).toBeGreaterThanOrEqual(2);
    expect(recent.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  it("会话不存在抛出 CodexNotFoundError", () => {
    expect(() => manager.sessionStatus("zzz")).toThrowError("找不到会话");
    expect(() => manager.readSession("zzz")).toThrowError("找不到会话");
  });
});

describe("manager 服务层 - 写操作", () => {
  it("sendMessage 调用 codex exec resume 并返回回复", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb(null, "收到，继续处理", "");
      return {} as never;
    });
    const result = await manager.sendMessage(SESSION_ID, "继续");
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "/fake/codex",
      ["exec", "resume", SESSION_ID, "继续"],
      expect.objectContaining({ cwd: "/Users/test/codex-project" }),
      expect.any(Function),
    );
    expect(result).toMatchObject({ session_id: SESSION_ID, exit_code: 0 });
    expect(result.reply).toContain("收到");
  });

  it("sendMessage fullAuto 时追加完全授权参数", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb(null, "ok", "");
      return {} as never;
    });
    await manager.sendMessage(SESSION_ID, "继续", { fullAuto: true });
    const call = vi.mocked(execFile).mock.calls[0];
    expect(call[1]).toEqual([
      "exec",
      "resume",
      "--dangerously-bypass-approvals-and-sandbox",
      SESSION_ID,
      "继续",
    ]);
  });

  it("sendMessage 遇到归档会话时自动 unarchive 后重试", async () => {
    const archivedErr = "Error: thread/resume failed: session is archived. Run `codex unarchive xxx` to unarchive it first.";
    let callCount = 0;
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      callCount += 1;
      if (callCount === 1) {
        // resume 第一次：归档错误
        cb({ code: 1, message: archivedErr }, "", archivedErr);
      } else if (callCount === 2) {
        // unarchive：成功
        cb(null, "unarchived", "");
      } else {
        // resume 重试：成功
        cb(null, "收到，继续", "");
      }
      return {} as never;
    });
    const result = await manager.sendMessage(SESSION_ID, "继续");
    expect(callCount).toBe(3);
    const calls = vi.mocked(execFile).mock.calls;
    expect(calls[1][1]).toEqual(["unarchive", SESSION_ID]);
    expect(calls[2][1]).toEqual(["exec", "resume", SESSION_ID, "继续"]);
    expect(result).toMatchObject({ exit_code: 0, reply: "收到，继续" });
  });

  it("newSession 后台启动任务并返回新会话 id", async () => {
    const projectDir = path.join(tmpDir, "target-project");
    fs.mkdirSync(projectDir, { recursive: true });
    vi.mocked(spawn).mockImplementation((..._args: any[]) => {
      // 模拟 spawn 后 codex 创建了新会话文件
      const newDir = path.join(tmpDir, "sessions", "2026", "08", "05");
      const newId = "019fdddd-1111-2222-3333-444455556666";
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(
        path.join(newDir, `rollout-x-${newId}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { session_id: newId, cwd: projectDir } })}\n`,
      );
      return { unref: vi.fn(), on: vi.fn() } as any;
    });
    const result = await manager.newSession(projectDir, "实现功能");
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "/fake/codex",
      ["exec", "--skip-git-repo-check", "实现功能"],
      expect.objectContaining({ cwd: projectDir, detached: true, stdio: "ignore" }),
    );
    expect(result.session_id).toBe("019fdddd-1111-2222-3333-444455556666");
    expect(result.project).toBe(projectDir);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("后台启动");
  });

  it("newSession fullAuto 时追加完全授权参数", async () => {
    const projectDir = path.join(tmpDir, "target-project2");
    fs.mkdirSync(projectDir, { recursive: true });
    vi.mocked(spawn).mockImplementation((..._args: any[]) => {
      // 同样模拟新会话文件出现，避免 waitForNewSessionFile 等满超时
      const newDir = path.join(tmpDir, "sessions", "2026", "08", "05");
      const newId = "019feeee-1111-2222-3333-444455556666";
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(
        path.join(newDir, `rollout-x-${newId}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { session_id: newId, cwd: projectDir } })}\n`,
      );
      return { unref: vi.fn(), on: vi.fn() } as any;
    });
    await manager.newSession(projectDir, "任务", { fullAuto: true });
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[1]).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "任务",
    ]);
  });

  it("newSession 项目目录不存在时报错且不调用 codex", async () => {
    await expect(manager.newSession("/no/such/dir", "任务")).rejects.toThrowError("项目目录不存在");
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
