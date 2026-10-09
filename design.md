# System Architecture & Technical Design Document: Halacha RAG Assistant

This document outlines the architectural decisions, data flow, component design, edge cases, and tradeoffs for the **Halacha RAG Assistant** system. Any agent or engineer reviewing this repository can use this guide to understand how the system is constructed and how each component operates.

---

## 1. System Overview & Problem Statement

### 1.1 Problem
A community WhatsApp group contains over 7 years of halachic questions answered by **the Rabbi**. While this archive constitutes an authoritative body of practical rulings, WhatsApp lacks structured search capabilities. Community members frequently ask duplicate questions, and manually searching scrollback history or export files is impractical.

### 1.2 Objective
Build a production-grade, serverless Retrieval-Augmented Generation (RAG) assistant that:
1. Ingests raw WhatsApp chat exports (covering 2017/2019 through present).
2. Performs multilingual semantic retrieval over past questions and rulings.
3. Synthesizes concise, source-grounded answers with inline citations.
4. Enforces strict refusal guardrails to eliminate AI hallucinations.
5. Operates 24/7 on a 100% free serverless cloud stack with official WhatsApp integration.

---

## 2. High-Level Architecture

```
[Raw WhatsApp Export (.txt)]
        │
        ▼ (Offline Pipeline: Node.js / TypeScript)
┌───────────────────────────────────────────────┐
│ 1. Stream Parser & Text Sanitizer             │
│    - Strips LRM/RLM directional marks         │
│    - Filters system noise & media tags        │
│    - Redacts PII (emails, 9+ digit phones)    │
│ 2. Heuristic Q&A Alignment Engine             │
│    - Merges Rabbi answer bursts (20m window)  │
│    - Pairs trailing community queries (72h)   │
│ 3. Deterministic Id Generator (FNV-1a Hash)   │
└───────────────────────────────────────────────┘
        │
        ▼ POST /admin/ingest (Bearer Token Auth)
┌────────────────────────────────────────────────────────────────────────┐
│ Cloudflare Edge Worker (https://halacha-rag.jborenstein.workers.dev)   │
│                                                                        │
│   ┌─────────────────────┐          ┌────────────────────────────────┐  │
│   │ Workers AI: bge-m3  │ ───────► │ Cloudflare Vectorize           │  │
│   │ (1024-dim dense)    │          │ - Index: halacha-qa            │  │
│   └─────────────────────┘          │ - Distance: Cosine             │  │
│                                    │ - Metadata: date, q, a stored  │  │
│                                    │   directly inside vector index │  │
│                                    └────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ Webhook / Queries
                                    │
               ┌────────────────────┴────────────────────┐
               │                                         │
               ▼                                         ▼
   [Meta WhatsApp Cloud API]                  [Local Terminal CLI]
   - Webhook verification (GET /webhook)      - npm run ask
   - HMAC-SHA256 signature check             - Interactive REPL mode
   - Async execution via ctx.waitUntil()     - Test suite (Vitest)
```

---

## 3. Data Pipeline & Ingestion (`scripts/`)

### 3.1 WhatsApp Export Parser (`scripts/lib/whatsapp-export.ts`)
WhatsApp chat exports do not conform to a standard schema and vary significantly between operating systems and regional locales.

* **Date & Timestamp Normalization:**
  - **iOS Format:** `[M/D/YY, H:MM:SS AM/PM] Name: Text`
  - **Android Format:** `DD/MM/YYYY, HH:MM - Name: Text` or `M/D/YY, H:MM AM/PM - Name: Text`
  - The parser dynamically samples the first distinct date lines to detect day-first (`dmy`) vs month-first (`mdy`) patterns.
* **Bi-directional Unicode Sanitization:**
  WhatsApp exports insert invisible Left-to-Right Marks (LRM `\u200e`) and Right-to-Left Marks (RLM `\u200f`) around names and timestamps. If left unstripped, these corrupt regex boundary matching and degrade embedding tokenization.
* **Noise Filtering:**
  Regex filters drop media notices (`image omitted`, `audio omitted`, `video omitted`), message deletions (`This message was deleted`), and group event lines (`X joined`, `Messages are encrypted`).
* **PII Protection & Halachic Reference Safety:**
  Personal phone numbers and emails are scrubbed before storage. The phone redactor uses a custom length validator (`digits >= 9`) to ensure valid halachic references (e.g. *Shulchan Aruch Orach Chaim 128:13*) or calendar dates are not mistakenly redacted.

