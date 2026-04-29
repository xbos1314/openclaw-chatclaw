import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | undefined;

export function setChatClawRuntime(r: PluginRuntime) {
  runtime = r;
}

export function getChatClawRuntime(): PluginRuntime | undefined {
  return runtime;
}
