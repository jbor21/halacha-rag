import type { Env, QAItem, Source } from "./types";

const EMBED_BATCH = 25;
const MAX_META_CHARS = 3500; // Vectorize metadata limit is 10 KiB/vector; keep well under it (UTF-8 Hebrew = 2 bytes/char)
const MAX_SOURCE_CHARS = 1500; // per-source context passed to the LLM
const WHATSAPP_MAX = 4000; // WhatsApp text limit is 4096

// ---------------------------------------------------------------- embeddings

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const res = (await env.AI.run(env.EMBEDDING_MODEL as any, { text: texts.slice(i, i + EMBED_BATCH) })) as any;
    const vectors: number[][] | undefined = res?.data ?? res?.response;
    if (!Array.isArray(vectors)) throw new Error(`Unexpected embedding response: ${JSON.stringify(res).slice(0, 200)}`);
    out.push(...vectors);
  }
  return out;
}

// ---------------------------------------------------------------- ingestion

export async function ingest(env: Env, items: QAItem[]): Promise<number> {
  const vectors = await embed(env, items.map((it) => it.text));
  await env.VECTORIZE.upsert(
    items.map((it, i) => ({
      id: it.id,
      values: vectors[i],
      metadata: {
        date: it.date,
        question: it.question.slice(0, MAX_META_CHARS / 3),
        answer: it.answer.slice(0, MAX_META_CHARS),
      },
    })),
  );
  return items.length;
}

// ---------------------------------------------------------------- retrieval

export async function retrieve(env: Env, query: string): Promise<Source[]> {
  const [vector] = await embed(env, [query]);
  const res = await env.VECTORIZE.query(vector, {
    topK: Number(env.TOP_K) || 5,
    returnMetadata: "all",
  });
  const minScore = Number(env.MIN_SCORE) || 0;
  return res.matches
    .filter((m) => m.score >= minScore)
    .map((m) => ({
      id: m.id,
      score: m.score,
      date: String(m.metadata?.date ?? ""),
      question: String(m.metadata?.question ?? ""),
      answer: String(m.metadata?.answer ?? ""),
    }));
}

// ---------------------------------------------------------------- generation

function systemPrompt(rabbi: string): string {
  return `You are a helpful assistant that answers questions about Jewish law (halacha) using ONLY an archive of past answers given by ${rabbi} in a WhatsApp Q&A group.

Rules:
- Base your answer strictly on the numbered SOURCES provided. Do not add rulings, opinions, or facts that are not in the sources.
- Cite the sources you used inline with their numbers, like [1] or [2][3].
- If the sources do not clearly address the question, say you couldn't find an answer in the archive and suggest asking ${rabbi} directly. Never guess.
- If sources disagree or depend on circumstances, say so briefly.
- Be concise: at most ~150 words, plain text suitable for WhatsApp (you may use *bold* sparingly). No markdown headers or tables.
- Reply in the same language the user wrote in.`;
}

function buildContext(sources: Source[]): string {
  return sources
    .map((s, i) => {
      const q = s.question ? `Question asked: ${s.question}\n` : "";
      return `[${i + 1}] (${s.date})\n${q}${"Rabbi's answer"}: ${s.answer}`.slice(0, MAX_SOURCE_CHARS);
    })
    .join("\n\n");
}

async function generate(env: Env, messages: { role: string; content: string }[]): Promise<string> {
  if (env.OPENROUTER_API_KEY) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: env.OPENROUTER_MODEL, messages, temperature: 0.2, max_tokens: 600 }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return data.choices?.[0]?.message?.content ?? "";
  }

  const res = (await env.AI.run(env.CHAT_MODEL as any, { messages, temperature: 0.2, max_tokens: 600 } as any)) as any;
  // Older Workers AI models return { response }, newer ones return OpenAI-style { choices }.
  return res?.response ?? res?.choices?.[0]?.message?.content ?? "";
}

export interface Answer {
  reply: string;
  sources: Source[];
}

export async function answerQuestion(env: Env, question: string): Promise<Answer> {
  const sources = await retrieve(env, question);

  if (sources.length === 0) {
    return {
      reply: `I couldn't find anything about that in ${env.RABBI_NAME}'s Q&A archive. Please ask ${env.RABBI_NAME} directly.`,
      sources,
    };
  }

  const draft = (
    await generate(env, [
      { role: "system", content: systemPrompt(env.RABBI_NAME) },
      { role: "user", content: `SOURCES:\n${buildContext(sources)}\n\nQUESTION: ${question}` },
    ])
  ).trim();

  // Only list the sources the model actually cited.
  const cited = [...new Set([...draft.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
    .filter((n) => n >= 1 && n <= sources.length)
    .sort((a, b) => a - b);

  let footer = "";
  if (cited.length) {
    footer =
      "\n\n📚 *Sources* (from the group archive):\n" +
      cited
        .map((n) => {
          const s = sources[n - 1];
          const label = (s.question || s.answer).replace(/\s+/g, " ").slice(0, 70);
          return `[${n}] ${s.date} — "${label}${label.length >= 70 ? "…" : ""}"`;
        })
        .join("\n");
  }
  const disclaimer = "\n\n_AI summary of past answers — for practical questions, consult your rabbi._";

  const reply = (draft || "Sorry, I couldn't generate an answer.").slice(0, WHATSAPP_MAX - footer.length - disclaimer.length);
  return { reply: reply + footer + disclaimer, sources };
}
