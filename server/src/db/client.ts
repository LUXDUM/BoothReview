import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type { NodePgDatabase };

export function createDb(databaseUrl: string): { db: NodePgDatabase; pool: Pool } {
  // SSL は URL のパラメータで制御できる (将来 Supabase 等へ移す場合に sslmoderequire 等)
  const needsSsl = /sslmode=require/.test(databaseUrl) && !/sslmode=disable/.test(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle(pool);
  return { db, pool };
}
