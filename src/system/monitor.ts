import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ServiceStatus = "running" | "stopped" | "not_installed" | "error";

export interface ServiceOverview {
  status: ServiceStatus;
  version?: string;
  message?: string;
  metrics: Record<string, number | string | boolean>;
  items: Array<Record<string, number | string>>;
}

export interface SystemOverview {
  collected_at: number;
  system: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    uptime_seconds: number;
    cpu: { usage_percent: number; logical_cores: number; load_averages: number[] };
    memory: { total_bytes: number; used_bytes: number; free_bytes: number; usage_percent: number };
    disks: Array<{ name: string; total_bytes: number; used_bytes: number; free_bytes: number; usage_percent: number }>;
  };
  gateway: { uptime_seconds: number; memory: { rss_bytes: number; heap_used_bytes: number; heap_total_bytes: number } };
  services: { docker: ServiceOverview; nginx: ServiceOverview; frp: ServiceOverview };
  history: Array<{ timestamp: number; cpu_percent: number; memory_percent: number; gateway_rss_bytes: number }>;
}

export interface SystemProcess {
  name: string;
  cpu_percent: number;
  memory_bytes: number;
}

export interface DiskUsageEntry {
  name: string;
  size_bytes: number;
}

interface CpuTime { idle: number; total: number; }
interface CommandResult { ok: boolean; stdout: string; stderr: string; error: string; }

const SAMPLE_INTERVAL_MS = 5_000;
const HISTORY_LIMIT = 60;
const COMMAND_TIMEOUT_MS = 3_000;
const COMMAND_BUFFER_BYTES = 512 * 1024;
const NGINX_CONFIG_BUFFER_BYTES = 2 * 1024 * 1024;
const DISK_USAGE_CACHE_MS = 60_000;
const FRP_LAUNCH_AGENT_LABEL = "com.chatclaw.frpc";
const FRP_DIRECTORY = process.env.FRP_DIRECTORY || path.join(os.homedir(), "Documents", "frp-client");
const FRP_CONFIG_PATH = process.env.FRP_CONFIG_PATH || path.join(FRP_DIRECTORY, "frpc.toml");
const FRP_EXECUTABLE = process.env.FRP_EXECUTABLE || path.join(FRP_DIRECTORY, "frpc");
let diskUsageCache: { collectedAt: number; entries: DiskUsageEntry[] } | null = null;

function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function cleanVersion(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function currentCpuTime(): CpuTime {
  return os.cpus().reduce<CpuTime>((sum, cpu) => {
    const times = cpu.times;
    sum.idle += times.idle;
    sum.total += times.user + times.nice + times.sys + times.idle + times.irq;
    return sum;
  }, { idle: 0, total: 0 });
}

async function findExecutable(command: string): Promise<string | null> {
  const paths = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const parent of paths) {
    const candidate = path.join(parent, command);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue searching PATH
    }
  }
  return null;
}

function runCommand(command: string, args: string[], maxBuffer = COMMAND_BUFFER_BYTES): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error instanceof Error ? error.message : "",
      });
    });
  });
}

function stripNginxComments(source: string): string {
  let result = "";
  let quote = "";
  let escaped = false;
  let inComment = false;
  for (const character of source) {
    if (inComment) {
      if (character === "\n") {
        inComment = false;
        result += character;
      }
      continue;
    }
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === "#") {
      inComment = true;
    } else {
      result += character;
    }
  }
  return result;
}

