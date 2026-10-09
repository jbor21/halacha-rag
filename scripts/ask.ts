/**
 * Ask the deployed bot a question from your terminal (no WhatsApp needed).
 *
 *   WORKER_URL=... ADMIN_TOKEN=... npm run ask -- "Can I use a dishwasher for meat and dairy?"
 */
process.loadEnvFile?.();

const WORKER_URL = process.env.WORKER_URL?.replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const q = process.argv.slice(2).join(" ");

if (!WORKER_URL || !ADMIN_TOKEN || !q) {
  console.error('Usage: WORKER_URL=... ADMIN_TOKEN=... npm run ask -- "your question"');
  process.exit(1);
}

const res = await fetch(`${WORKER_URL}/ask?q=${encodeURIComponent(q)}`, {
  headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
});
const data = (await res.json()) as { reply?: string; matches?: { score: number; date: string }[]; error?: string };
if (!res.ok) {
  console.error(res.status, data);
  process.exit(1);
}
console.log(data.reply);
console.log("\nRetrieved:", data.matches?.map((m) => `${m.date} (${m.score.toFixed(3)})`).join(", "));

export {};
