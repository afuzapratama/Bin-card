/**
 * BIN Data Auto-Updater
 * 
 * Schedule this to run periodically (e.g., weekly via cron)
 * to keep your BIN database fresh.
 * 
 * Usage:
 *   bun run src/scripts/update.ts
 *   
 * Crontab (weekly on Sunday at 3 AM):
 *   0 3 * * 0 cd /path/to/api-bin-card && bun run src/scripts/update.ts >> data/update.log 2>&1
 */

import { bulkUpsertBins } from "../db/queries";
import { getDb, closeDb } from "../db/schema";
import type { BinRecord } from "../types/bin";

async function fetchFromGitHub(): Promise<BinRecord[]> {
  console.log(`[${new Date().toISOString()}] 📥 Fetching latest BIN data from GitHub...`);
  const records: BinRecord[] = [];

  const urls = [
    "https://raw.githubusercontent.com/iannuttall/binlist-data/master/binlist-data.csv",
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "BIN-API-Builder/1.0" },
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) continue;

      const text = await response.text();
      const lines = text.trim().split("\n");

      for (let i = 1; i < lines.length; i++) {
        try {
          const delimiter = lines[i].includes(";") ? ";" : ",";
          const parts = lines[i].split(delimiter).map((s) => s.trim().replace(/^"|"$/g, ""));
          
          const bin = parts[0]?.replace(/\D/g, "");
          if (!bin || bin.length < 6 || bin.length > 8) continue;

          records.push({
            bin: bin.substring(0, 8).padEnd(8, "0"),
            brand: parts[1] || null,
            type: parts[2]?.toLowerCase() || null,
            category: parts[3] || null,
            issuer: parts[4] || null,
            issuer_url: parts[5] || null,
            country_alpha2: parts[6]?.substring(0, 2)?.toUpperCase() || null,
            country_name: parts[9] || parts[7] || null,
            country_numeric: parts[8] || null,
            is_commercial: false,
            is_prepaid: parts[2]?.toLowerCase().includes("prepaid") || false,
          });
        } catch {
          // Skip malformed
        }
      }

      console.log(`  ✅ Fetched ${records.length} records`);
      break;
    } catch (e: any) {
      console.log(`  ⚠️ Failed: ${e.message}`);
    }
  }

  return records;
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`BIN Database Update - ${new Date().toISOString()}`);
  console.log(`${"=".repeat(50)}\n`);

  const db = getDb();

  const beforeCount = (db.prepare("SELECT COUNT(*) as c FROM bins").get() as any).c;
  console.log(`📊 Current records: ${beforeCount}`);

  const records = await fetchFromGitHub();

  if (records.length > 0) {
    // Deduplicate
    const binMap = new Map<string, BinRecord>();
    for (const r of records) binMap.set(r.bin, r);
    const unique = Array.from(binMap.values());

    console.log(`💾 Upserting ${unique.length} records...`);
    const BATCH = 5000;
    let count = 0;
    for (let i = 0; i < unique.length; i += BATCH) {
      count += bulkUpsertBins(unique.slice(i, i + BATCH));
    }

    const afterCount = (db.prepare("SELECT COUNT(*) as c FROM bins").get() as any).c;
    console.log(`✅ Update complete!`);
    console.log(`   Before: ${beforeCount} | After: ${afterCount} | New: ${afterCount - beforeCount}`);
  } else {
    console.log("❌ No new data fetched. Will retry next scheduled run.");
  }

  closeDb();
}

main().catch(console.error);
