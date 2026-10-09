/**
 * Parser for WhatsApp "Export chat" .txt files + heuristic Q&A pairing.
 *
 * Supports both common export formats:
 *   iOS:      [1/15/24, 9:41:05 PM] Name: message
 *   Android:  1/15/24, 9:41 PM - Name: message      (or 15/01/2024, 21:41 - Name: message)
 *
 * WhatsApp exports do NOT include "reply-to" context, so we can't know exactly
 * which question the rabbi answered. Instead we build one chunk per rabbi
 * "answer block" (consecutive rabbi messages) and attach the community
 * messages that came right before it as the likely question(s). The LLM sees
 * the whole chunk at query time, so slightly imperfect pairing is fine.
 */

export interface ChatMessage {
  timestamp: number; // ms since epoch (local time interpreted as UTC — fine for ordering)
  date: string; // YYYY-MM-DD
  sender: string;
  text: string;
}

export interface QAPair {
  id: string;
  date: string;
  question: string;
  answer: string;
  /** The text that gets embedded. */
  text: string;
}

export type DateOrder = "mdy" | "dmy" | "auto";

// Timestamp prefix shared by both formats. Captures: date, time, am/pm.
const PREFIX =
  /^[\u200e\u200f]?\[?(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}),?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)(?:[\s\u202f\u00a0]*([AaPp]\.?\s?[Mm]\.?))?\]?(?:\s*[-–])?\s+/;

const NOISE = [
  /^<?media omitted>?$/i,
  /^[\u200e]?(image|video|audio|sticker|gif|document|contact card) omitted$/i,
  /^this message was deleted\.?$/i,
  /^you deleted this message\.?$/i,
  /^null$/i,
  /^waiting for this message/i,
  /^<attached: .*>$/i,
];

const INVISIBLES = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanText(t: string): string {
  return t
    .replace(INVISIBLES, "")
    .replace(/\s*<This message was edited>\s*$/i, "")
    .replace(/\u202f|\u00a0/g, " ")
    .trim();
}

/** Redact phone numbers / emails so people's contact info never ends up in the index. */
export function redact(t: string): string {
  return t
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m));
}

function detectDateOrder(lines: string[]): "mdy" | "dmy" {
  for (const line of lines) {
    const m = line.match(PREFIX);
    if (!m) continue;
    const [a, b] = m[1].split(/[\/.\-]/).map(Number);
    if (a > 12 && a <= 31) return "dmy";
    if (b > 12 && b <= 31) return "mdy";
  }
  return "mdy";
}

function toTimestamp(dateStr: string, timeStr: string, ampm: string | undefined, order: "mdy" | "dmy") {
  const parts = dateStr.split(/[\/.\-]/).map(Number);
  let y: number, mo: number, d: number;
  if (parts[0] > 31) {
    [y, mo, d] = parts; // YYYY-MM-DD
  } else if (order === "dmy") {
    [d, mo, y] = parts;
  } else {
    [mo, d, y] = parts;
  }
  if (y < 100) y += 2000;

  const t = timeStr.split(/[:.]/).map(Number);
  let h = t[0];
  const min = t[1];
  const s = t[2] ?? 0;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  const ts = Date.UTC(y, mo - 1, d, h, min, s);
  const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { ts, date };
}

export function parseWhatsAppExport(raw: string, order: DateOrder = "auto"): ChatMessage[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const dateOrder = order === "auto" ? detectDateOrder(lines) : order;

  const messages: ChatMessage[] = [];
  let current: ChatMessage | null = null;
  let inSystem = false;

  for (const line of lines) {
    const m = line.match(PREFIX);
    if (m) {
      if (current) messages.push(current);
      current = null;
      const rest = line.slice(m[0].length);
      const nm = rest.match(/^([^:]{1,80}?):\s?([\s\S]*)$/);
      // No "Name:" → system event. On iOS, system events/media placeholders look like
      // "GroupName: \u200eX joined" — the text starts with an invisible LRM mark.
      if (!nm || nm[2].startsWith("\u200e")) {
        inSystem = true;
        continue;
      }
      inSystem = false;
      const { ts, date } = toTimestamp(m[1], m[2], m[3], dateOrder);
      current = { timestamp: ts, date, sender: cleanText(nm[1]), text: nm[2] };
    } else if (current && !inSystem) {
      current.text += "\n" + line; // multi-line message continuation
    }
  }
  if (current) messages.push(current);

  return messages
    .map((msg) => ({ ...msg, text: cleanText(msg.text) }))
    .filter((msg) => msg.text.length > 0 && !NOISE.some((re) => re.test(msg.text)));
}

export function countSenders(messages: ChatMessage[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export interface PairOptions {
  /** Names (or substrings / phone numbers) identifying the rabbi's account(s). */
  rabbiNames: string[];
  /** Consecutive rabbi messages within this gap are merged into one answer. */
  answerMergeMinutes?: number;
  /** Only consider community messages this recent as the question. */
  questionWindowHours?: number;
  /** Max number of preceding community messages to attach as the question. */
  maxQuestionMessages?: number;
  /** Skip answer blocks shorter than this (e.g. "👍", "yes"). */
  minAnswerChars?: number;
}

/** Tiny deterministic hash (FNV-1a, 2 rounds) for stable vector IDs so re-ingesting is idempotent. */
export function stableId(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function buildQAPairs(messages: ChatMessage[], opts: PairOptions): QAPair[] {
  const {
    rabbiNames,
    answerMergeMinutes = 20,
    questionWindowHours = 72,
    maxQuestionMessages = 4,
    minAnswerChars = 15,
  } = opts;
  const needles = rabbiNames.map((n) => n.toLowerCase().replace(INVISIBLES, "").trim()).filter(Boolean);
  const isRabbi = (sender: string) => {
    const s = sender.toLowerCase();
    return needles.some((n) => s.includes(n));
  };

  const pairs: QAPair[] = [];
  let pendingQuestions: ChatMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (!isRabbi(msg.sender)) {
      pendingQuestions.push(msg);
      i++;
      continue;
    }

    // Collect a block of consecutive rabbi messages (allowing short gaps).
    const block: ChatMessage[] = [msg];
    i++;
    while (
      i < messages.length &&
      isRabbi(messages[i].sender) &&
      messages[i].timestamp - block[block.length - 1].timestamp <= answerMergeMinutes * 60_000
    ) {
      block.push(messages[i]);
      i++;
    }

    const answer = redact(block.map((m) => m.text).join("\n"));
    const cutoff = msg.timestamp - questionWindowHours * 3_600_000;
    const question = redact(
      pendingQuestions
        .filter((q) => q.timestamp >= cutoff)
        .slice(-maxQuestionMessages)
        .map((q) => q.text)
        .join("\n"),
    );
    pendingQuestions = [];

    if (answer.length < minAnswerChars) continue;

    const text = question ? `Question: ${question}\nRabbi's answer: ${answer}` : `Rabbi's post: ${answer}`;
    pairs.push({
      id: stableId(`${msg.timestamp}|${answer}`),
      date: msg.date,
      question,
      answer,
      text,
    });
  }

  return pairs;
}
