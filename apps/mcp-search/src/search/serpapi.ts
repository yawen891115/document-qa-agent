import {
  SearchError,
  type ProviderResult,
  type SearchOptions,
  type SearchProvider,
  type SearchResultItem,
  type TimeRange,
} from "./types.js";

const ENDPOINT = "https://serpapi.com/search.json";

/** Google "tbs" values for time-restricted searches. */
const TIME_RANGE_TBS: Record<TimeRange, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

export interface SerpApiOptions {
  apiKey: string;
  timeoutMs: number;
  gl?: string;
  hl?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** Google Search through SerpAPI (https://serpapi.com/search-api). */
export class SerpApiProvider implements SearchProvider {
  readonly name = "serpapi";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SerpApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: string, { num = 5, timeRange, location, signal }: SearchOptions = {}): Promise<ProviderResult> {
    const params = new URLSearchParams({
      engine: "google",
      q: query,
      api_key: this.options.apiKey,
      gl: this.options.gl ?? "us",
      hl: this.options.hl ?? "en",
    });
    if (timeRange) params.set("tbs", TIME_RANGE_TBS[timeRange]);
    if (location) params.set("location", location);

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const res = await this.fetchImpl(`${ENDPOINT}?${params}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: "application/json" },
    }).catch((err: unknown) => {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new SearchError(timedOut ? `SerpAPI timed out after ${this.options.timeoutMs} ms` : `SerpAPI request failed: ${String(err)}`);
    });

    const body = (await res.json().catch(() => ({}))) as SerpApiResponse;
    if (body.error) {
      // SerpAPI reports "no results" as an error; for us it is just an empty result list.
      if (/hasn't returned any results/i.test(body.error)) return { query, provider: this.name, results: [] };
      throw new SearchError(`SerpAPI: ${body.error}`, res.status);
    }
    if (!res.ok) throw new SearchError(`SerpAPI HTTP ${res.status}`, res.status);

    return normalizeSerpApi(query, body, num);
  }
}

// --------------------------------------------------------------------------- //
// Response normalization (exported for tests)
// --------------------------------------------------------------------------- //

interface SerpApiOrganic {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
  snippet_highlighted_words?: string[];
  source?: string;
  date?: string;
}

interface SerpApiTopStory {
  title?: string;
  link?: string;
  source?: string;
  date?: string;
}

export interface SerpApiResponse {
  error?: string;
  answer_box?: Record<string, unknown>;
  knowledge_graph?: { title?: string; description?: string };
  organic_results?: SerpApiOrganic[];
  top_stories?: SerpApiTopStory[];
}

export function normalizeSerpApi(query: string, body: SerpApiResponse, num: number): ProviderResult {
  // Fresh news first (only present for newsy queries), then regular organic results.
  const stories: SearchResultItem[] = (body.top_stories ?? []).slice(0, 2).flatMap((s) =>
    s.title && s.link
      ? [{ position: 0, title: s.title, url: s.link, snippet: [s.source, s.date].filter(Boolean).join(" · "), source: s.source, date: s.date }]
      : [],
  );
  const organic: SearchResultItem[] = (body.organic_results ?? []).flatMap((r) =>
    r.title && r.link
      ? [{
          position: 0,
          title: r.title,
          url: r.link,
          snippet: r.snippet ?? r.snippet_highlighted_words?.join(" … ") ?? "",
          source: r.source ?? hostname(r.link),
          date: r.date,
        }]
      : [],
  );

  const seen = new Set<string>();
  const results = [...stories, ...organic]
    .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
    .slice(0, num)
    .map((r, i) => ({ ...r, position: i + 1 }));

  return { query, provider: "serpapi", answer: extractAnswer(body), results };
}

function extractAnswer(body: SerpApiResponse): string | undefined {
  const box = body.answer_box;
  if (box) {
    const str = (k: string) => (typeof box[k] === "string" || typeof box[k] === "number" ? String(box[k]) : undefined);
    if (box.type === "weather_result" && str("temperature")) {
      const unit = str("unit")?.startsWith("C") ? "°C" : "°F";
      return [str("location"), `${str("temperature")}${unit}`, str("weather"), str("date")].filter(Boolean).join(", ");
    }
    if (box.type === "finance_results" && str("price")) {
      return `${str("title") ?? str("stock") ?? "Price"}: ${str("price")} ${str("currency") ?? ""}`.trim();
    }
    const direct = str("answer") ?? str("result") ?? str("snippet");
    if (direct) return direct;
    const words = box.snippet_highlighted_words;
    if (Array.isArray(words) && words.length) return words.join(", ");
  }
  const kg = body.knowledge_graph;
  if (kg?.description) return kg.title ? `${kg.title}: ${kg.description}` : kg.description;
  return undefined;
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
