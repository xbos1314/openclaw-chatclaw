declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: (string | number | null | Uint8Array)[][];
  }

  export class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: (string | number | null | Uint8Array)[]): void;
    exec(sql: string, params?: (string | number | null | Uint8Array)[]): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
