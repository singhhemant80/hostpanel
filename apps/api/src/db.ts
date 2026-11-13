import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "./config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const db = drizzle(pool, { schema });
export type Db = typeof db;
export { schema };

/** Postgres unique-violation → caller turns it into a 409. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}
