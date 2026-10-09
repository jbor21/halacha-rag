import type { Env } from "./types";

/** Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body using the app secret). */
export async function verifySignature(rawBody: string, header: string | null, appSecret?: string): Promise<boolean> {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export interface IncomingMessage {
  id: string;
  from: string;
  type: string;
  text?: string;
}

/** Extract user messages from a WhatsApp Cloud API webhook payload (ignores status updates). */
export function extractMessages(payload: any): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        out.push({ id: m.id, from: m.from, type: m.type, text: m.text?.body });
      }
    }
  }
  return out;
}

async function graph(env: Env, body: unknown): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) console.error("WhatsApp API error", res.status, await res.text());
}

/** Mark the message as read and show the "typing…" indicator while we generate an answer. */
export function markReadWithTyping(env: Env, messageId: string) {
  return graph(env, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });
}

export function sendText(env: Env, to: string, text: string, replyTo?: string) {
  return graph(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text, preview_url: false },
    ...(replyTo ? { context: { message_id: replyTo } } : {}),
  });
}
