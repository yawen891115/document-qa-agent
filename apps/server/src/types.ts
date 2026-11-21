/** Which knowledge sources the user allows for a question. "auto" lets the router decide. */
export type Mode = "auto" | "docs" | "web" | "hybrid";

/** Which sources were actually used to answer. */
export type Route = "docs" | "web" | "hybrid";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A retrieved document chunk, cited as [D1], [D2], ... */
export interface DocSource {
  id: string;
  documentId: string;
  documentName: string;
  page?: number;
  section?: string;
  chunkIndex: number;
  score: number;
  text: string;
}

/** A web search result, cited as [W1], [W2], ... */
export interface WebSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

export interface Timings {
  /** Query embedding + vector search (starts at ~0 ms). */
  retrievalMs?: number;
  /** When the MCP web_search call started: ~0 ms if it ran in parallel with retrieval. */
  webSearchStartMs?: number;
  /** Duration of the MCP web_search call. */
  webSearchMs?: number;
  webSearchCached?: boolean;
  /** Request start -> first answer token: the latency the user feels. */
  firstTokenMs?: number;
  totalMs: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Events streamed to the client over SSE, in this order: status* -> meta -> token* -> done (or error). */
export type PipelineEvent =
  | { type: "status"; stage: "retrieval" | "web_search" | "generation"; message: string }
  | {
      type: "meta";
      route: Route;
      reason: string;
      documents: DocSource[];
      web: WebSource[];
      webError?: string;
    }
  | { type: "token"; text: string }
  | { type: "done"; answer: string; route: Route; timings: Timings; usage?: TokenUsage; model: string }
  | { type: "error"; message: string };

export type DocumentKind = "pdf" | "docx" | "markdown" | "rst" | "text";

export interface DocumentRecord {
  id: string;
  name: string;
  kind: DocumentKind;
  sizeBytes: number;
  pages?: number;
  chunks: number;
  createdAt: string;
}

/** GET /api/health */
export interface HealthResponse {
  status: "ok";
  publicDemo?: boolean;
  publicLiveDemo?: boolean;
  llm: { provider: "openai" | "offline"; model: string; embeddingModel: string };
  webSearch: { enabled: boolean; connected: boolean; url: string; tools: string[]; error?: string };
  voice: { serverTranscription: boolean };
  documents: number;
  chunks: number;
}
