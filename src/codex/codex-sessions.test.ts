import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CodexSessionsModule = typeof import("./codex-sessions.js");

let tmpDir: string;
let codex: CodexSessionsModule;

/** 生成带偏移秒的 ISO 时间戳 */
const iso = (offsetSec: number): string =>
  new Date(Date.now() - offsetSec * 1000).toISOString();

/** 写入一个完整样本会话文件 */
function writeSession(
  dir: string,
  fileName: string,
  opts: {
    sessionId: string;
    cwd: string;
    originator: string;
    withTaskComplete?: boolean;
    recentSeconds?: number;
  },
): string {
  const file = path.join(tmpDir, dir, fileName);
  const lines = [
    JSON.stringify({
      timestamp: iso(3600),
      type: "session_meta",
      payload: {
        session_id: opts.sessionId,
        cwd: opts.cwd,
        originator: opts.originator,
      },
    }),
    JSON.stringify({
      timestamp: iso(opts.recentSeconds ?? 600),
      type: "response_item",
      payload: {
        role: "user",
        content: [{ type: "input_text", text: "你好，帮我实现登录" }],
      },
    }),
    JSON.stringify({
      timestamp: iso((opts.recentSeconds ?? 600) - 5),
      type: "response_item",
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "好的，开始实现登录页" }],
      },
    }),
    JSON.stringify({
      timestamp: iso(30),
      type: "event_msg",
      payload: { type: "task_started" },
    }),
    JSON.stringify({
      timestamp: iso(10),
      type: "response_item",
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "登录页已完成" }],
      },
    }),
  ];
  if (opts.withTaskComplete) {
    lines.push(
      JSON.stringify({
        timestamp: iso(5),
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
  process.env.CODEX_HOME = tmpDir;
  vi.resetModules();
  codex = await import("./codex-sessions.js");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
});

describe("codex-sessions 核心层", () => {
  const ACTIVE_ID = "019faaaa-1111-2222-3333-444455556666";
  const ARCHIVED_ID = "019fbbbb-aaaa-bbbb-cccc-ddddeeeeffff";

  beforeAll(() => {
    // 活动会话（已完成）
    writeSession(
      path.join("sessions", "2026", "08", "05"),
      `rollout-2026-08-05T10-00-00-${ACTIVE_ID}.jsonl`,
      {
        sessionId: ACTIVE_ID,
        cwd: "/Users/test/proj-a",
        originator: "Codex Desktop",
        withTaskComplete: true,
      },
    );
    // 归档会话（进行中，无 task_complete）
    writeSession(
      path.join("archived_sessions"),
      `rollout-2026-08-04T10-00-00-${ARCHIVED_ID}.jsonl`,
      {
        sessionId: ARCHIVED_ID,
        cwd: "/Users/test/proj-b",
        originator: "codex-tui",
      },
    );
  });

  it("allSessionFiles 扫描活动 + 归档目录", () => {
    const files = codex.allSessionFiles();
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes(ACTIVE_ID))).toBe(true);
    expect(files.some((f) => f.includes(ARCHIVED_ID))).toBe(true);
  });

  it("readMeta 读取 session_id / cwd / originator", () => {
    const file = codex.allSessionFiles().find((f) => f.includes(ACTIVE_ID))!;
    const meta = codex.readMeta(file);
    expect(meta.session_id).toBe(ACTIVE_ID);
    expect(meta.cwd).toBe("/Users/test/proj-a");
    expect(meta.originator).toBe("Codex Desktop");
  });

  it("extractMessages 提取 user/assistant 消息与工具调用标记", () => {
    const file = codex.allSessionFiles().find((f) => f.includes(ACTIVE_ID))!;
    const messages = codex.extractMessages(codex.parseEvents(file));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", text: "你好，帮我实现登录" });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(messages[2]).toMatchObject({ role: "assistant", text: "登录页已完成" });
  });

  it("taskStatus 识别已完成（task_complete）", () => {
    const active = codex.allSessionFiles().find((f) => f.includes(ACTIVE_ID))!;
    const archived = codex.allSessionFiles().find((f) => f.includes(ARCHIVED_ID))!;
    const activeStatus = codex.taskStatus(codex.parseEvents(active));
    const archivedStatus = codex.taskStatus(codex.parseEvents(archived));
    expect(activeStatus.completed).toBe(true);
    expect(activeStatus.lastCompleteTs).not.toBeNull();
    expect(archivedStatus.completed).toBe(false);
  });

  it("findSession 支持前缀匹配与文件名匹配", () => {
    expect(codex.findSession("019faaaa").meta.session_id).toBe(ACTIVE_ID);
    expect(codex.findSession("019fbbbb").meta.session_id).toBe(ARCHIVED_ID);
    // 文件名包含匹配
    expect(codex.findSession(ACTIVE_ID.slice(0, 8)).meta.session_id).toBe(ACTIVE_ID);
    // 不存在
    expect(codex.findSession("zzz").file).toBeNull();
  });

  it("formatTime 输出 MM/DD HH:mm 格式", () => {
    const formatted = codex.formatTime(new Date().toISOString());
    expect(formatted).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(codex.formatTime(null)).toBe("");
    expect(codex.formatTime("invalid")).toBe("invalid");
  });

  it("truncateText 超长截断", () => {
    expect(codex.truncateText("短文本")).toBe("短文本");
    const long = "x".repeat(500);
    const truncated = codex.truncateText(long);
    expect(truncated.endsWith("...")).toBe(true);
    expect(truncated.length).toBeLessThan(500);
  });
});