function findNginxServerBlocks(source: string): string[] {
  const blocks: string[] = [];
  const config = stripNginxComments(source);
  const serverPattern = /(^|\s)server\s*\{/g;
  let matched: RegExpExecArray | null;
  while ((matched = serverPattern.exec(config))) {
    const opening = config.indexOf("{", matched.index);
    let depth = 1;
    let quote = "";
    let escaped = false;
    let cursor = opening + 1;
    for (; cursor < config.length && depth > 0; cursor += 1) {
      const character = config[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (depth === 0) {
      blocks.push(config.slice(opening + 1, cursor - 1));
      serverPattern.lastIndex = cursor;
    }
  }
  return blocks;
}

function readTopLevelNginxDirectives(block: string): string[] {
  const directives: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const character of block) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === "{") {
      depth += 1;
      current += character;
    } else if (character === "}") {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if (character === ";" && depth === 0) {
      const directive = current.trim();
      if (directive) directives.push(directive);
      current = "";
    } else {
      current += character;
    }
  }
  return directives;
}

function parseNginxServers(configDump: string): Array<Record<string, string>> {
  return findNginxServerBlocks(configDump).map((block, index) => {
    const values: Record<string, string[]> = { listen: [], server_name: [], root: [] };
    readTopLevelNginxDirectives(block).forEach((directive) => {
      const matched = /^(listen|server_name|root)\s+(.+)$/i.exec(directive);
      if (matched) values[matched[1].toLowerCase()].push(matched[2].trim());
    });
    const serverName = values.server_name.join(" ").trim();
    return {
      name: serverName || `默认服务 ${index + 1}`,
      server_name: serverName || "默认服务",
      listen: values.listen.join("、") || "未配置",
      root: values.root[0] || "未配置",
    };
  }).slice(0, 30);
}

interface FrpProxy extends Record<string, string> {
  name: string;
  type: string;
  local: string;
  remote: string;
}

function cleanTomlValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseFrpConfig(source: string): { server: string; proxies: FrpProxy[] } {
  const general: Record<string, string> = {};
  const proxies: Array<Record<string, string>> = [];
  let currentProxy: Record<string, string> | null = null;
  stripNginxComments(source).split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "[[proxies]]") {
      currentProxy = {};
      proxies.push(currentProxy);
      return;
    }
    if (trimmed.startsWith("[")) {
      currentProxy = null;
      return;
    }
    const matched = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!matched) return;
    const target = currentProxy || general;
    target[matched[1]] = cleanTomlValue(matched[2]);
  });
  const serverAddress = general.serverAddr || general.server_addr || "未配置";
  const serverPort = general.serverPort || general.server_port || "";
  return {
    server: serverPort ? `${serverAddress}:${serverPort}` : serverAddress,
    proxies: proxies.map((proxy, index) => {
      const localAddress = proxy.localIP || proxy.local_ip || "127.0.0.1";
      const localPort = proxy.localPort || proxy.local_port || "未配置";
      const remotePort = proxy.remotePort || proxy.remote_port;
      const domains = proxy.customDomains || proxy.custom_domains || proxy.subdomain;
      return {
        name: proxy.name || `未命名穿透 ${index + 1}`,
        type: proxy.type || "tcp",
        local: `${localAddress}:${localPort}`,
        remote: remotePort ? `${serverAddress}:${remotePort}` : domains ? cleanTomlValue(domains).replace(/[\[\]"]/g, "") : "未配置",
      };
    }),
  };
}

function unavailable(message: string): ServiceOverview {
  return { status: "not_installed", message, metrics: {}, items: [] };
}

function failed(message: string): ServiceOverview {
  return { status: "error", message, metrics: {}, items: [] };
}

async function collectDocker(): Promise<ServiceOverview> {
  const executable = await findExecutable("docker");
  if (!executable) return unavailable("Docker 未安装");

  const [version, info] = await Promise.all([
    runCommand(executable, ["--version"]),
    runCommand(executable, ["info", "--format", "{{json .}}"]),
  ]);
  if (!info.ok) {
    return { status: "stopped", version: cleanVersion(version.stdout || version.stderr), message: "Docker Engine 未运行或当前账号无访问权限", metrics: {}, items: [] };
  }

  let infoData: Record<string, unknown> = {};
  try { infoData = JSON.parse(info.stdout) as Record<string, unknown>; } catch { /* summary remains available */ }
  const [containers, stats] = await Promise.all([
    runCommand(executable, ["ps", "-a", "--format", "{{json .}}"]),
    runCommand(executable, ["stats", "--no-stream", "--format", "{{json .}}"]),
  ]);
  const containerItems: Array<{ name: string; state: string; image: string; ports: string }> = [];
  if (containers.ok) {
    containers.stdout.split("\n").filter(Boolean).forEach((line) => {
      try {
        const value = JSON.parse(line) as Record<string, string>;
        containerItems.push({
          name: String(value.Names || "未命名容器"),
          state: String(value.State || "unknown"),
          image: String(value.Image || ""),
          ports: String(value.Ports || "未映射端口"),
        });
      } catch {
        // Ignore a malformed container line while keeping other containers visible.
      }
    });
  }
  const statMap = new Map<string, Record<string, string>>();
  if (stats.ok) {
    stats.stdout.split("\n").filter(Boolean).forEach((line) => {
      try {
        const value = JSON.parse(line) as Record<string, string>;
        statMap.set(String(value.Name || ""), value);
      } catch { /* ignore malformed command line */ }
    });
  }
  const items = containerItems.slice(0, 12).map((item) => {
    const stat = statMap.get(String(item.name));
    return { ...item, cpu: String(stat?.CPUPerc || "—"), memory: String(stat?.MemUsage || "—") };
  });
  const running = containerItems.filter((item) => String(item.state).toLowerCase() === "running").length;
  return {
    status: "running",
    version: cleanVersion(version.stdout || version.stderr),
    metrics: { containers_total: containerItems.length, containers_running: running, images: Number(infoData.Images || 0), server_version: String(infoData.ServerVersion || "") },
    items,
  };
}

async function collectNginx(): Promise<ServiceOverview> {
  const executable = await findExecutable("nginx");
  if (!executable) return unavailable("Nginx 未安装");
  const [version, configCheck, processCheck, configDump] = await Promise.all([
    runCommand(executable, ["-v"]),
    runCommand(executable, ["-t"]),
    runCommand("/usr/bin/pgrep", ["-f", "nginx: (master|worker) process"]),
    runCommand(executable, ["-T"], NGINX_CONFIG_BUFFER_BYTES),
  ]);
  const items = configDump.ok ? parseNginxServers(`${configDump.stdout}\n${configDump.stderr}`) : [];
  const processes = processCheck.ok ? processCheck.stdout.split("\n").filter(Boolean).length : 0;
  if (!processes) {
    return { status: "stopped", version: cleanVersion(version.stdout || version.stderr), message: "Nginx 未启动", metrics: { config_valid: configCheck.ok }, items };
  }
  return {
    status: "running",
    version: cleanVersion(version.stdout || version.stderr),
    metrics: { processes, config_valid: configCheck.ok, servers: items.length },
    items,
  };
}

async function collectFrp(): Promise<ServiceOverview> {
  try {
    await Promise.all([fs.access(FRP_EXECUTABLE, fs.constants.X_OK), fs.access(FRP_CONFIG_PATH, fs.constants.R_OK)]);
  } catch {
    return unavailable("FRP 客户端或配置文件未找到");
  }
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
  const [version, configSource, launchd, processList] = await Promise.all([
    runCommand(FRP_EXECUTABLE, ["--version"]),
    fs.readFile(FRP_CONFIG_PATH, "utf8"),
    runCommand("/bin/launchctl", ["print", `gui/${userId}/${FRP_LAUNCH_AGENT_LABEL}`]),
    runCommand("/bin/ps", ["-Ao", "pid=,comm=,args="]),
  ]);
  const config = parseFrpConfig(configSource);
  const running = processList.stdout.split("\n").some((line) => line.includes(FRP_EXECUTABLE) && line.includes(FRP_CONFIG_PATH));
  const managed = launchd.ok;
  if (!managed) return { status: "stopped", version: cleanVersion(version.stdout || version.stderr), message: "FRP LaunchAgent 未加载", metrics: { proxies_total: config.proxies.length, proxies_running: 0 }, items: config.proxies };
  if (!running) return { status: "stopped", version: cleanVersion(version.stdout || version.stderr), message: "FRP 服务未运行", metrics: { proxies_total: config.proxies.length, proxies_running: 0 }, items: config.proxies };
  return {
    status: "running",
    version: cleanVersion(version.stdout || version.stderr),
    message: `服务端 ${config.server}`,
    metrics: { proxies_total: config.proxies.length, proxies_running: config.proxies.length },
    items: config.proxies,
  };
}

class SystemMonitor {
  private previousCpu: CpuTime | null = null;
  private snapshot: SystemOverview | null = null;
  private refreshing: Promise<SystemOverview> | null = null;
  private history: SystemOverview["history"] = [];

  constructor() {
    const timer = setInterval(() => { void this.refresh(); }, SAMPLE_INTERVAL_MS);
    timer.unref();
  }

  async getOverview(): Promise<SystemOverview> {
    if (!this.snapshot || Date.now() - this.snapshot.collected_at >= SAMPLE_INTERVAL_MS) return this.refresh();
    return this.snapshot;
  }

  private async refresh(): Promise<SystemOverview> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.collect().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async collect(): Promise<SystemOverview> {
    const currentCpu = currentCpuTime();
    const cpuUsage = this.previousCpu
      ? clampPercent((1 - (currentCpu.idle - this.previousCpu.idle) / Math.max(1, currentCpu.total - this.previousCpu.total)) * 100)
      : 0;
    this.previousCpu = currentCpu;
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = Math.max(0, totalMemory - freeMemory);
    const memoryUsage = clampPercent(usedMemory / Math.max(1, totalMemory) * 100);
    const [diskResult, docker, nginx, frp] = await Promise.all([
      fs.statfs("/").catch(() => null), collectDocker(), collectNginx(), collectFrp(),
    ]);
    const disk = diskResult ? (() => {
      const blockSize = Number(diskResult.bsize || 1);
      const total = Number(diskResult.blocks) * blockSize;
      const free = Number(diskResult.bavail) * blockSize;
      const used = Math.max(0, total - free);
      return { name: "/", total_bytes: total, used_bytes: used, free_bytes: free, usage_percent: clampPercent(used / Math.max(1, total) * 100) };
    })() : null;
    const processMemory = process.memoryUsage();
    const point = { timestamp: Date.now(), cpu_percent: cpuUsage, memory_percent: memoryUsage, gateway_rss_bytes: processMemory.rss };
    this.history = [...this.history, point].slice(-HISTORY_LIMIT);
    this.snapshot = {
      collected_at: point.timestamp,
      system: {
        hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(), uptime_seconds: Math.round(os.uptime()),
        cpu: { usage_percent: cpuUsage, logical_cores: os.availableParallelism(), load_averages: os.loadavg().map((value) => Math.round(value * 100) / 100) },
        memory: { total_bytes: totalMemory, used_bytes: usedMemory, free_bytes: freeMemory, usage_percent: memoryUsage },
        disks: disk ? [disk] : [],
      },
      gateway: { uptime_seconds: Math.round(process.uptime()), memory: { rss_bytes: processMemory.rss, heap_used_bytes: processMemory.heapUsed, heap_total_bytes: processMemory.heapTotal } },
      services: { docker, nginx, frp },
      history: this.history,
    };
    return this.snapshot;
  }
}

const monitor = new SystemMonitor();

export function getSystemOverview(): Promise<SystemOverview> {
  return monitor.getOverview();
}

export async function getTopProcesses(sort: "cpu" | "memory"): Promise<SystemProcess[]> {
  const executable = await findExecutable("ps");
  if (!executable) throw new Error("System process command is unavailable");
  const result = await runCommand(executable, ["-Ao", "pid=,pcpu=,rss=,comm="]);
  if (!result.ok) throw new Error("Failed to read system processes");
  const processes = result.stdout.split("\n").map((line): SystemProcess | null => {
    const matched = /^\s*\d+\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!matched) return null;
    return {
      name: path.basename(matched[3]) || matched[3],
      cpu_percent: Math.max(0, Number(matched[1]) || 0),
      memory_bytes: Math.max(0, Number(matched[2]) || 0) * 1024,
    };
  }).filter((item): item is SystemProcess => item != null);
  return processes
    .filter((item) => sort === "cpu" ? item.cpu_percent > 0 : item.memory_bytes > 0)
    .sort((a, b) => sort === "cpu" ? b.cpu_percent - a.cpu_percent : b.memory_bytes - a.memory_bytes)
    .slice(0, 10);
}

