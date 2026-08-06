export const CODEX_AUTHORIZATION_MODES = ["request_approval", "auto_review", "full_access"] as const;
export type CodexAuthorizationMode = (typeof CODEX_AUTHORIZATION_MODES)[number];

export const DEFAULT_CODEX_AUTHORIZATION_MODE: CodexAuthorizationMode = "request_approval";

export function normalizeCodexAuthorizationMode(value: unknown, legacyFullAuto?: unknown): CodexAuthorizationMode {
  if (CODEX_AUTHORIZATION_MODES.includes(value as CodexAuthorizationMode)) return value as CodexAuthorizationMode;
  return legacyFullAuto === true || legacyFullAuto === 1 || legacyFullAuto === "1" ? "full_access" : DEFAULT_CODEX_AUTHORIZATION_MODE;
}

export function isFullAccessAuthorization(mode: CodexAuthorizationMode): boolean {
  return mode === "full_access";
}
