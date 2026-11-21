import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { McpSearchConfig } from "../config.js";
import { MockSearchProvider } from "./mock.js";
import { SerpApiProvider } from "./serpapi.js";
import type { ProviderResult, SearchOptions, SearchProvider, SearchResponse } from "./types.js";

/**
 * Wraps a provider with an LRU+TTL cache.
 *
 * The cache stores the in-flight Promise, not just the result, so two identical
 * queries that arrive at the same time share one upstream request.
 */
export class SearchService {
  private utcDay = -1;
  private upstreamToday = 0;
  private active = 0;
  private readonly cache: LRUCache<string, Promise<ProviderResult>>;

  constructor(
    readonly provider: SearchProvider,
    private readonly limits: { ttlMs?: number; maxEntries?: number; daily?: number; concurrent?: number } = {},
  ) {
    this.cache = new LRUCache({ max: limits.maxEntries ?? 500, ttl: limits.ttlMs ?? 600_000 });
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const started = performance.now();
    options.signal?.throwIfAborted();
    const queryIdentity = JSON.stringify([
      query.trim().toLowerCase().replace(/\s+/g, " "),
      options.num ?? 5,
      options.timeRange ?? "",
      options.location ?? "",
    ]);

    const key = createHash("sha256").update(queryIdentity).digest("hex");
    let pending = this.cache.get(key);
    const cached = pending !== undefined;
    if (!pending) {
      // The upstream request is shared, so it must not be tied to one caller's abort signal.
      const day = Math.floor(Date.now() / 86_400_000);
      if (day !== this.utcDay) { this.utcDay = day; this.upstreamToday = 0; }
      if (this.upstreamToday >= (this.limits.daily ?? Infinity) || this.active >= (this.limits.concurrent ?? Infinity)) {
        throw new Error("Search usage limit reached");
      }
      this.upstreamToday++;
      this.active++;
      pending = this.provider.search(query, { ...options, signal: undefined })
        .then((result) => ({ ...result, query: "" }))
        .finally(() => { this.active--; });
      this.cache.set(key, pending);
      pending.catch(() => { if (this.cache.get(key) === pending) this.cache.delete(key); }); // never cache failures
    }

    const result = options.signal ? await raceAbort(pending, options.signal) : await pending;
    return { ...result, query, cached, tookMs: Math.round(performance.now() - started) };
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createSearchService(config: McpSearchConfig): SearchService {
  const provider: SearchProvider =
    config.provider === "serpapi" && config.serpApiKey
      ? new SerpApiProvider({
          apiKey: config.serpApiKey,
          timeoutMs: config.serpApiTimeoutMs,
          gl: config.serpApiGl,
          hl: config.serpApiHl,
        })
      : new MockSearchProvider();
  return new SearchService(provider, {
    ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries,
    ...(config.publicLiveDemo ? { daily: 10, concurrent: 2 } : {}),
  });
}
