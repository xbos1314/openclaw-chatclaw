import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { spawn } from "node:child_process";

type ManagerModule = typeof import("./manager.js");

let tmpDir: string;
let manager: ManagerModule;

const SESSION_ID = "019fcccc-1111-2222-3333-444455556666";
const PROJECT_DIR = "/Users/test/codex-project";

function writeActiveSession(): void {
  const directory = path.join(tmpDir, "sessions", "2026", "08", "05");
  const file = path.join(directory, `rollout-2026-08-05T10-00-00-${SESSION_ID}.jsonl`);
  const lines = [
    { timestamp: "2026-08-05T10:00:00.000Z", type: "session_meta", payload: { session_id: SESSION_ID, cwd: PROJECT_DIR, originator: "Codex Desktop" } },
    { timestamp: "2026-08-05T10:01:00.000Z", type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "开始任务" }] } },
    { timestamp: "2026-08-05T10:02:00.000Z", type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: "任务执行中..." }] } },
  ];
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function mockNewSession(projectDir: string, sessionId: string): void {
  vi.mocked(spawn).mockImplementation((..._args: any[]) => {
    const directory = path.join(tmpDir, "sessions", "2026", "08", "06");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `rollout-2026-08-06T10-00-00-${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd: projectDir } })}\n`,
    );
    return { unref: vi.fn(), on: vi.fn() } as any;
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mgr-test-"));
  process.env.CODEX_HOME = tmpDir;
  process.env.CODEX_BIN = "/fake/codex";
  writeActiveSession();
  vi.resetModules();
  manager = await import("./manager.js");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_BIN;
});

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("manager 服务层 - 只读查询", () => {
  it("listProjects 返回分页项目及会话计数", async () => {
    const page = await manager.listProjects();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ name: "codex-project", path: PROJECT_DIR, sessions: 1 });
    expect(page.items[0].summary).toBe("任务执行中...");
  });

  it("listProjects 按关键词过滤", async () => {
    await expect(manager.listProjects("", 20, "CODEX-PROJECT")).resolves.toMatchObject({ items: [expect.objectContaining({ path: PROJECT_DIR })] });
    await expect(manager.listProjects("", 20, "不存在")).resolves.toMatchObject({ items: [] });
  });

  it("listSessions 返回分页会话并按项目过滤", async () => {
    const all = await manager.listSessions();
    expect(all.items).toEqual([expect.objectContaining({ id: SESSION_ID, project: "codex-project", origin: "Codex Desktop" })]);
    await expect(manager.listSessions(PROJECT_DIR)).resolves.toMatchObject({ items: [expect.objectContaining({ id: SESSION_ID })] });
    await expect(manager.listSessions("other")).resolves.toMatchObject({ items: [] });
  });

  it("getSnapshot 返回当前会话的可见消息和状态", async () => {
    const snapshot = await manager.getSnapshot(SESSION_ID);
    expect(snapshot.session_id).toBe(SESSION_ID);
    expect(snapshot.messages).toEqual([
      expect.objectContaining({ role: "user", text: "开始任务" }),
      expect.objectContaining({ role: "assistant", text: "任务执行中..." }),
    ]);
    expect(snapshot.status).toMatchObject({ session_id: SESSION_ID, project: PROJECT_DIR, status: "running" });
  });

  it("getMessageHistory 只返回请求数量的最新可见消息", async () => {
    const history = await manager.getMessageHistory(SESSION_ID, undefined, 1);
    expect(history.messages).toEqual([expect.objectContaining({ role: "assistant", text: "任务执行中..." })]);
  });

  it("未知会话会抛出 CodexNotFoundError", async () => {
    await expect(manager.getSnapshot("zzz")).rejects.toThrowError("找不到活跃会话");
  });
});

describe("manager 服务层 - 写操作", () => {
  it("sendMessage 要求认证账号", async () => {
    await expect(manager.sendMessage(SESSION_ID, "继续")).rejects.toThrowError("发送消息需要认证账号");
  });

  it("newSession 使用默认的受限授权参数", async () => {
    const projectDir = path.join(tmpDir, "target-project");
    fs.mkdirSync(projectDir, { recursive: true });
    mockNewSession(projectDir, "019fdddd-1111-2222-3333-444455556666");

    const result = await manager.newSession(projectDir, "实现功能");

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "/fake/codex",
      ["exec", "--sandbox", "workspace-write", "-c", 'approval_policy="untrusted"', "--skip-git-repo-check", "实现功能"],
      expect.objectContaining({ cwd: projectDir, detached: true, stdio: "ignore" }),
    );
    expect(result).toMatchObject({ session_id: "019fdddd-1111-2222-3333-444455556666", project: projectDir, exit_code: 0 });
  });

  it("newSession 在完全访问模式下追加绕过审批参数", async () => {
    const projectDir = path.join(tmpDir, "target-project-full-access");
    fs.mkdirSync(projectDir, { recursive: true });
    mockNewSession(projectDir, "019feeee-1111-2222-3333-444455556666");

    await manager.newSession(projectDir, "任务", { fullAuto: true });

    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "任务",
    ]);
  });

  it("newSession 拒绝不存在的项目目录", async () => {
    await expect(manager.newSession("/no/such/dir", "任务")).rejects.toThrowError("项目目录不存在");
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
