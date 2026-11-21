import type { ProviderResult, SearchOptions, SearchProvider } from "./types.js";

/**
 * Offline provider used when SERPAPI_API_KEY is not set and in tests.
 * Results are clearly labeled as mock data so nobody mistakes them for real search results.
 */
export class MockSearchProvider implements SearchProvider {
  readonly name = "mock";

  constructor(private readonly latencyMs = 0) {}

  async search(query: string, { num = 5, signal }: SearchOptions = {}): Promise<ProviderResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    signal?.throwIfAborted();

    const slug = encodeURIComponent(query.toLowerCase().trim());
    const results = Array.from({ length: Math.min(num, 3) }, (_, i) => ({
      position: i + 1,
      title: `[mock] Result ${i + 1} for "${query}"`,
      url: `https://example.com/mock-search/${i + 1}?q=${slug}`,
      snippet:
        "Mock web result. Set SERPAPI_API_KEY in .env to get live Google results through SerpAPI.",
      source: "example.com",
    }));
    return { query, provider: this.name, results };
  }
}
