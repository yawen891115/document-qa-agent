import type { DocumentInterface } from "@langchain/core/documents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { LRUCache } from "lru-cache";
import { log } from "../logger.js";
import type { WebSearchTool } from "../mcp/webSearchClient.js";
import type { KnowledgeBase } from "../rag/knowledgeBase.js";
import { formatContext, qaPrompt } from "../rag/prompts.js";
import type {
  ChatTurn,
  DocSource,
  Mode,
  PipelineEvent,
  Route,
  Timings,
  TokenUsage,
  WebSource,
} from "../types.js";
import { analyzeQuestion, buildRetrievalQuery, decideRoute, wantsWeb } from "./router.js";

export interface PipelineConfig {
  topK: number;
  minScore: number;
  historyTurns: number;
}

export interface AskOptions {
  mode?: Mode;
  history?: ChatTurn[];
  signal?: AbortSignal;
}

export interface AskResult {
  answer: string;
  route: Route;
  reason: string;
  documents: DocSource[];
  web: WebSource[];
  webError?: string;
  timings: Timings;
  usage?: TokenUsage;
  model: string;
}

interface WebOutcome {
  sources: WebSource[];
  ms: number;
  cached?: boolean;
  error?: string;
}

/**
 * The question-answering pipeline:
 *
 *   question ─┬─> embed + vector search (LangChain) ─┐
 *             └─> MCP web_search (if likely needed) ─┴─> route ─> prompt ─> GPT-5 (streamed)
 *
 * Latency design: retrieval and web search run in parallel, routing is rule-based
 * (no extra LLM call), query embeddings are cached, and tokens are streamed so the
 * user hears/sees the answer as soon as the first token arrives.
 */
export class QAPipeline {
  private readonly queryEmbeddings = new LRUCache<string, number[]>({ max: 1000 });

  constructor(
    private readonly kb: KnowledgeBase,
    private readonly chat: BaseChatModel,
    private readonly web: WebSearchTool,
    private readonly config: PipelineConfig,
    readonly modelName: string,
  ) {}

