import { Pool } from "pg";

/** Read model kept by apps/indexer (PostgreSQL, read-only login). Without DATABASE_URL_API every page reads the chain directly. */
const g = globalThis as { maskbidDb?: Pool }; // one pool across dev hot reloads
export const db = process.env.DATABASE_URL_API
  ? (g.maskbidDb ??= new Pool({ connectionString: process.env.DATABASE_URL_API, options: "-c search_path=maskbid -c statement_timeout=5000", max: 4 }))
  : undefined;

/** NFR-02: a checkpoint older than this is not served; the browser falls back to the chain. */
export const STALE_SECONDS = 30;