### 3.2 Heuristic Q&A Alignment
WhatsApp export text does not include quote/reply metadata or message thread IDs. A deterministic heuristic algorithm pairs community questions with Rabbi rulings:
1. **Bursted Answer Merging:** When the Rabbi posts multiple consecutive messages within 20 minutes (e.g., clarifying a ruling across 3 quick texts), they are concatenated into a single atomic answer block.
2. **Trailing Question Association:** Up to 4 community messages submitted within the preceding 72-hour sliding window are attached as the question context.
3. **Standalone Post Preservation:** Rabbi messages posted with no prior question (e.g., general zmanim reminders or holiday announcements) are preserved and labeled as `Rabbi's post: ...`.
4. **Short Noise Discard:** Answers shorter than 15 characters (e.g., thumbs-up emojis, single-word acknowledgments) are pruned to keep the index clean.

### 3.3 Deterministic ID Hashing (`stableId`)
Each record is assigned a deterministic 16-character hexadecimal identifier derived via a two-round FNV-1a hash of the timestamp and answer text:
```ts
export function stableId(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
```
**Advantage:** Ingestion is completely **idempotent**. Re-running ingestion or adding new chat exports will cleanly upsert without creating duplicate vectors.

---

## 4. Vector Storage & Retrieval Architecture

### 4.1 Cloudflare Vectorize (`halacha-qa`)
* **Dimensions:** 1024
* **Distance Metric:** Cosine similarity
* **Serverless Metadata Storage:**
  Vectorize supports up to 10 KiB of key-value metadata per vector. Rather than running a secondary SQL database (PostgreSQL/D1) or KV store, each vector payload stores:
  ```json
  {
    "id": "7b8d4f1092a1...",
    "values": [0.012, -0.045, ...],
    "metadata": {
      "date": "2025-09-01",
      "question": "What should one do if...",
      "answer": "Best say brachos in an undertone..."
    }
  }
  ```
  This eliminates cross-database lookups and network roundtrips, allowing the worker to retrieve query vectors, scores, and source text in a single query.

### 4.2 Embedding Model: `@cf/baai/bge-m3`
* **Why BGE-M3:** Dense 1024-dimension embedding model specifically chosen for its strong multilingual and multi-granularity performance. It reliably projects transliterated Hebrew, ashkenazic/sephardic spellings, and halachic vocabulary (*muktzeh*, *basar b'chalav*, *chometz*, *b'dieved*, *lechatchila*, *hechsher*) into the same semantic vector space as English community questions.

---

## 5. RAG Pipeline & Hallucination Mitigation (`src/rag.ts`)

### 5.1 Two-Stage Guardrail Architecture

#### Stage 1: Similarity Cutoff Pre-Filter (`MIN_SCORE = 0.45`)
* When a query is embedded, Vectorize returns the top 5 nearest neighbors.
* Matches with cosine similarity scores below `0.45` are discarded.
* If **0 matches** remain (e.g. out-of-domain queries like car repairs or general trivia), the worker **bypasses LLM generation completely** and returns an immediate refusal:
  > *"I couldn't find anything about that in the Rabbi's Q&A archive. Please ask the Rabbi directly."*
* **Benefits:** 0 tokens consumed, sub-100ms response time, zero risk of hallucination.

#### Stage 2: Grounded Prompt & Explicit Refusal Mandate
If candidate sources pass the similarity threshold, they are compiled into the LLM context. The system prompt enforces strict grounding:
* The model must act as an archivist summarizing **only** the numbered sources provided.
* It must refuse to extrapolate or supply halachic facts not contained in the sources.
* It must cite sources inline using numbers `[1]`, `[2]`.

### 5.2 Dynamic Bibliography Extraction
Generative models often recite all supplied context numbers whether used or not. Our post-processor inspects the draft text for explicit inline citations:
```ts
const cited = [...new Set([...draft.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
  .filter((n) => n >= 1 && n <= sources.length)
  .sort((a, b) => a - b);
```
Only the sources actually cited by the model are formatted into the trailing `📚 Sources` section, detailing the date and question summary. Every response concludes with a mandatory rabbinic disclaimer.

