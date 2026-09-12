// Minimal type declaration for the `pg` module (eval center dedicated PostgreSQL pool).
// @types/pg is not installed in the shared node_modules; this shim provides the
// subset of types the eval center uses. Internal-only — not exported.
declare module 'pg' {
  interface QueryResultRow { [key: string]: any }
  interface QueryResult<T extends QueryResultRow = QueryResultRow> {
    rows: T[];
    rowCount: number | null;
    oid: number;
    command: string;
  }
  interface PoolClient {
    query<T extends QueryResultRow = QueryResultRow>(text: string, values?: any[]): Promise<QueryResult<T>>;
    query<T extends QueryResultRow = QueryResultRow>(config: { text: string; values?: any[]; name?: string }): Promise<QueryResult<T>>;
    release(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  interface Pool {
    query<T extends QueryResultRow = QueryResultRow>(text: string, values?: any[]): Promise<QueryResult<T>>;
    connect(): Promise<PoolClient>;
    on(event: string, listener: (...args: any[]) => void): this;
    end(): Promise<void>;
  }
  interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    [key: string]: any;
  }
  const Pool: { new (config?: PoolConfig): Pool };
  export { Pool, PoolClient, QueryResult, QueryResultRow, PoolConfig };
}
