export interface Env {
  AI: Ai;
  VECTORIZE: Vectorize;

  // vars (wrangler.jsonc)
  EMBEDDING_MODEL: string;
  CHAT_MODEL: string;
  OPENROUTER_MODEL: string;
  RABBI_NAME: string;
  TOP_K: string;
  MIN_SCORE: string;
  GRAPH_API_VERSION: string;

  // secrets (wrangler secret put ...)
  ADMIN_TOKEN: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  /** Optional: if set, answers are generated via OpenRouter instead of Workers AI. */
  OPENROUTER_API_KEY?: string;
}

export interface QAItem {
  id: string;
  date: string;
  question: string;
  answer: string;
  text: string;
}

export interface Source {
  id: string;
  score: number;
  date: string;
  question: string;
  answer: string;
}
