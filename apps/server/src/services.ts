import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { QAPipeline } from "./agent/pipeline.js";
import type { AppConfig } from "./config.js";
import { createModels, type Models } from "./llm/models.js";
import { REPO_ROOT } from "./config.js";
import { log } from "./logger.js";
import { DisabledWebSearch, McpWebSearchClient, type WebSearchTool } from "./mcp/webSearchClient.js";
import { KnowledgeBase } from "./rag/knowledgeBase.js";
import { LocalVectorStore } from "./rag/vectorStore.js";

export interface Services {
  config: AppConfig;
  models: Models;
  kb: KnowledgeBase;
  web: WebSearchTool;
  pipeline: QAPipeline;
  close(): Promise<void>;
}

const DEMO_SAMPLES = ["northwind-employee-handbook.pdf", "northwind-security-policy.docx"] as const;

/** Wires everything together. Tests pass `overrides` to swap in fakes. */
export async function createServices(
  config: AppConfig,
  overrides: { models?: Models; web?: WebSearchTool; persist?: boolean } = {},
): Promise<Services> {
  const models = config.publicDemo && !config.publicLiveDemo ? createModels(config.llm) : overrides.models ?? createModels(config.llm);
  const persist = !config.publicDemo && (overrides.persist ?? true);

  const store = new LocalVectorStore(models.embeddings, {
    file: persist ? `${config.paths.indexDir}/vectors.json` : undefined,
    embeddingModel: models.embeddingModelName,
  });
  const kb = new KnowledgeBase(store, models.embeddings, {
    chunkSize: config.rag.chunkSize,
    chunkOverlap: config.rag.chunkOverlap,
    registryFile: persist ? `${config.paths.indexDir}/documents.json` : undefined,
  });
  await kb.load();
  if (config.publicDemo) {
    // Never use DATA_DIR, a previously populated index, or a directory glob in the hosted demo.
    for (const name of DEMO_SAMPLES) {
      await kb.ingest(await readFile(join(REPO_ROOT, "data", "samples", name)), name);
    }
  }

  const web = config.publicDemo && !config.publicLiveDemo ? new DisabledWebSearch() :
    overrides.web ??
    (config.webSearch.enabled
      ? new McpWebSearchClient(config.webSearch.mcpServerUrl, {
          timeoutMs: config.webSearch.timeoutMs,
          numResults: config.webSearch.numResults,
          bounded: config.publicLiveDemo,
        })
      : new DisabledWebSearch());

  const pipeline = new QAPipeline(kb, models.chat, web, { ...config.rag, publicDemo: config.publicDemo, publicLiveDemo: config.publicLiveDemo }, models.chatModelName);

  log.info("Services ready", {
    llm: models.provider === "openai" ? models.chatModelName : "offline (no OPENAI_API_KEY)",
    embeddings: models.embeddingModelName,
    documents: kb.list().length,
    chunks: kb.chunkCount,
    webSearch: web.enabled ? "enabled" : "disabled",
  });

  return { config, models, kb, web, pipeline, close: () => web.close() };
}
