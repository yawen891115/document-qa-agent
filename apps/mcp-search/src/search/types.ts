export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchOptions {
  /** Number of results to return (1-10). */
  num?: number;
  /** Restrict results to a recent period. */
  timeRange?: TimeRange;
  /** Location to search from, e.g. "Seattle, Washington, United States". */
  location?: string;
  signal?: AbortSignal;
}

export interface SearchResultItem {
  position: number;
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

/** What a provider returns: normalized, provider-independent search results. */
export interface ProviderResult {
  query: string;
  provider: string;
  /** Direct answer when the engine shows one (answer box, knowledge graph, weather, stock card). */
  answer?: string;
  results: SearchResultItem[];
}

/** What the MCP tool returns: provider result plus cache and timing info. */
export interface SearchResponse extends ProviderResult {
  cached: boolean;
  tookMs: number;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<ProviderResult>;
}

export class SearchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SearchError";
  }
}
