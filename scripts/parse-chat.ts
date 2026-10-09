/**
 * Parse a WhatsApp chat export into Q&A chunks ready for embedding.
 *
 *   npm run senders -- data/chat.txt                       # see who posts most (find the rabbi's name)
 *   npm run parse -- data/chat.txt --rabbi "Rabbi Cohen"   # writes data/qa.json
 *
 * Options:
 *   --rabbi <name>        Rabbi's display name / phone (substring match). Repeat or comma-separate for multiple.
 *   --out <file>          Output path (default data/qa.json)
 *   --date-order <o>      mdy | dmy | auto (default auto)
 *   --list-senders        Just print message counts per sender.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { buildQAPairs, countSenders, parseWhatsAppExport, type DateOrder } from "./lib/whatsapp-export.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rabbi: { type: "string", multiple: true },
    out: { type: "string", default: "data/qa.json" },
    "date-order": { type: "string", default: "auto" },
    "list-senders": { type: "boolean", default: false },
  },
});

const file = positionals[0];
if (!file) {
  console.error("Usage: npm run parse -- <chat.txt> --rabbi \"Rabbi Name\"");
  process.exit(1);
}

const raw = readFileSync(file, "utf8");
const messages = parseWhatsAppExport(raw, values["date-order"] as DateOrder);
console.log(`Parsed ${messages.length} messages from ${file}`);

if (values["list-senders"]) {
  console.log("\nTop senders:");
  for (const [sender, n] of countSenders(messages).slice(0, 25)) {
    console.log(`  ${String(n).padStart(6)}  ${sender}`);
  }
  console.log('\nNext: npm run parse -- ' + file + ' --rabbi "<rabbi name from above>"');
  process.exit(0);
}

const rabbiNames = (values.rabbi ?? []).flatMap((r) => r.split(",")).map((s) => s.trim()).filter(Boolean);
if (rabbiNames.length === 0) {
  console.error('Missing --rabbi "<name>". Run `npm run senders -- ' + file + "` to see names.");
  process.exit(1);
}

const pairs = buildQAPairs(messages, { rabbiNames });
if (pairs.length === 0) {
  console.error(`No answers found for rabbi name(s): ${rabbiNames.join(", ")}. Check spelling with --list-senders.`);
  process.exit(1);
}

mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(values.out!, JSON.stringify(pairs, null, 2));

const withQ = pairs.filter((p) => p.question).length;
console.log(`Built ${pairs.length} chunks (${withQ} with a question, ${pairs.length - withQ} standalone rabbi posts)`);
console.log(`Wrote ${values.out}. Skim it, then run: npm run ingest`);
console.log("\nSample:\n" + pairs[Math.floor(pairs.length / 2)].text.slice(0, 600));
