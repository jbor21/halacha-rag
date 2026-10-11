import { answerQuestion, ingest } from "./rag";
import type { Env, QAItem } from "./types";
import { extractMessages, markReadWithTyping, sendText, verifySignature } from "./whatsapp";

const HELP = (rabbi: string) =>
  `👋 Hi! Ask me any halacha question and I'll search ${rabbi}'s past answers from the group and summarize them, with sources.\n\nExample: "Can I cook on Yom Tov for the next day?"`;

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function isAdmin(req: Request, env: Env) {
  return !!env.ADMIN_TOKEN && req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

async function handleIncoming(env: Env, msg: { id: string; from: string; type: string; text?: string }) {
  try {
    if (msg.type !== "text" || !msg.text?.trim()) {
      await sendText(env, msg.from, "Sorry, I can only read text messages for now. Please type your question.", msg.id);
      return;
    }
    const text = msg.text.trim();
    if (/^(hi|hello|help|start|\/start|shalom)\W*$/i.test(text)) {
      await sendText(env, msg.from, HELP(env.RABBI_NAME));
      return;
    }

    await markReadWithTyping(env, msg.id);
    const { reply } = await answerQuestion(env, text);
    await sendText(env, msg.from, reply, msg.id);
  } catch (err) {
    console.error("Failed to handle message", err);
    await sendText(env, msg.from, "Sorry, something went wrong. Please try again in a minute.", msg.id);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    console.log(`[HTTP] ${req.method} ${url.pathname}`);

    // ---- Health check
    if (url.pathname === "/" && req.method === "GET") {
      return new Response("Halacha RAG bot is running ✅");
    }

    // ---- WhatsApp webhook verification (Meta calls this once when you set the webhook URL)
    if (url.pathname === "/webhook" && req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && token === env.WHATSAPP_VERIFY_TOKEN) {
        return new Response(challenge ?? "", { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // ---- WhatsApp incoming messages
    if (url.pathname === "/webhook" && req.method === "POST") {
      const raw = await req.text();
      console.log(`[Webhook received] ${raw.slice(0, 500)}`);
      const valid = await verifySignature(raw, req.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET);
      if (!valid) {
        console.error(`[Webhook] Invalid signature! Received header: ${req.headers.get("x-hub-signature-256")}`);
        return new Response("Invalid signature", { status: 401 });
      }
      const messages = extractMessages(JSON.parse(raw));
      console.log(`[Webhook] Extracted ${messages.length} messages`);
      // Ack immediately (Meta retries if we're slow); do the RAG work in the background.
      for (const msg of messages) ctx.waitUntil(handleIncoming(env, msg));
      return new Response("OK", { status: 200 });
    }

    // ---- Admin: ask a question over HTTP (for testing / demos)
    if (url.pathname === "/ask" && req.method === "GET") {
      if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
      const q = url.searchParams.get("q")?.trim();
      if (!q) return json({ error: "missing ?q=" }, 400);
      const { reply, sources } = await answerQuestion(env, q);
      return json({
        reply,
        matches: sources.map((s) => ({ id: s.id, score: s.score, date: s.date, question: s.question.slice(0, 200) })),
      });
    }

    // ---- Admin: ingest Q&A chunks (called by scripts/ingest.ts)
    if (url.pathname === "/admin/ingest" && req.method === "POST") {
      if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
      const body = (await req.json()) as { items?: QAItem[] };
      const items = (body.items ?? []).filter((it) => it?.id && it?.text);
      if (items.length === 0 || items.length > 100) return json({ error: "send 1-100 items" }, 400);
      const count = await ingest(env, items);
      return json({ upserted: count });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
