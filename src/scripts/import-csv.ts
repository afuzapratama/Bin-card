/**
 * Import BIN data from a local CSV file
 * 
 * Usage:
 *   bun run src/scripts/import-csv.ts <path-to-csv>
 * 
 * Supported CSV formats:
 *   - bin,brand,type,category,issuer,issuer_url,country_alpha2,country_numeric,country_name
 *   - bin;brand;type;category;issuer;country_code;country_name
 *   - Any CSV where first column is the BIN number
 * 
 * The script auto-detects delimiters (comma, semicolon, tab, pipe)
 */

import { readFileSync, existsSync } from "fs";
import { bulkUpsertBins } from "../db/queries";
import { getDb, closeDb } from "../db/schema";
import type { BinRecord } from "../types/bin";

const csvPath = process.argv[2] || "data/bins.csv";

if (!existsSync(csvPath)) {
  console.error(`❌ File not found: ${csvPath}`);
  console.log("\nUsage: bun run src/scripts/import-csv.ts <path-to-csv>");
  console.log("\nExpected CSV format (first row is header):");
  console.log("  bin,brand,type,category,issuer,issuer_url,country_alpha2,country_numeric,country_name");
  process.exit(1);
}

function detectDelimiter(line: string): string {
  const delimiters = [",", ";", "\t", "|"];
  let maxCount = 0;
  let bestDelimiter = ",";

  for (const d of delimiters) {
    const count = (line.match(new RegExp(`\\${d}`, "g")) || []).length;
    if (count > maxCount) {
      maxCount = count;
      bestDelimiter = d;
    }
  }
  return bestDelimiter;
}

function mapHeaders(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const aliases: Record<string, string[]> = {
    bin: ["bin", "iin", "bin_number", "iin_number", "card_bin", "bin_num", "number"],
    brand: ["brand", "scheme", "network", "card_brand", "card_scheme"],
    type: ["type", "card_type", "funding"],
    category: ["category", "card_category", "level", "tier", "product"],
    issuer: ["issuer", "bank", "issuer_name", "bank_name", "issuing_bank"],
    issuer_url: ["issuer_url", "bank_url", "url", "website"],
    country_alpha2: ["country_alpha2", "country_code", "alpha2", "iso_alpha2", "iso2", "country_iso", "isocode2"],
    country_name: ["country_name", "country", "country_full"],
    country_numeric: ["country_numeric", "numeric", "iso_numeric", "isocode_num", "isocodenum"],
    is_commercial: ["is_commercial", "commercial"],
    is_prepaid: ["is_prepaid", "prepaid"],
  };

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase().replace(/[^a-z0-9_]/g, "");
    for (const [field, names] of Object.entries(aliases)) {
      if (names.includes(h)) {
        map[field] = i;
        break;
      }
    }
    // Fallback: if no alias matched, use position-based mapping
    if (i === 0 && !map.bin) map.bin = 0;
  }

  return map;
}

async function main() {
  console.log(`📄 Importing from: ${csvPath}`);
  
  const db = getDb();
  const text = readFileSync(csvPath, "utf-8");
  const lines = text.trim().split("\n");

  if (lines.length < 2) {
    console.error("❌ CSV file is empty or has no data rows");
    process.exit(1);
  }

  const delimiter = detectDelimiter(lines[0]);
  console.log(`  Detected delimiter: "${delimiter === "\t" ? "TAB" : delimiter}"`);

  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
  console.log(`  Headers: ${headers.join(", ")}`);

  const headerMap = mapHeaders(headers);
  console.log(`  Mapped fields:`, headerMap);

  if (headerMap.bin === undefined) {
    console.error("❌ Could not identify BIN column in CSV");
    process.exit(1);
  }

  const records: BinRecord[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(delimiter).map((s) => s.trim().replace(/^"|"$/g, ""));
    
    const bin = parts[headerMap.bin]?.replace(/\D/g, "");
    if (!bin || bin.length < 6 || bin.length > 8) {
      skipped++;
      continue;
    }

    const get = (field: string) => {
      const idx = headerMap[field];
      if (idx === undefined) return null;
      const val = parts[idx]?.trim();
      return val && val !== "" && val !== "-" ? val : null;
    };

    records.push({
      bin: bin.substring(0, 8).padEnd(8, "0"),
      brand: get("brand")?.toUpperCase() || null,
      type: get("type")?.toLowerCase() || null,
      category: get("category") || null,
      issuer: get("issuer") || null,
      issuer_url: get("issuer_url") || null,
      country_alpha2: get("country_alpha2")?.substring(0, 2)?.toUpperCase() || null,
      country_name: get("country_name") || null,
      country_numeric: get("country_numeric") || null,
      is_commercial: get("is_commercial") === "true" || get("is_commercial") === "1",
      is_prepaid: get("is_prepaid") === "true" || get("is_prepaid") === "1" || get("type")?.includes("prepaid") || false,
    });
  }

  console.log(`\n📊 Parsed ${records.length} valid records (skipped ${skipped} invalid rows)`);

  if (records.length > 0) {
    // Deduplicate
    const binMap = new Map<string, BinRecord>();
    for (const r of records) binMap.set(r.bin, r);
    const unique = Array.from(binMap.values());

    console.log(`💾 Upserting ${unique.length} unique BINs...`);
    const BATCH = 5000;
    let total = 0;
    for (let i = 0; i < unique.length; i += BATCH) {
      total += bulkUpsertBins(unique.slice(i, i + BATCH));
      process.stdout.write(`\r  Progress: ${total}/${unique.length}`);
    }
    console.log(`\n✅ Imported ${total} BIN records!`);
  }

  const stats = db.prepare("SELECT COUNT(*) as total FROM bins").get() as any;
  console.log(`📊 Total BINs in database: ${stats.total}`);

  closeDb();
}

main().catch(console.error);
