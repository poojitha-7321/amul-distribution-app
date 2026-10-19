import pg from 'pg';
import { config } from './config.js';

// NUMERIC -> JS number (prices/totals fit comfortably in double precision)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// BIGINT (counts, ids) -> number
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// DATE stays as 'YYYY-MM-DD' string
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const res = await db.query<T>(sql, params as any[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T | null> {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

/** Runs fn inside a transaction; rolls back on any thrown error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}
