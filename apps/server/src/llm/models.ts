import type { Embeddings } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import OpenAI from "openai";
import type { AppConfig } from "../config.js";
import { ExtractiveChatModel, HashingEmbeddings } from "./offline.js";

export interface Models {
  provider: "openai" | "offline";
  chat: BaseChatModel;
  embeddings: Embeddings;
  chatModelName: string;
  /** Stored with the vector index; a different embedding model means the index must be rebuilt. */
  embeddingModelName: string;
  /** Raw OpenAI client for speech-to-text. Undefined in offline mode. */
  openai?: OpenAI;
}

/** GPT-5-family models accept `reasoning_effort` and `verbosity`; chat-only variants do not. */
const isGpt5Family = (model: string) => /^gpt-[5-9]/.test(model) && !model.includes("chat");

export function createModels(cfg: AppConfig["llm"], opts: { fetch?: typeof fetch } = {}): Models {
  if (cfg.provider === "offline" || !cfg.apiKey) {
    const embeddings = new HashingEmbeddings();
    return {
      provider: "offline",
      chat: new ExtractiveChatModel(),
      embeddings,
      chatModelName: "offline-extractive",
      embeddingModelName: embeddings.modelName,
    };
  }

  const configuration = {
    baseURL: cfg.publicLiveDemo ? "https://api.openai.com/v1" : cfg.baseUrl,
    ...(cfg.publicLiveDemo ? { maxRetries: 0, timeout: 20_000 } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };

  const chat = new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    streaming: true,
    maxTokens: cfg.maxOutputTokens,
    // Low latency: GPT-5 with minimal reasoning and terse output is fast enough for voice.
    ...(isGpt5Family(cfg.model) ? { reasoning: { effort: cfg.reasoningEffort }, verbosity: cfg.verbosity } : {}),
    maxRetries: cfg.publicLiveDemo ? 0 : 1,
    timeout: cfg.publicLiveDemo ? 20_000 : 30_000,
    configuration,
  });

  const embeddings = cfg.publicLiveDemo ? new HashingEmbeddings() : new OpenAIEmbeddings({
    model: cfg.embeddingModel,
    apiKey: cfg.apiKey,
    batchSize: 256,
    maxRetries: 2,
    configuration,
  });

  return {
    provider: "openai",
    chat,
    embeddings,
    chatModelName: cfg.model,
    embeddingModelName: cfg.publicLiveDemo ? (embeddings as HashingEmbeddings).modelName : cfg.embeddingModel,
    openai: cfg.publicLiveDemo ? undefined : new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
  };
}
