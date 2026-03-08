import { getDb } from "./schema";
import type { BinRecord } from "../types/bin";

// Prepared statements cache for maximum performance
let stmtLookup: any;
let stmtSearch: any;
let stmtStats: any;
let stmtBrandCount: any;
let stmtTypeCount: any;
let stmtTopCountries: any;
let stmtCount: any;

function getLookupStmt() {
  if (!stmtLookup) {
    stmtLookup = getDb().prepare(`
      SELECT bin, brand, type, category, issuer, issuer_url, issuer_phone,
             country_alpha2, country_name, country_numeric, country_iso3,
             currency, is_commercial, is_prepaid
      FROM bins WHERE bin = ?
    `);
  }
  return stmtLookup;
}

export function lookupBin(bin: string): BinRecord | null {
  const row = getLookupStmt().get(bin);
  if (!row) return null;
  return {
    ...row,
    is_commercial: row.is_commercial === 1,
    is_prepaid: row.is_prepaid === 1,
  } as BinRecord;
}

export function searchBins(params: {
  brand?: string;
  type?: string;
  country?: string;
  issuer?: string;
  limit?: number;
  offset?: number;
}): { data: BinRecord[]; total: number } {
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.brand) {
    conditions.push("brand = ?");
    values.push(params.brand.toUpperCase());
  }
  if (params.type) {
    conditions.push("type = ?");
    values.push(params.type.toLowerCase());
  }
  if (params.country) {
    conditions.push("country_alpha2 = ?");
    values.push(params.country.toUpperCase());
  }
  if (params.issuer) {
    conditions.push("issuer LIKE ?");
    values.push(`%${params.issuer}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(params.limit || 50, 500);
  const offset = params.offset || 0;

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as total FROM bins ${where}`)
    .get(...values) as any;

  const rows = getDb()
    .prepare(
      `SELECT bin, brand, type, category, issuer, issuer_url, issuer_phone,
              country_alpha2, country_name, country_numeric, country_iso3,
              currency, is_commercial, is_prepaid
       FROM bins ${where} LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as any[];

  return {
    total: countRow.total,
    data: rows.map((row: any) => ({
      ...row,
      is_commercial: row.is_commercial === 1,
      is_prepaid: row.is_prepaid === 1,
    })),
  };
}

export function getStats() {
  const db = getDb();

  const totalRow = db.prepare("SELECT COUNT(*) as total FROM bins").get() as any;

  const brands = db
    .prepare(
      "SELECT brand, COUNT(*) as count FROM bins WHERE brand IS NOT NULL GROUP BY brand ORDER BY count DESC"
    )
    .all() as any[];

  const types = db
    .prepare(
      "SELECT type, COUNT(*) as count FROM bins WHERE type IS NOT NULL GROUP BY type ORDER BY count DESC"
    )
    .all() as any[];

  const topCountries = db
    .prepare(
      `SELECT country_name as country, COUNT(*) as count 
       FROM bins WHERE country_name IS NOT NULL 
       GROUP BY country_name ORDER BY count DESC LIMIT 20`
    )
    .all() as any[];

  const lastUpdated = db
    .prepare("SELECT value FROM metadata WHERE key = 'last_updated'")
    .get() as any;

  return {
    total_bins: totalRow.total,
    brands: Object.fromEntries(brands.map((b: any) => [b.brand, b.count])),
    types: Object.fromEntries(types.map((t: any) => [t.type, t.count])),
    top_countries: topCountries,
    last_updated: lastUpdated?.value || "unknown",
  };
}

export function upsertBin(record: BinRecord): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO bins (bin, brand, type, category, issuer, issuer_url, issuer_phone,
                      country_alpha2, country_name, country_numeric, country_iso3,
                      currency, is_commercial, is_prepaid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(bin) DO UPDATE SET
      brand = excluded.brand,
      type = excluded.type,
      category = excluded.category,
      issuer = excluded.issuer,
      issuer_url = excluded.issuer_url,
      issuer_phone = excluded.issuer_phone,
      country_alpha2 = excluded.country_alpha2,
      country_name = excluded.country_name,
      country_numeric = excluded.country_numeric,
      country_iso3 = excluded.country_iso3,
      currency = excluded.currency,
      is_commercial = excluded.is_commercial,
      is_prepaid = excluded.is_prepaid,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    record.bin,
    record.brand,
    record.type,
    record.category,
    record.issuer,
    record.issuer_url,
    record.issuer_phone,
    record.country_alpha2,
    record.country_name,
    record.country_numeric,
    record.country_iso3,
    record.currency,
    record.is_commercial ? 1 : 0,
    record.is_prepaid ? 1 : 0
  );
}

export function bulkUpsertBins(records: BinRecord[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO bins (bin, brand, type, category, issuer, issuer_url, issuer_phone,
                      country_alpha2, country_name, country_numeric, country_iso3,
                      currency, is_commercial, is_prepaid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(bin) DO UPDATE SET
      brand = COALESCE(excluded.brand, bins.brand),
      type = COALESCE(excluded.type, bins.type),
      category = COALESCE(excluded.category, bins.category),
      issuer = COALESCE(excluded.issuer, bins.issuer),
      issuer_url = COALESCE(excluded.issuer_url, bins.issuer_url),
      issuer_phone = COALESCE(excluded.issuer_phone, bins.issuer_phone),
      country_alpha2 = COALESCE(excluded.country_alpha2, bins.country_alpha2),
      country_name = COALESCE(excluded.country_name, bins.country_name),
      country_numeric = COALESCE(excluded.country_numeric, bins.country_numeric),
      country_iso3 = COALESCE(excluded.country_iso3, bins.country_iso3),
      currency = COALESCE(excluded.currency, bins.currency),
      is_commercial = COALESCE(excluded.is_commercial, bins.is_commercial),
      is_prepaid = COALESCE(excluded.is_prepaid, bins.is_prepaid),
      updated_at = excluded.updated_at
  `);

  const insertMany = db.transaction(() => {
    let count = 0;
    for (const record of records) {
      stmt.run(
        record.bin,
        record.brand,
        record.type,
        record.category,
        record.issuer,
        record.issuer_url,
        record.issuer_phone,
        record.country_alpha2,
        record.country_name,
        record.country_numeric,
        record.country_iso3,
        record.currency,
        record.is_commercial ? 1 : 0,
        record.is_prepaid ? 1 : 0
      );
      count++;
    }
    return count;
  });

  const count = insertMany();

  // Update metadata
  db.prepare(
    "INSERT INTO metadata (key, value) VALUES ('last_updated', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();

  return count;
}
