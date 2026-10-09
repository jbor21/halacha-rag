/**
 * Upload data/qa.json to the deployed Worker, which embeds each chunk with
 * Workers AI and upserts it into Vectorize.
 *
 *   WORKER_URL=https://halacha-rag.<you>.workers.dev ADMIN_TOKEN=... npm run ingest
 *
 * Vector IDs are deterministic, so re-running is safe (it overwrites, no duplicates).
 */
import { readFileSync } from "node:fs";
import type { QAPair } from "./lib/whatsapp-export.ts";

process.loadEnvFile?.();

const WORKER_URL = process.env.WORKER_URL?.replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const FILE = process.argv[2] ?? "data/qa.json";
const BATCH = 25;

if (!WORKER_URL || !ADMIN_TOKEN) {
  console.error("Set WORKER_URL and ADMIN_TOKEN env vars (see README).");
  process.exit(1);
}

const pairs: QAPair[] = JSON.parse(readFileSync(FILE, "utf8"));
console.log(`Ingesting ${pairs.length} chunks from ${FILE} → ${WORKER_URL}`);

let done = 0;
for (let i = 0; i < pairs.length; i += BATCH) {
  const items = pairs.slice(i, i + BATCH);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${WORKER_URL}/admin/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ items }),
    });
    if (res.ok) break;
    const body = await res.text();
    if (attempt >= 3 || res.status === 401) {
      console.error(`\nBatch at ${i} failed (${res.status}): ${body}`);
      process.exit(1);
    }
    console.warn(`\nBatch at ${i} failed (${res.status}), retrying...`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  done += items.length;
  process.stdout.write(`\r  ${done}/${pairs.length}`);
}
console.log("\nDone. Vectorize indexing is eventually consistent — give it ~1 minute before querying.");
