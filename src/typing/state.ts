import { logger } from "../util/logger.js";

interface TypingState {
  isTyping: boolean;
  agentId: string;
  lastUpdate: number;
}

const typingStateCache = new Map<string, TypingState>();

function getTypingKey(accountId: string, agentId: string): string {
  return `${accountId}:${agentId}`;
}

export function updateTypingState(accountId: string, agentId: string, isTyping: boolean): void {
  const key = getTypingKey(accountId, agentId);
  typingStateCache.set(key, {
    isTyping,
    agentId,
    lastUpdate: Date.now(),
  });
  logger.debug(`Typing state updated: ${key} -> ${isTyping}`);
}

export function getAccountTypingStates(accountId: string): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const [key, state] of typingStateCache.entries()) {
    if (key.startsWith(`${accountId}:`)) {
      const agentId = key.split(":")[1];
      states[agentId] = state.isTyping;
    }
  }
  return states;
}
