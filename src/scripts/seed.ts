/**
 * BIN Data Downloader & Seeder
 * 
 * Aggregates BIN data from multiple FREE sources:
 * 
 * Source 1: Bes-js/binfo (SQLite, 369K+ records, most complete - has currency, iso3)
 * Source 2: iannuttall/binlist-data (CSV, 343K records, archived but still accessible)
 * Source 3: binlist/data (CSV ranges, 5.8K records, official binlist.net repo)
 * Source 4: Known IIN/BIN ranges from ISO/IEC 7812 standard
 * 
 * After merging & deduplication: ~370K+ unique BINs
 * 
 * Run: bun run seed
 */

import { Database } from "bun:sqlite";
import { bulkUpsertBins } from "../db/queries";
import { getDb, closeDb } from "../db/schema";
import type { BinRecord } from "../types/bin";
import { existsSync, mkdirSync, unlinkSync, readFileSync } from "fs";
import path from "path";

const DATA_DIR = path.join(import.meta.dir, "../../data");
const CACHE_DIR = path.join(DATA_DIR, "cache");

if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// ============================================================
// Source 1: Bes-js/binfo SQLite database (369K+ records)
// Most complete: has currency, country_iso3, bank_phone
// https://github.com/Bes-js/binfo
// ============================================================
async function fetchBinfoDatabase(): Promise<BinRecord[]> {
  console.log("📥 [Source 1] Downloading binfo SQLite database (Bes-js/binfo)...");
  console.log("   Repository: https://github.com/Bes-js/binfo");
  const records: BinRecord[] = [];
  const sqlitePath = path.join(CACHE_DIR, "binfo.sqlite");

  try {
    const url = "https://raw.githubusercontent.com/Bes-js/binfo/main/binList.sqlite";
    console.log(`  Downloading: ${url}`);
    
    const response = await fetch(url, {
      headers: { "User-Agent": "BIN-API-Builder/1.0" },
      signal: AbortSignal.timeout(120000), // 2 min timeout for 27MB file
    });

    if (!response.ok) {
      console.log(`  ❌ HTTP ${response.status}`);
      return records;
    }

    const buffer = await response.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    await Bun.write(sqlitePath, uint8);
    console.log(`  ✅ Downloaded ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB`);

    // Open the downloaded SQLite and read all records
    const srcDb = new Database(sqlitePath, { readonly: true });
    const rows = srcDb.prepare(`
      SELECT bin, cardBrand, cardType, cardLevel, bankName, bankWebsite, 
             bankPhone, countryName, countryCode, countryIso3, currency
      FROM binlist
    `).all() as any[];

    for (const row of rows) {
      const bin = String(row.bin).replace(/\D/g, "");
      if (!bin || bin.length < 3 || bin.length > 8) continue;

      records.push({
        bin: bin.padEnd(8, "0").substring(0, 8),
        brand: normalizeField(row.cardBrand),
        type: normalizeType(row.cardType),
        category: normalizeField(row.cardLevel),
        issuer: normalizeField(row.bankName),
        issuer_url: normalizeField(row.bankWebsite),
        issuer_phone: normalizeField(row.bankPhone),
        country_alpha2: normalizeField(row.countryCode)?.substring(0, 2)?.toUpperCase() || null,
        country_name: normalizeField(row.countryName),
        country_numeric: null,
        country_iso3: normalizeField(row.countryIso3)?.toUpperCase() || null,
        currency: normalizeField(row.currency)?.toUpperCase() || null,
        is_commercial: false,
        is_prepaid: row.cardType?.toLowerCase().includes("prepaid") || 
                    row.cardLevel?.toLowerCase().includes("prepaid") || false,
      });
    }

    srcDb.close();
    console.log(`  ✅ Extracted ${records.length} BIN records from binfo database`);
  } catch (e: any) {
    console.log(`  ❌ Failed: ${e.message}`);
  }

  return records;
}