### 5.3 Inference Model
* **Default:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` hosted on Cloudflare Workers AI.
* **Optional OpenRouter Fallback:** Setting `OPENROUTER_API_KEY` routes requests to OpenRouter (`meta-llama/llama-3.3-70b-instruct:free` or any preferred model) without changing code.

---

## 6. WhatsApp Cloud API Integration (`src/index.ts`, `src/whatsapp.ts`)

### 6.1 Webhook Verification & HMAC Security
* **GET `/webhook`:** Responds to Meta's initial handshake challenge by validating `hub.verify_token`.
* **POST `/webhook`:** Validates Meta's cryptographic `X-Hub-Signature-256` header using Web Crypto HMAC-SHA256:
  ```ts
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), ...);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  ```
  Signatures are compared using constant-time XOR operations to defend against timing attacks.

### 6.2 Asynchronous Execution (`ctx.waitUntil`)
Meta requires webhooks to return an HTTP `200 OK` within 3 seconds; otherwise, Meta marks the webhook unhealthy and retries duplicate messages.
* The worker parses incoming message objects, fires an immediate `200 OK` response to Meta, and dispatches the RAG pipeline using `ctx.waitUntil(handleIncoming(env, msg))`.
* Inside `handleIncoming`:
  1. The bot issues a WhatsApp API call marking the message read and displaying the native `typing...` indicator.
  2. The RAG pipeline executes.
  3. The answer is sent back via the Graph API as a direct quoted reply (`context.message_id`).

---

## 7. Configuration & Environment Variables

### 7.1 Non-Secret Variables (`wrangler.jsonc`)
| Variable | Value | Description |
|---|---|---|
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | 1024-dimension Workers AI embedding model |
| `CHAT_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI instruction-tuned model |
| `RABBI_NAME` | `the Rabbi` | Injected into system prompt and refusals |
| `TOP_K` | `5` | Maximum vectors retrieved per query |
| `MIN_SCORE` | `0.45` | Cosine similarity cutoff threshold |
| `GRAPH_API_VERSION` | `v23.0` | Meta Graph API version |

### 7.2 Secrets (`wrangler secret put <NAME>`)
* `ADMIN_TOKEN`: Bearer token protecting `/admin/ingest` and `/ask`.
* `WHATSAPP_TOKEN`: Meta System User access token.
* `WHATSAPP_PHONE_NUMBER_ID`: Meta phone number ID.
* `WHATSAPP_APP_SECRET`: App secret used to verify webhook HMAC signatures.
* `WHATSAPP_VERIFY_TOKEN`: Random passphrase for Meta webhook verification.
* `OPENROUTER_API_KEY`: *(Optional)* OpenRouter key if bypassing Workers AI.

---

## 8. Development & Operational Commands

| Command | Action |
|---|---|
| `npm run senders -- <file>` | Scans chat export and outputs sender message counts |
| `npm run parse -- <file> --rabbi "<name>"` | Cleans, redacts, and chunks chat into `data/qa.json` |
| `npm run ingest` | Uploads and embeds `data/qa.json` into Vectorize |
| `npm run ask` | Launches interactive REPL test console |
| `npm run ask -- "<question>"` | Submits a single query to the live Worker API |
| `npm test` | Runs parser unit tests via Vitest |
| `npm run typecheck` | Validates TypeScript typing for Worker and scripts |
| `npm run deploy` | Compiles and deploys Worker to Cloudflare |
| `npm run tail` | Streams real-time production Worker logs |

---

## 9. File Structure Map

```
RAG-Project/
├── .env                          # Local credentials (WORKER_URL, ADMIN_TOKEN) [git-ignored]
├── .gitignore                    # Ignores .env, node_modules, data/, .DS_Store
├── package.json                  # Scripts & dependencies (tsx, wrangler, vitest, typescript)
├── tsconfig.json                 # Worker TypeScript config (Workers runtime types)
├── wrangler.jsonc                # Cloudflare Worker configuration & AI/Vectorize bindings
├── README.md                     # High-level overview & quickstart
├── design.md                     # This comprehensive technical design document
├── data/                         # Chat exports & intermediate JSON [git-ignored]
│   ├── .gitkeep
│   ├── bigger_chat.txt           # 7-year WhatsApp transcript (9,330 messages)
│   └── qa.json                   # 2,040 parsed and sanitized Q&A chunks
├── src/                          # Cloudflare Worker Edge Source Code
│   ├── index.ts                  # HTTP router (webhooks, /admin/ingest, /ask, health check)
│   ├── rag.ts                    # Core RAG engine (embedding, Vectorize query, Llama generation)
│   ├── whatsapp.ts               # Meta API client, typing indicator, HMAC signature verification
│   └── types.ts                  # Worker environment bindings, QAItem, Source interfaces
├── scripts/                      # Offline Data Ingestion & CLI Tooling
│   ├── parse-chat.ts             # CLI entrypoint for parsing chat exports
│   ├── ingest.ts                 # Batch ingestion client with retry logic
│   ├── ask.ts                    # Interactive terminal test console (REPL & single query)
│   ├── tsconfig.json             # Scripts TypeScript config (Node.js runtime types)
│   └── lib/
│       └── whatsapp-export.ts    # WhatsApp export parser, sanitization, pairing, stableId
└── test/                         # Unit Tests
    └── whatsapp-export.test.ts   # Vitest tests for iOS/Android parser and Q&A pairing logic
```
