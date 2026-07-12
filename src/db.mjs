import pg from 'pg';
import { normalizeCircleError } from '../scripts/shared.mjs';

const { Pool } = pg;

let pool;

function resolvePool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 3000,
      max: 5,
    });

    pool.on('error', (error) => {
      console.warn(`[db] Pool error: ${normalizeCircleError(error).text}`);
    });
  }

  return pool;
}

export async function initDb() {
  const activePool = resolvePool();
  if (!activePool) {
    console.warn('[db] DATABASE_URL is missing; starting without Postgres-backed auth.');
    return false;
  }

  try {
    await activePool.query('SELECT 1');
    console.log('DB connected');
    return true;
  } catch (error) {
    console.warn(`[db] DATABASE_URL is set but the connection check failed; continuing without Postgres-backed auth. ${normalizeCircleError(error).text}`);
    return false;
  }
}

export async function query(text, values = []) {
  const activePool = resolvePool();
  if (!activePool) {
    throw new Error('DATABASE_URL is missing. Postgres-backed auth is unavailable.');
  }

  try {
    return await activePool.query(text, values);
  } catch (error) {
    throw new Error(`Database query failed: ${normalizeCircleError(error).text}`);
  }
}

export async function withTransaction(handler) {
  const activePool = resolvePool();
  if (!activePool) {
    throw new Error('DATABASE_URL is missing. Postgres-backed auth is unavailable.');
  }

  let client;
  try {
    client = await activePool.connect();
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failures so the original error surfaces.
      }
    }
    if (error && typeof error.statusCode === 'number') {
      throw error;
    }

    throw new Error(`Database query failed: ${normalizeCircleError(error).text}`);
  } finally {
    client?.release();
  }
}

export async function closeDb() {
  if (!pool) {
    return;
  }

  const activePool = pool;
  pool = undefined;
  await activePool.end();
}