// ============================================================
// Source 2: iannuttall/binlist-data (CSV, 343K records)
// Archived since 2020 but data still accessible
// https://github.com/iannuttall/binlist-data
// ============================================================
async function fetchIannuttallData(): Promise<BinRecord[]> {
  console.log("📥 [Source 2] Fetching iannuttall/binlist-data CSV...");
  console.log("   Repository: https://github.com/iannuttall/binlist-data (archived)");
  const records: BinRecord[] = [];

  try {
    const url = "https://raw.githubusercontent.com/iannuttall/binlist-data/master/binlist-data.csv";
    console.log(`  Downloading: ${url}`);
    
    const response = await fetch(url, {
      headers: { "User-Agent": "BIN-API-Builder/1.0" },
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      console.log(`  ❌ HTTP ${response.status}`);
      return records;
    }

    const text = await response.text();
    const lines = text.trim().split("\n");
    // Header: bin,brand,type,category,issuer,alpha_2,alpha_3,country,latitude,longitude,bank_phone,bank_url
    const headerFields = lines[0].split(",").map((s) => s.trim());

    console.log(`  ✅ Got ${lines.length - 1} rows`);

    for (let i = 1; i < lines.length; i++) {
      try {
        const parts = lines[i].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
        const bin = parts[0]?.replace(/\D/g, "");
        if (!bin || bin.length < 3 || bin.length > 8) continue;

        records.push({
          bin: bin.padEnd(8, "0").substring(0, 8),
          brand: normalizeField(parts[1]),
          type: normalizeType(parts[2]),
          category: normalizeField(parts[3]),
          issuer: normalizeField(parts[4]),
          issuer_url: normalizeField(parts[11]),     // bank_url
          issuer_phone: normalizeField(parts[10]),   // bank_phone
          country_alpha2: normalizeField(parts[5])?.substring(0, 2)?.toUpperCase() || null,  // alpha_2
          country_name: normalizeField(parts[7]),    // country
          country_numeric: null,
          country_iso3: normalizeField(parts[6])?.toUpperCase() || null,  // alpha_3
          currency: null, // not available in this source
          is_commercial: false,
          is_prepaid: parts[2]?.toLowerCase().includes("prepaid") || false,
        });
      } catch {
        // Skip malformed rows
      }
    }

    console.log(`  ✅ Parsed ${records.length} BIN records`);
  } catch (e: any) {
    console.log(`  ❌ Failed: ${e.message}`);
  }

  return records;
}

// ============================================================
// Source 3: binlist/data ranges.csv (5.8K records)
// Official binlist.net data repo (651 stars)
// https://github.com/binlist/data
// ============================================================
async function fetchBinlistOfficialData(): Promise<BinRecord[]> {
  console.log("📥 [Source 3] Fetching binlist/data ranges.csv...");
  console.log("   Repository: https://github.com/binlist/data (651 stars)");
  const records: BinRecord[] = [];

  try {
    const url = "https://raw.githubusercontent.com/binlist/data/master/ranges.csv";
    console.log(`  Downloading: ${url}`);
    
    const response = await fetch(url, {
      headers: { "User-Agent": "BIN-API-Builder/1.0" },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.log(`  ❌ HTTP ${response.status}`);
      return records;
    }

    const text = await response.text();
    const lines = text.trim().split("\n");
    // Header: iin_start,iin_end,number_length,number_luhn,scheme,brand,type,prepaid,country,bank_name,bank_logo,bank_url,bank_phone,bank_city

    console.log(`  ✅ Got ${lines.length - 1} rows`);

    for (let i = 1; i < lines.length; i++) {
      try {
        const parts = lines[i].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
        const bin = parts[0]?.replace(/\D/g, "");
        if (!bin || bin.length < 3 || bin.length > 8) continue;

        records.push({
          bin: bin.padEnd(8, "0").substring(0, 8),
          brand: normalizeField(parts[4])?.toUpperCase() || null,  // scheme
          type: normalizeType(parts[6]),                            // type
          category: normalizeField(parts[5]),                       // brand (e.g. "Diners Club International")
          issuer: normalizeField(parts[9]),                         // bank_name
          issuer_url: normalizeField(parts[11]),                    // bank_url
          issuer_phone: normalizeField(parts[12]),                  // bank_phone
          country_alpha2: normalizeField(parts[8])?.substring(0, 2)?.toUpperCase() || null,  // country
          country_name: null,
          country_numeric: null,
          country_iso3: null,
          currency: null,
          is_commercial: false,
          is_prepaid: parts[7]?.toLowerCase() === "yes" || parts[7]?.toLowerCase() === "true" || false,
        });
      } catch {
        // Skip malformed rows
      }
    }

    console.log(`  ✅ Parsed ${records.length} BIN records`);
  } catch (e: any) {
    console.log(`  ❌ Failed: ${e.message}`);
  }

  return records;
}

// ============================================================
// Source 4: Known IIN/BIN ranges from ISO/IEC 7812 standard
// ============================================================
function generateKnownBinRanges(): BinRecord[] {
  console.log("📥 [Source 4] Generating known BIN ranges from IIN standards...");
  const records: BinRecord[] = [];

  const ranges = [
    { prefix: "4", brand: "VISA", type: "credit" },
    { prefix: "51", brand: "MASTERCARD", type: "credit" },
    { prefix: "52", brand: "MASTERCARD", type: "credit" },
    { prefix: "53", brand: "MASTERCARD", type: "credit" },
    { prefix: "54", brand: "MASTERCARD", type: "credit" },
    { prefix: "55", brand: "MASTERCARD", type: "credit" },
    { prefix: "34", brand: "AMERICAN EXPRESS", type: "credit" },
    { prefix: "37", brand: "AMERICAN EXPRESS", type: "credit" },
    { prefix: "6011", brand: "DISCOVER", type: "credit" },
    { prefix: "65", brand: "DISCOVER", type: "credit" },
    { prefix: "3528", brand: "JCB", type: "credit" },
    { prefix: "3589", brand: "JCB", type: "credit" },
    { prefix: "36", brand: "DINERS CLUB", type: "credit" },
    { prefix: "38", brand: "DINERS CLUB", type: "credit" },
    { prefix: "62", brand: "UNIONPAY", type: "credit" },
    { prefix: "5018", brand: "MAESTRO", type: "debit" },
    { prefix: "5020", brand: "MAESTRO", type: "debit" },
    { prefix: "5038", brand: "MAESTRO", type: "debit" },
    { prefix: "60", brand: "RUPAY", type: "debit" },
    { prefix: "508", brand: "RUPAY", type: "debit" },
    { prefix: "2200", brand: "MIR", type: "debit" },
    { prefix: "2201", brand: "MIR", type: "debit" },
    { prefix: "2202", brand: "MIR", type: "debit" },
    { prefix: "2203", brand: "MIR", type: "debit" },
    { prefix: "2204", brand: "MIR", type: "debit" },
  ];

  for (const range of ranges) {
    records.push({
      bin: range.prefix.padEnd(8, "0"),
      brand: range.brand,
      type: range.type,
      category: null,
      issuer: null,
      issuer_url: null,
      issuer_phone: null,
      country_alpha2: null,
      country_name: null,
      country_numeric: null,
      country_iso3: null,
      currency: null,
      is_commercial: null,
      is_prepaid: false,
    });
  }

  console.log(`  ✅ Generated ${records.length} known BIN range entries`);
  return records;
}

// ============================================================
// Utilities
// ============================================================
function normalizeField(val: string | undefined | null): string | null {
  if (!val || val.trim() === "" || val.trim() === "-" || val.trim().toLowerCase() === "null") {
    return null;
  }
  return val.trim();
}

function normalizeType(val: string | undefined | null): string | null {
  if (!val) return null;
  const lower = val.trim().toLowerCase();
  if (lower.includes("debit")) return "debit";
  if (lower.includes("credit")) return "credit";
  if (lower.includes("prepaid")) return "prepaid";
  if (lower.includes("charge")) return "charge";
  return normalizeField(val);
}

function countFields(record: BinRecord): number {
  return Object.values(record).filter((v) => v !== null && v !== "" && v !== false).length;
}

/**
 * Merge two BinRecords, preferring non-null values
 */
function mergeRecords(existing: BinRecord, incoming: BinRecord): BinRecord {
  return {
    bin: existing.bin,
    brand: incoming.brand || existing.brand,
    type: incoming.type || existing.type,
    category: incoming.category || existing.category,
    issuer: incoming.issuer || existing.issuer,
    issuer_url: incoming.issuer_url || existing.issuer_url,
    issuer_phone: incoming.issuer_phone || existing.issuer_phone,
    country_alpha2: incoming.country_alpha2 || existing.country_alpha2,
    country_name: incoming.country_name || existing.country_name,
    country_numeric: incoming.country_numeric || existing.country_numeric,
    country_iso3: incoming.country_iso3 || existing.country_iso3,
    currency: incoming.currency || existing.currency,
    is_commercial: incoming.is_commercial ?? existing.is_commercial,
    is_prepaid: incoming.is_prepaid || existing.is_prepaid,
  };
}

// ============================================================
// Main seeding process
// ============================================================
async function main() {
  console.log("🚀 BIN Database Seeder v2.0");
  console.log("=".repeat(60));
  console.log("  Aggregating data from multiple FREE open-source repos\n");

  // Initialize database
  const db = getDb();
  console.log("✅ Database initialized\n");

  // Collect from all sources
  const allSources: { name: string; records: BinRecord[] }[] = [];

  // Source 1: binfo (highest priority - most complete data)
  const binfo = await fetchBinfoDatabase();
  allSources.push({ name: "binfo (Bes-js/binfo)", records: binfo });

  // Source 2: iannuttall CSV
  const iannuttall = await fetchIannuttallData();
  allSources.push({ name: "iannuttall/binlist-data", records: iannuttall });

  // Source 3: binlist/data official ranges
  const binlistOfficial = await fetchBinlistOfficialData();
  allSources.push({ name: "binlist/data (official)", records: binlistOfficial });

  // Source 4: Known ranges
  const knownRanges = generateKnownBinRanges();
  allSources.push({ name: "IIN/BIN standards", records: knownRanges });

  // Print source summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 Source Summary:");
  let totalRaw = 0;
  for (const source of allSources) {
    console.log(`  ${source.name}: ${source.records.length.toLocaleString()} records`);
    totalRaw += source.records.length;
  }
  console.log(`  Total raw: ${totalRaw.toLocaleString()} records`);

  // Merge & deduplicate (priority: binfo > iannuttall > binlist > known ranges)
  // We merge fields from all sources to get the most complete record per BIN
  console.log("\n🔀 Merging & deduplicating...");
  const binMap = new Map<string, BinRecord>();

  // Insert in reverse priority order so higher priority overwrites
  for (const source of [...allSources].reverse()) {
    for (const record of source.records) {
      const existing = binMap.get(record.bin);
      if (existing) {
        binMap.set(record.bin, mergeRecords(existing, record));
      } else {
        binMap.set(record.bin, record);
      }
    }
  }

  const dedupedRecords = Array.from(binMap.values());
  console.log(`  ✅ ${dedupedRecords.length.toLocaleString()} unique BINs after merge`);

  // Check for local CSV file too
  const localCsv = path.join(DATA_DIR, "bins.csv");
  if (existsSync(localCsv)) {
    console.log("\n📥 Found local data/bins.csv, importing...");
    const text = readFileSync(localCsv, "utf-8");
    const lines = text.trim().split("\n");
    let localCount = 0;
    for (let i = 1; i < lines.length; i++) {
      try {
        const delimiter = lines[i].includes(";") ? ";" : ",";
        const parts = lines[i].split(delimiter).map((s: string) => s.trim().replace(/^"|"$/g, ""));
        const bin = parts[0]?.replace(/\D/g, "");
        if (!bin || bin.length < 3) continue;
        const paddedBin = bin.padEnd(8, "0").substring(0, 8);
        const existing = binMap.get(paddedBin);
        const record: BinRecord = {
          bin: paddedBin,
          brand: normalizeField(parts[1]),
          type: normalizeType(parts[2]),
          category: normalizeField(parts[3]),
          issuer: normalizeField(parts[4]),
          issuer_url: normalizeField(parts[5]),
          issuer_phone: null,
          country_alpha2: normalizeField(parts[6])?.substring(0, 2)?.toUpperCase() || null,
          country_name: normalizeField(parts[7]),
          country_numeric: normalizeField(parts[8]),
          country_iso3: null,
          currency: null,
          is_commercial: false,
          is_prepaid: false,
        };
        binMap.set(paddedBin, existing ? mergeRecords(existing, record) : record);
        localCount++;
      } catch {}
    }
    console.log(`  ✅ Added ${localCount} records from local CSV`);
  }

  const finalRecords = Array.from(binMap.values());

  if (finalRecords.length > 0) {
    console.log(`\n💾 Inserting ${finalRecords.length.toLocaleString()} BIN records into database...`);
    const BATCH_SIZE = 5000;
    let inserted = 0;

    for (let i = 0; i < finalRecords.length; i += BATCH_SIZE) {
      const batch = finalRecords.slice(i, i + BATCH_SIZE);
      inserted += bulkUpsertBins(batch);
      process.stdout.write(
        `\r  Progress: ${inserted.toLocaleString()}/${finalRecords.length.toLocaleString()} (${Math.round((inserted / finalRecords.length) * 100)}%)`
      );
    }

    console.log(`\n  ✅ Successfully inserted ${inserted.toLocaleString()} BIN records!`);
  } else {
    console.log("\n❌ No data collected! Check your internet connection.");
  }

  // Print final stats
  const stats = db.prepare("SELECT COUNT(*) as total FROM bins").get() as any;
  const brands = db
    .prepare("SELECT brand, COUNT(*) as c FROM bins GROUP BY brand ORDER BY c DESC LIMIT 10")
    .all();
  const countries = db
    .prepare(
      "SELECT country_name, COUNT(*) as c FROM bins WHERE country_name IS NOT NULL GROUP BY country_name ORDER BY c DESC LIMIT 10"
    )
    .all();
  const withCurrency = db.prepare("SELECT COUNT(*) as c FROM bins WHERE currency IS NOT NULL").get() as any;
  const withPhone = db.prepare("SELECT COUNT(*) as c FROM bins WHERE issuer_phone IS NOT NULL").get() as any;

  console.log("\n" + "=".repeat(60));
  console.log("📊 Final Database Stats:");
  console.log(`  Total BINs:        ${stats.total.toLocaleString()}`);
  console.log(`  With currency:     ${withCurrency.c.toLocaleString()}`);
  console.log(`  With bank phone:   ${withPhone.c.toLocaleString()}`);
  console.log("\n  Top 10 Brands:");
  for (const b of brands as any[]) {
    console.log(`    ${b.brand?.padEnd(25)} ${b.c.toLocaleString()}`);
  }
  console.log("\n  Top 10 Countries:");
  for (const c of countries as any[]) {
    console.log(`    ${c.country_name?.padEnd(25)} ${c.c.toLocaleString()}`);
  }

  // Cleanup cache
  try {
    const cacheSqlite = path.join(CACHE_DIR, "binfo.sqlite");
    if (existsSync(cacheSqlite)) unlinkSync(cacheSqlite);
  } catch {}

  closeDb();
  console.log("\n✅ Seeding complete!");
}

main().catch(console.error);