  /** Runs the pipeline and streams events (used by the SSE endpoint). */
  async *stream(question: string, options: AskOptions = {}): AsyncGenerator<PipelineEvent> {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    const { signal } = options;
    const mode = options.mode ?? "auto";
    const history = (options.history ?? []).slice(-this.config.historyTurns);
    const intent = analyzeQuestion(question);
    const hasDocuments = this.kb.chunkCount > 0;
    const timings: Timings = { totalMs: 0 };

    try {
      // 1) Fan out. Start the web search immediately when it will probably be needed,
      //    so it overlaps with retrieval instead of running after it.
      let webTask: Promise<WebOutcome> | undefined;
      if (this.web.enabled && (mode === "web" || mode === "hybrid" || (mode === "auto" && wantsWeb(intent)))) {
        timings.webSearchStartMs = elapsed();
        webTask = this.searchWeb(question, signal);
        yield { type: "status", stage: "web_search", message: "Searching the web…" };
      }

      // 2) Retrieve document chunks.
      let retrieved: [DocumentInterface, number][] = [];
      if (mode !== "web" && hasDocuments) {
        yield { type: "status", stage: "retrieval", message: "Searching your documents…" };
        const tr = performance.now();
        retrieved = await this.retrieve(buildRetrievalQuery(question, history));
        timings.retrievalMs = Math.round(performance.now() - tr);
      }

      // 3) Route.
      const { route, reason } = decideRoute({
        mode,
        intent,
        topScore: retrieved[0]?.[1],
        minScore: this.config.minScore,
        hasDocuments,
        webAvailable: this.web.enabled,
      });

      let webOutcome: WebOutcome | undefined;
      if (route !== "docs") {
        if (!webTask) {
          timings.webSearchStartMs = elapsed();
          webTask = this.searchWeb(question, signal);
          yield { type: "status", stage: "web_search", message: "Searching the web…" };
        }
        webOutcome = await webTask;
        timings.webSearchMs = webOutcome.ms;
        timings.webSearchCached = webOutcome.cached;
      }
      // For a "docs" route a speculative search is simply left to finish in the background;
      // its result lands in the MCP server's cache.

      const floor = this.config.minScore * 0.75;
      const documents: DocSource[] =
        route === "web"
          ? []
          : retrieved
              .filter(([, score]) => mode === "docs" || score >= floor)
              .slice(0, this.config.topK)
              .map(([doc, score], i) => toDocSource(doc, score, i));
      const web = webOutcome?.sources ?? [];

      yield { type: "meta", route, reason, documents, web, webError: webOutcome?.error };

      // 4) Generate.
      let answer = "";
      let usage: TokenUsage | undefined;
      if (route === "web" && web.length === 0 && webOutcome?.error) {
        answer = `I couldn't search the web just now (${webOutcome.error}). Please try again, or ask about your documents.`;
        timings.firstTokenMs = elapsed();
        yield { type: "token", text: answer };
      } else {
        yield { type: "status", stage: "generation", message: "Writing the answer…" };
        const messages = await qaPrompt.formatMessages({
          today: new Date().toDateString(),
          history: toMessages(history),
          context: formatContext(documents, web),
          question,
        });
        const stream = await this.chat.stream(messages, { signal });
        for await (const chunk of stream) {
          if (chunk.usage_metadata) {
            usage = {
              inputTokens: chunk.usage_metadata.input_tokens,
              outputTokens: chunk.usage_metadata.output_tokens,
              totalTokens: chunk.usage_metadata.total_tokens,
            };
          }
          const text = chunk.text;
          if (!text) continue;
          timings.firstTokenMs ??= elapsed();
          answer += text;
          yield { type: "token", text };
        }
      }

      timings.totalMs = elapsed();
      log.info("answered", { route, ...timings, docs: documents.length, web: web.length });
      yield { type: "done", answer: answer.trim(), route, timings, usage, model: this.modelName };
    } catch (err) {
      if (signal?.aborted) return; // client went away
      log.error("pipeline failed", { error: err instanceof Error ? err.message : String(err) });
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Runs the pipeline to completion (used by the JSON endpoint and the benchmark). */
  async ask(question: string, options: AskOptions = {}): Promise<AskResult> {
    let meta: Extract<PipelineEvent, { type: "meta" }> | undefined;
    for await (const event of this.stream(question, options)) {
      if (event.type === "meta") meta = event;
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") {
        return {
          answer: event.answer,
          route: event.route,
          reason: meta?.reason ?? "",
          documents: meta?.documents ?? [],
          web: meta?.web ?? [],
          webError: meta?.webError,
          timings: event.timings,
          usage: event.usage,
          model: event.model,
        };
      }
    }
    throw new Error("Pipeline ended without an answer");
  }

  private async retrieve(query: string): Promise<[DocumentInterface, number][]> {
    let vector = this.queryEmbeddings.get(query);
    if (!vector) {
      vector = await this.kb.store.embeddings.embedQuery(query);
      this.queryEmbeddings.set(query, vector);
    }
    return this.kb.store.similaritySearchVectorWithScore(vector, this.config.topK);
  }

  private async searchWeb(question: string, signal?: AbortSignal): Promise<WebOutcome> {
    const started = performance.now();
    const query = buildWebQuery(question);
    try {
      const r = await this.web.search(query, { signal });
      const sources: WebSource[] = [];
      if (r.answer) {
        sources.push({
          id: "W1",
          title: "Search engine answer box",
          url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
          snippet: r.answer,
          source: r.provider === "mock" ? "mock" : "Google",
        });
      }
      for (const item of r.results) {
        sources.push({
          id: `W${sources.length + 1}`,
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          source: item.source,
          date: item.date,
        });
      }
      return { sources, ms: Math.round(performance.now() - started), cached: r.cached };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("web search failed", { error });
      return { sources: [], ms: Math.round(performance.now() - started), error };
    }
  }
}

/** Questions about "current"/"latest" facts search better with the current year attached. */
export function buildWebQuery(question: string, now = new Date()): string {
  const q = question.trim();
  return analyzeQuestion(q).needsFreshInfo && !/\b(19|20)\d{2}\b/.test(q) ? `${q} ${now.getFullYear()}` : q;
}

function toDocSource(doc: DocumentInterface, score: number, i: number): DocSource {
  const m = doc.metadata as Record<string, unknown>;
  return {
    id: `D${i + 1}`,
    documentId: String(m.documentId ?? ""),
    documentName: String(m.documentName ?? "document"),
    page: typeof m.page === "number" ? m.page : undefined,
    section: typeof m.section === "string" ? m.section : undefined,
    chunkIndex: Number(m.chunkIndex ?? 0),
    score: Math.round(score * 1000) / 1000,
    text: doc.pageContent,
  };
}

function toMessages(history: ChatTurn[]): BaseMessage[] {
  return history.map((t) => (t.role === "user" ? new HumanMessage(t.content) : new AIMessage(t.content)));
}
