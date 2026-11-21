import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeSerpApi, SerpApiProvider, type SerpApiResponse } from "../src/search/serpapi.js";
import { SearchError } from "../src/search/types.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/serpapi-google.json", import.meta.url), "utf8"),
) as SerpApiResponse;

describe("normalizeSerpApi", () => {
  it("merges top stories and organic results, de-duplicates URLs and renumbers", () => {
    const out = normalizeSerpApi("q", fixture, 10);
    expect(out.results.map((r) => r.url)).toEqual([
      "https://news.example.com/irs-limits",
      "https://www.irs.gov/newsroom/example",
      "https://www.irs.gov/retirement-plans/contributions",
    ]);
    expect(out.results.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(out.results[2]?.snippet).toBe("elective deferrals … limit");
    expect(out.results[2]?.source).toBe("irs.gov");
  });

  it("respects the requested number of results", () => {
    expect(normalizeSerpApi("q", fixture, 1).results).toHaveLength(1);
  });

  it("extracts a direct answer from the answer box, then the knowledge graph", () => {
    expect(normalizeSerpApi("q", fixture, 5).answer).toMatch(/has increased/);
    const kgOnly = { ...fixture, answer_box: undefined };
    expect(normalizeSerpApi("q", kgOnly, 5).answer).toBe(
      "401(k): A 401(k) is a defined-contribution retirement account.",
    );
  });

  it("formats weather and finance answer boxes", () => {
    const weather = normalizeSerpApi("q", {
      answer_box: { type: "weather_result", temperature: "48", unit: "Fahrenheit", weather: "Light rain", location: "Seattle, WA" },
    }, 5);
    expect(weather.answer).toBe("Seattle, WA, 48°F, Light rain");

    const stock = normalizeSerpApi("q", {
      answer_box: { type: "finance_results", title: "NVIDIA Corp", price: 181.2, currency: "USD" },
    }, 5);
    expect(stock.answer).toBe("NVIDIA Corp: 181.2 USD");
  });
});

describe("SerpApiProvider", () => {
  it("sends the expected query parameters", async () => {
    let requested = "";
    const provider = new SerpApiProvider({
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        requested = String(url);
        return Response.json(fixture);
      },
    });
    const out = await provider.search("irs 401k limit", { num: 2, timeRange: "year", location: "Seattle" });
    const params = new URL(requested).searchParams;
    expect(params.get("engine")).toBe("google");
    expect(params.get("q")).toBe("irs 401k limit");
    expect(params.get("tbs")).toBe("qdr:y");
    expect(params.get("location")).toBe("Seattle");
    expect(params.get("api_key")).toBe("test-key");
    expect(out.results).toHaveLength(2);
  });

  it("turns SerpAPI's 'no results' error into an empty list", async () => {
    const provider = new SerpApiProvider({
      apiKey: "k",
      timeoutMs: 1000,
      fetchImpl: async () => Response.json({ error: "Google hasn't returned any results for this query." }),
    });
    await expect(provider.search("zzzz")).resolves.toMatchObject({ results: [] });
  });

  it("throws SearchError for API errors such as a bad key", async () => {
    const provider = new SerpApiProvider({
      apiKey: "bad",
      timeoutMs: 1000,
      fetchImpl: async () => Response.json({ error: "Invalid API key." }, { status: 401 }),
    });
    await expect(provider.search("x")).rejects.toThrow(SearchError);
    await expect(provider.search("x")).rejects.toThrow(/rejected the search request/);
  });

  it("times out slow requests", async () => {
    const provider = new SerpApiProvider({
      apiKey: "k",
      timeoutMs: 50,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(provider.search("slow")).rejects.toThrow(/timed out after 50 ms/);
  });
});
