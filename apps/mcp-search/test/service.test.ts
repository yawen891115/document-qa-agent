import { describe, expect, it } from "vitest";
import { SearchService } from "../src/search/service.js";
import type { ProviderResult, SearchProvider } from "../src/search/types.js";

class CountingProvider implements SearchProvider {
  readonly name = "counting";
  calls = 0;
  fail = false;

  async search(query: string): Promise<ProviderResult> {
    this.calls++;
    await new Promise((r) => setTimeout(r, 20));
    if (this.fail) throw new Error("upstream down");
    return { query, provider: this.name, results: [] };
  }
}

describe("SearchService", () => {
  it("serves repeated queries from the cache (normalizing case and spaces)", async () => {
    const provider = new CountingProvider();
    const service = new SearchService(provider);
    const first = await service.search("Latest  AI news");
    const second = await service.search("latest ai news");
    expect(provider.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it("shares one upstream request between concurrent identical queries", async () => {
    const provider = new CountingProvider();
    const service = new SearchService(provider);
    await Promise.all([service.search("same"), service.search("same"), service.search("same")]);
    expect(provider.calls).toBe(1);
  });

  it("keys the cache on options too", async () => {
    const provider = new CountingProvider();
    const service = new SearchService(provider);
    await service.search("q", { timeRange: "day" });
    await service.search("q", { timeRange: "week" });
    expect(provider.calls).toBe(2);
  });

  it("does not cache failures", async () => {
    const provider = new CountingProvider();
    const service = new SearchService(provider);
    provider.fail = true;
    await expect(service.search("q")).rejects.toThrow("upstream down");
    provider.fail = false;
    await expect(service.search("q")).resolves.toMatchObject({ cached: false });
    expect(provider.calls).toBe(2);
  });

  it("rejects excess fresh queries while preserving cache hits", async () => {
    const provider = new CountingProvider();
    const service = new SearchService(provider, { daily: 2, concurrent: 1 });
    const first = service.search("first");
    await expect(service.search("different")).rejects.toThrow(/limit/);
    await first;
    await service.search("second");
    await expect(service.search("third")).rejects.toThrow(/limit/);
    await expect(service.search("first")).resolves.toMatchObject({ cached: true });
    expect(provider.calls).toBe(2);
  });

  it("lets a caller abort without cancelling the shared request", async () => {
    const provider = new CountingProvider();
    const service = new SearchService(provider);
    const controller = new AbortController();
    const aborted = service.search("q", { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(aborted).rejects.toThrow("caller gave up");
    await expect(service.search("q")).resolves.toMatchObject({ query: "q" });
    expect(provider.calls).toBe(1);
  });
});
