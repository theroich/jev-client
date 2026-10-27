import { DatabaseSync } from "node:sqlite";

/** A row returned by a statement, with columns as plain object keys. */
export type SqliteRow = Record<string, unknown>;

/** Result of a `run` statement. */
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Prepared statement: `run`/`get`/`all` with the calling convention used today. */
export interface SqliteStatement<
  BindParameters extends readonly unknown[] = unknown[],
  Result = SqliteRow,
> {
  run(...params: BindParameters): SqliteRunResult;
  get(...params: BindParameters): Result | undefined;
  all(...params: BindParameters): Result[];
}

/** Synchronous SQLite database built on `node:sqlite`. */
export interface SqliteDatabase {
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): () => T;
  prepare<
    BindParameters extends readonly unknown[] = unknown[],
    Result = SqliteRow,
  >(
    sql: string,
  ): SqliteStatement<BindParameters, Result>;
  close(): void;
}

class SqliteDatabaseImpl implements SqliteDatabase {
  private readonly connection: DatabaseSync;
  private inTransaction = false;

  constructor(path: string) {
    this.connection = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const rows = this.connection.prepare(`PRAGMA ${source}`).all();
    if (options?.simple === true) {
      const first = rows[0];
      if (first === undefined) {
        return undefined;
      }
      return Object.values(first)[0];
    }
    return rows;
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      if (this.inTransaction) {
        throw new Error("nested transactions are not supported");
      }
      this.inTransaction = true;
      this.connection.exec("BEGIN");
      try {
        const result = fn();
        this.connection.exec("COMMIT");
        return result;
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      } finally {
        this.inTransaction = false;
      }
    };
  }

  prepare<
    BindParameters extends readonly unknown[] = unknown[],
    Result = SqliteRow,
  >(sql: string): SqliteStatement<BindParameters, Result> {
    const statement = this.connection.prepare(sql);
    return {
      run: (...params: BindParameters): SqliteRunResult => {
        const result = statement.run(...(params as unknown as never[]));
        return {
          changes: Number(result.changes),
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get: (...params: BindParameters): Result | undefined => {
        const row = statement.get(...(params as unknown as never[]));
        return row === undefined ? undefined : ({ ...row } as Result);
      },
      all: (...params: BindParameters): Result[] => {
        return statement
          .all(...(params as unknown as never[]))
          .map((row) => ({ ...row }) as Result);
      },
    };
  }

  close(): void {
    this.connection.close();
  }
}

/** Opens a SQLite database at `path` (or `":memory:"`) over `node:sqlite`. */
export function openSqlite(path: string): SqliteDatabase {
  return new SqliteDatabaseImpl(path);
}
