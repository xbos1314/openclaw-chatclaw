type LogFn = (msg: string) => void;

class Logger {
  private accountId?: string;

  withAccount(accountId: string): Logger {
    const child = new Logger();
    child.accountId = accountId;
    return child;
  }

  info(msg: string) {
    console.log(`[chatclaw${this.accountId ? `@${this.accountId}` : ""}] ${msg}`);
  }

  warn(msg: string) {
    console.warn(`[chatclaw${this.accountId ? `@${this.accountId}` : ""}] WARN: ${msg}`);
  }

  error(msg: string) {
    console.error(`[chatclaw${this.accountId ? `@${this.accountId}` : ""}] ERROR: ${msg}`);
  }

  debug(msg: string) {
    if (process.env.DEBUG) {
      console.log(`[chatclaw${this.accountId ? `@${this.accountId}` : ""}] DEBUG: ${msg}`);
    }
  }
}

export const logger = new Logger();
