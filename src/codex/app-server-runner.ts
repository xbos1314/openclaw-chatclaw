import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { CodexAuthorizationMode } from "./authorization.js";

export type ExecutionStatus = "idle" | "running" | "waiting_approval" | "stopping" | "interrupted";
export interface CodexApproval { id: string; type: "command" | "file_change" | "permission"; summary: string; requestId: string | number; }
export interface CodexExecution { status: ExecutionStatus; turn_id: string | null; authorization_mode: CodexAuthorizationMode; approval: CodexApproval | null; }

type CompletionListener = (interrupted: boolean) => void;
interface PendingRequest { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }

function summarize(value: unknown, max = 240): string {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 ***")
    .replace(/(^|\s)(--?(?:token|secret|password|api[-_]?key))\s*(?:=|\s+)\s*\S+/gi, "$1$2 ***").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function approvalSummary(method: string, params: Record<string, any>): { type: CodexApproval["type"]; summary: string } {
  if (method.includes("fileChange") || method === "applyPatchApproval") {
    const files = Array.isArray(params.changes) ? params.changes.map((item: any) => item.path ?? item.file_path).filter(Boolean).slice(0, 2).join("、") : "";
    return { type: "file_change", summary: summarize(files ? `请求修改 ${files}` : "请求修改文件") };
  }
  if (method.includes("permissions")) return { type: "permission", summary: summarize(params.reason ?? "请求额外权限") };
  return { type: "command", summary: summarize(params.command ?? params.reason ?? "请求执行命令") };
}

/** 一个会话一个 app-server 连接；所有方法只由 manager 串行调用。 */
export class CodexAppServerRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private completionListeners = new Set<CompletionListener>();
  private initialized = false;
  private interruptionRequested = false;
  readonly execution: CodexExecution = { status: "idle", turn_id: null, authorization_mode: "request_approval", approval: null };

  constructor(private readonly bin: string, private readonly threadId: string, private readonly cwd: string) {}

  onCompleted(listener: CompletionListener): () => void { this.completionListeners.add(listener); return () => this.completionListeners.delete(listener); }

  private async ensureConnected(): Promise<void> {
    if (this.initialized && this.child && !this.child.killed) return;
    this.child = spawn(this.bin, ["app-server", "--stdio"], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.on("exit", () => this.handleExit());
    this.child.on("error", () => this.handleExit());
    await this.request("initialize", { clientInfo: { name: "chatclaw", version: "1.0" }, capabilities: { experimentalApi: true } });
    await this.request("thread/resume", { threadId: this.threadId, cwd: this.cwd, excludeTurns: true });
    this.initialized = true;
  }

  private handleLine(line: string): void {
    let message: Record<string, any>;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(String(message.error.message ?? "Codex app-server 请求失败"))); else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string" && message.params) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method === "turn/completed") {
      const interrupted = this.interruptionRequested || this.execution.status === "stopping";
      this.interruptionRequested = false;
      if (interrupted) this.markInterrupted(); else { this.execution.status = "idle"; this.execution.turn_id = null; this.execution.approval = null; }
      for (const listener of this.completionListeners) listener(interrupted);
    }
  }

  private handleServerRequest(message: Record<string, any>): void {
    const params = message.params as Record<string, any>;
    const method = String(message.method);
    if (!method.includes("requestApproval") && method !== "execCommandApproval" && method !== "applyPatchApproval") return;
    const detail = approvalSummary(method, params);
    const approvalId = String(params.approvalId ?? params.itemId ?? message.id);
    this.execution.status = "waiting_approval";
    this.execution.approval = { id: approvalId, type: detail.type, summary: detail.summary, requestId: message.id };
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex 执行器未连接"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`${method} 超时`)); }, 30_000);
      this.pending.set(String(id), { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async start(input: string, authorizationMode: CodexAuthorizationMode): Promise<void> {
    await this.ensureConnected();
    if (this.execution.status !== "idle" && this.execution.status !== "interrupted") throw new Error("会话正在执行");
    const isFullAccess = authorizationMode === "full_access";
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
      approvalPolicy: isFullAccess ? "never" : authorizationMode === "auto_review" ? "on-request" : "untrusted",
      approvalsReviewer: authorizationMode === "auto_review" ? "auto_review" : "user",
      sandboxPolicy: isFullAccess
        ? { type: "dangerFullAccess" }
        : { type: "workspaceWrite", writableRoots: [this.cwd], networkAccess: false },
    });
    this.execution.status = "running";
    this.interruptionRequested = false;
    this.execution.authorization_mode = authorizationMode;
    this.execution.turn_id = String(result?.turn?.id ?? result?.turnId ?? "") || null;
    this.execution.approval = null;
  }

  async interrupt(): Promise<void> {
    if (!this.execution.turn_id) throw new Error("没有可停止的任务");
    await this.ensureConnected();
    const previousStatus = this.execution.status;
    this.interruptionRequested = true;
    this.execution.status = "stopping";
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.execution.turn_id });
      this.markInterrupted();
    } catch (err) {
      this.interruptionRequested = false;
      this.execution.status = previousStatus;
      throw err;
    }
  }

  async decide(approvalId: string, accept: boolean): Promise<void> {
    const approval = this.execution.approval;
    if (!approval || approval.id !== approvalId) throw new Error("审批请求不存在或已失效");
    if (!this.child?.stdin.writable) throw new Error("Codex 执行器未连接");
    this.child.stdin.write(`${JSON.stringify({ id: approval.requestId, result: { decision: accept ? "accept" : "decline" } })}\n`);
    this.execution.status = "running";
    this.execution.approval = null;
  }

  markInterrupted(): void { this.execution.status = "interrupted"; this.execution.turn_id = null; this.execution.approval = null; }
  close(): void { this.child?.kill("SIGTERM"); this.child = null; this.initialized = false; this.markInterrupted(); }
  private handleExit(): void { this.initialized = false; if (this.execution.status !== "idle") this.markInterrupted(); }
}