export async function getTopHomeDiskUsage(): Promise<{ collected_at: number; entries: DiskUsageEntry[] }> {
  if (diskUsageCache && Date.now() - diskUsageCache.collectedAt < DISK_USAGE_CACHE_MS) {
    return { collected_at: diskUsageCache.collectedAt, entries: diskUsageCache.entries };
  }
  const [du, homePath, entries] = await Promise.all([
    findExecutable("du"),
    Promise.resolve(os.homedir()),
    fs.readdir(os.homedir(), { withFileTypes: true }),
  ]);
  if (!du) throw new Error("Disk usage command is unavailable");
  const targets = entries
    // macOS protects many descendants in ~/Library; scanning it makes the whole batch time out.
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "Library" && (entry.isDirectory() || entry.isFile()))
    .map((entry) => path.join(homePath, entry.name));
  if (!targets.length) return { collected_at: Date.now(), entries: [] };
  const result = await runCommand(du, ["-sk", ...targets]);
  const knownNames = new Map(targets.map((target) => [target, path.basename(target)]));
  const usageEntries = result.stdout.split("\n").map((line): DiskUsageEntry | null => {
    const matched = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!matched) return null;
    const name = knownNames.get(matched[2]);
    if (!name) return null;
    return { name, size_bytes: Number(matched[1]) * 1024 };
  }).filter((item): item is DiskUsageEntry => item != null)
    .sort((a, b) => b.size_bytes - a.size_bytes)
    .slice(0, 10);
  if (!usageEntries.length && !result.ok) throw new Error("Failed to read home directory usage");
  const collectedAt = Date.now();
  diskUsageCache = { collectedAt, entries: usageEntries };
  return { collected_at: collectedAt, entries: usageEntries };
}
