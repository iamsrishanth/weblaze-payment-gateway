import { type QueryResult as PgQueryResult, Pool, type PoolClient, type QueryResultRow } from "pg";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface TransactionalDatabase extends QueryExecutor {
  transaction<Result>(work: (executor: QueryExecutor) => Promise<Result>): Promise<Result>;
}

function normalizeResult<Row extends QueryResultRow>(result: PgQueryResult<Row>): QueryResult<Row> {
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

export class PostgresDatabase implements TransactionalDatabase {
  constructor(readonly pool: Pool) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    const result = await this.pool.query(sql, values as never[] | undefined);
    return normalizeResult(result as PgQueryResult<Row>);
  }

  async transaction<Result>(work: (executor: QueryExecutor) => Promise<Result>): Promise<Result> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work({
        query: async <Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => {
          const queryResult = await client.query(sql, values as never[] | undefined);
          return normalizeResult(queryResult as PgQueryResult<Row>);
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the operation's original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPostgresDatabase(connectionString: string): PostgresDatabase {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "weblaze-payment-gateway",
  });
  return new PostgresDatabase(pool);
}
