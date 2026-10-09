/**
 * Ask the deployed bot questions from your terminal (no WhatsApp needed).
 *
 * 1. Single question:
 *    npm run ask -- "Can I brush my teeth on Yom Kippur?"
 *
 * 2. Interactive chat session:
 *    npm run ask
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

process.loadEnvFile?.();

const WORKER_URL = process.env.WORKER_URL?.replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!WORKER_URL || !ADMIN_TOKEN) {
  console.error("Missing WORKER_URL or ADMIN_TOKEN in .env");
  process.exit(1);
}

async function queryBot(question: string) {
  process.stdout.write("Searching archive & generating answer...\n\n");
  try {
    const res = await fetch(`${WORKER_URL}/ask?q=${encodeURIComponent(question)}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const data = (await res.json()) as {
      reply?: string;
      matches?: { score: number; date: string }[];
      error?: string;
    };
    if (!res.ok) {
      console.error(`Error (${res.status}):`, data.error || data);
      return;
    }
    console.log(data.reply);
    if (data.matches && data.matches.length > 0) {
      console.log(
        "\n🔍 Top retrieved sources:",
        data.matches.map((m) => `${m.date} (score: ${m.score.toFixed(3)})`).join(", "),
      );
    }
  } catch (err: any) {
    console.error("Request failed:", err.message);
  }
}

const directQuestion = process.argv.slice(2).join(" ").trim();

if (directQuestion) {
  await queryBot(directQuestion);
} else {
  const rl = readline.createInterface({ input, output });
  console.log("==================================================");
  console.log("💬 Halacha RAG Assistant - Interactive Test Mode");
  console.log("Ask any question from the Rabbi's Q&A archive.");
  console.log("Type 'exit' or press Ctrl+C to quit.");
  console.log("==================================================\n");

  while (true) {
    const q = await rl.question("Ask a question > ");
    if (!q || q.trim().toLowerCase() === "exit") {
      console.log("Exiting test mode. Goodbye!");
      rl.close();
      break;
    }
    await queryBot(q.trim());
    console.log("\n--------------------------------------------------\n");
  }
}

export {};
