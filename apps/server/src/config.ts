import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as z from "zod";

/** Repo root (apps/server/{src,dist}/config.* -> ../../..). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const rootEnv = `${REPO_ROOT}.env`;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());
const num = (fallback: number) => z.preprocess(emptyToUndefined, z.coerce.number().default(fallback));
const bool = (fallback: boolean) =>
  z.preprocess(emptyToUndefined, z.enum(["true", "false", "1", "0"]).optional()).transform((v) =>
    v === undefined ? fallback : v === "true" || v === "1",
  );

const EnvSchema = z.object({
  PORT: num(3000),
  HOST: z.preprocess(emptyToUndefined, z.string().default("127.0.0.1")),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["debug", "info", "warn", "error"]).default("info")),
  CORS_ORIGIN: z.preprocess(emptyToUndefined, z.string().default("http://localhost:5173")),

  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["openai", "offline"]).optional()),
  OPENAI_MODEL: z.preprocess(emptyToUndefined, z.string().default("gpt-5")),
  OPENAI_REASONING_EFFORT: z.preprocess(
    emptyToUndefined,
    z.enum(["none", "minimal", "low", "medium", "high"]).default("minimal"),
  ),
  OPENAI_VERBOSITY: z.preprocess(emptyToUndefined, z.enum(["low", "medium", "high"]).default("low")),
  OPENAI_MAX_OUTPUT_TOKENS: num(1000),
  OPENAI_EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().default("text-embedding-3-small")),
  OPENAI_TRANSCRIBE_MODEL: z.preprocess(emptyToUndefined, z.string().default("gpt-4o-mini-transcribe")),

  MCP_SERVER_URL: z.preprocess(emptyToUndefined, z.string().url().default("http://127.0.0.1:8787/mcp")),
  WEB_SEARCH_ENABLED: bool(true),
  WEB_SEARCH_TIMEOUT_MS: num(3000),
  WEB_SEARCH_RESULTS: num(5),

  RAG_TOP_K: num(5),
  RAG_MIN_SCORE: z.preprocess(emptyToUndefined, z.coerce.number().optional()),
  CHUNK_SIZE: num(1000),
  CHUNK_OVERLAP: num(150),
  HISTORY_TURNS: num(6),

  DATA_DIR: optionalString,
  MAX_UPLOAD_MB: num(20),
  SERVE_WEB: bool(true),
  PUBLIC_DEMO: bool(false),
  PUBLIC_LIVE_DEMO: bool(false),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = EnvSchema.parse(env);
  if (e.PUBLIC_DEMO && e.PUBLIC_LIVE_DEMO) throw new Error("Select one hosted mode");
  const publicDemo = e.PUBLIC_DEMO || e.PUBLIC_LIVE_DEMO;
  const provider = e.PUBLIC_LIVE_DEMO ? "openai" : e.PUBLIC_DEMO ? "offline" :
    e.LLM_PROVIDER ?? (e.OPENAI_API_KEY ? "openai" : "offline");
  if (provider === "openai" && !e.OPENAI_API_KEY) {
    throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY");
  }
  const dataDir = e.DATA_DIR ?? `${REPO_ROOT}data`;

  return {
    publicDemo,
    publicLiveDemo: e.PUBLIC_LIVE_DEMO,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    corsOrigin: e.CORS_ORIGIN.split(",").map((o) => o.trim()),
    llm: {
      provider,
      publicLiveDemo: e.PUBLIC_LIVE_DEMO,
      apiKey: e.PUBLIC_DEMO ? undefined : e.OPENAI_API_KEY,
      baseUrl: publicDemo ? undefined : e.OPENAI_BASE_URL,
      model: e.PUBLIC_LIVE_DEMO ? "gpt-5.4-mini" : e.OPENAI_MODEL,
      reasoningEffort: e.PUBLIC_LIVE_DEMO ? "none" as const : e.OPENAI_REASONING_EFFORT,
      verbosity: e.OPENAI_VERBOSITY,
      maxOutputTokens: e.PUBLIC_LIVE_DEMO ? 400 : e.OPENAI_MAX_OUTPUT_TOKENS,
      embeddingModel: e.OPENAI_EMBEDDING_MODEL,
      transcribeModel: e.OPENAI_TRANSCRIBE_MODEL,
    },
    webSearch: {
      enabled: e.PUBLIC_LIVE_DEMO || (!publicDemo && e.WEB_SEARCH_ENABLED),
      mcpServerUrl: e.PUBLIC_LIVE_DEMO ? "http://127.0.0.1:8787/mcp" : e.MCP_SERVER_URL,
      timeoutMs: e.PUBLIC_LIVE_DEMO ? 5500 : e.WEB_SEARCH_TIMEOUT_MS,
      numResults: e.PUBLIC_LIVE_DEMO ? 3 : e.WEB_SEARCH_RESULTS,
    },
    rag: {
      topK: e.PUBLIC_LIVE_DEMO ? 3 : publicDemo ? 5 : e.RAG_TOP_K,
      // Cosine-similarity threshold for "the documents are relevant". It depends on the
      // embedding model: OpenAI text-embedding-3 scores are lower than the offline hashing model's.
      minScore: e.PUBLIC_LIVE_DEMO ? 0.12 : e.RAG_MIN_SCORE ?? (provider === "openai" ? 0.3 : 0.12),
      chunkSize: e.PUBLIC_LIVE_DEMO ? 850 : e.CHUNK_SIZE,
      chunkOverlap: e.PUBLIC_LIVE_DEMO ? 150 : e.CHUNK_OVERLAP,
      historyTurns: publicDemo ? 6 : e.HISTORY_TURNS,
    },
    paths: {
      dataDir,
      indexDir: `${dataDir}/index`,
      samplesDir: `${dataDir}/samples`,
      webDist: `${REPO_ROOT}apps/web/dist`,
    },
    maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
    serveWeb: publicDemo || e.SERVE_WEB,
  };
}
