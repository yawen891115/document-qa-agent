import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { log } from "../logger.js";

export interface WebSearchResult {
  query: string;
  provider: string;
  answer?: string;
  results: { position: number; title: string; url: string; snippet: string; source?: string; date?: string }[];
  cached: boolean;
  tookMs: number;
}

export interface WebSearchStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  tools: string[];
  error?: string;
}

/** What the RAG pipeline needs from a web search backend (an MCP server in production, a fake in tests). */
export interface WebSearchTool {
  readonly enabled: boolean;
  search(query: string, options?: { signal?: AbortSignal }): Promise<WebSearchResult>;
  status(): Promise<WebSearchStatus>;
  close(): Promise<void>;
}

/**
 * MCP client for the web-search server. Holds one long-lived client so each
 * question costs a single tools/call round trip (no per-request handshake).
 * If the server is down, the next call reconnects.
 */
export class McpWebSearchClient implements WebSearchTool {
  readonly enabled = true;
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly options: { timeoutMs: number; numResults: number; bounded?: boolean; fetch?: typeof fetch },
  ) {}

  async search(query: string, { signal }: { signal?: AbortSignal } = {}): Promise<WebSearchResult> {
    const client = await this.getClient();
    signal?.throwIfAborted();
    try {
      const result = await client.callTool(
        { name: "web_search", arguments: { query: this.options.bounded ? query.slice(0, 400) : query, num_results: this.options.numResults } },
        { timeout: this.options.timeoutMs, signal },
      );
      if (result.isError) {
        const first = result.content?.[0];
        throw new Error(first?.type === "text" ? first.text : "web_search returned an error");
      }
      return result.structuredContent as unknown as WebSearchResult;
    } catch (err) {
      if (!signal?.aborted) this.reset(); // a broken connection gets rebuilt on the next call
      throw err;
    }
  }

  async status(): Promise<WebSearchStatus> {
    try {
      const client = await this.getClient();
      const { tools } = await client.listTools(undefined, { timeout: 2000 });
      return { enabled: true, connected: true, url: this.url, tools: tools.map((t) => t.name) };
    } catch (err) {
      this.reset();
      return { enabled: true, connected: false, url: this.url, tools: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }

  private getClient(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const client = new Client({ name: "docqa-backend", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
      const transport = new StreamableHTTPClientTransport(
        new URL(this.url),
        this.options.bounded ? { fetch: (input, init) => {
          const deadline = AbortSignal.timeout(6000);
          return (this.options.fetch ?? fetch)(input, {
            ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
            redirect: "error",
          });
        } } : this.options.fetch ? { fetch: this.options.fetch } : undefined,
      );
      await client.connect(transport);
      this.client = client;
      log.info(`Connected to MCP server ${this.url}`);
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private reset(): void {
    const old = this.client;
    this.client = undefined;
    void old?.close().catch(() => undefined);
  }
}

/** Used when WEB_SEARCH_ENABLED=false. */
export class DisabledWebSearch implements WebSearchTool {
  readonly enabled = false;
  async search(): Promise<WebSearchResult> {
    throw new Error("Web search is disabled");
  }
  async status(): Promise<WebSearchStatus> {
    return { enabled: false, connected: false, url: "", tools: [] };
  }
  async close(): Promise<void> {}
}
