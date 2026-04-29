export const CHATCLAW_CHANNEL_ID = 'openclaw-chatclaw';

export function buildChatClawDirectSessionKey(accountId: string, agentId: string): string {
  return `agent:${agentId}:${CHATCLAW_CHANNEL_ID}:direct:${accountId}`;
}

export function parseAgentIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1] || null;
}

