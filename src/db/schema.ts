import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "../../data/bin.db");

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA cache_size = -64000");  // 64MB cache
    db.exec("PRAGMA mmap_size = 268435456"); // 256MB mmap
    db.exec("PRAGMA temp_store = MEMORY");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bins (
      bin TEXT PRIMARY KEY,
      brand TEXT,
      type TEXT,
      category TEXT,
      issuer TEXT,
      issuer_url TEXT,
      issuer_phone TEXT,
      country_alpha2 TEXT,
      country_name TEXT,
      country_numeric TEXT,
      country_iso3 TEXT,
      currency TEXT,
      is_commercial INTEGER DEFAULT 0,
      is_prepaid INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bins_brand ON bins(brand);
    CREATE INDEX IF NOT EXISTS idx_bins_type ON bins(type);
    CREATE INDEX IF NOT EXISTS idx_bins_country ON bins(country_alpha2);
    CREATE INDEX IF NOT EXISTS idx_bins_issuer ON bins(issuer);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
