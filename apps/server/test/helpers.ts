import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import type { WebSearchResult, WebSearchStatus, WebSearchTool } from "../src/mcp/webSearchClient.js";
import type { PipelineEvent } from "../src/types.js";

export const SAMPLES_DIR = fileURLToPath(new URL("../../../data/samples/", import.meta.url));

/** Offline config (no OpenAI key) with a throwaway data directory. */
export function testConfig(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "docqa-test-"));
  const config = loadConfig({ DATA_DIR: dataDir, LOG_LEVEL: "error", ...env });
  return { ...config, paths: { ...config.paths, samplesDir: SAMPLES_DIR } };
}

/** In-memory web search with controllable latency and failures. */
export class FakeWebSearch implements WebSearchTool {
  readonly enabled = true;
  calls: { query: string; at: number }[] = [];
  fail?: string;

  constructor(private readonly latencyMs = 30) {}

  async search(query: string): Promise<WebSearchResult> {
    this.calls.push({ query, at: performance.now() });
    await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.fail) throw new Error(this.fail);
    return {
      query,
      provider: "fake",
      answer: "The 2026 401(k) employee contribution limit is $24,500.",
      results: [
        { position: 1, title: "401(k) limit increases", url: "https://www.irs.gov/example", snippet: "Limits for 2026 were announced.", source: "irs.gov" },
        { position: 2, title: "Weather in Seattle", url: "https://weather.example.com/seattle", snippet: "Cloudy, 48°F." },
      ],
      cached: false,
      tookMs: this.latencyMs,
    };
  }

  async status(): Promise<WebSearchStatus> {
    return { enabled: true, connected: true, url: "fake://web", tools: ["web_search"] };
  }

  async close(): Promise<void> {}
}

export async function collect(gen: AsyncGenerator<PipelineEvent>): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Typed shortcut for response JSON (fetch's json() is `unknown`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = (res: Response): Promise<any> => res.json();

/** Parses an SSE response body into {event, data} records. */
export async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      return { event, data: JSON.parse(data) };
    });
}
