/**
 * End-to-end quality + latency benchmark against a running API.
 *
 *   npm run bench                                  # data/eval/questions.jsonl, 2 runs
 *   npm run bench -- --runs 3 --url http://localhost:3000
 *
 * For each question it calls POST /api/chat/stream and measures, on the client side:
 *   - time to first token (what a user waits before the answer starts), and total time
 *   - route accuracy (auto router vs. expected_route)
 *   - retrieval hit rate (expected_source among the cited document chunks)
 *   - keyword recall (expected facts present in the answer; docs questions only)
 * Run 1 is "cold"; later runs show the effect of the caches (query embeddings, search results).
 * A JSON report is written to benchmarks/results/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../src/config.js";

interface EvalQuestion {
  id: string;
  question: string;
  expected_route: "docs" | "web" | "hybrid";
  expected_source: string | null;
  answer_keywords: string[];
}

interface RunResult {
  id: string;
  run: number;
  expectedRoute: string;
  route?: string;
  routeOk: boolean;
  sourceHit?: boolean;
  keywordRecall?: number;
  ttftMs?: number;
  totalMs: number;
  server?: Record<string, number | boolean | undefined>;
  error?: string;
  answer?: string;
}

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.BENCH_URL ?? "http://127.0.0.1:3000" },
    runs: { type: "string", default: "2" },
    file: { type: "string", default: `${REPO_ROOT}data/eval/questions.jsonl` },
    mode: { type: "string", default: "auto" },
  },
});
const base = values.url!.replace(/\/$/, "");
const runs = Number(values.runs);

interface Answer {
  route?: string;
  docs: string[];
  answer?: string;
  ttftMs?: number;
  totalMs: number;
  server?: Record<string, number | boolean | undefined>;
}

async function ask(question: string): Promise<Answer> {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, mode: values.mode }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let ttftMs: number | undefined;
  let meta: any;
  let done: any;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
      if (event === "token" && ttftMs === undefined) ttftMs = performance.now() - t0;
      if (event === "meta") meta = data;
      if (event === "done") done = data;
      if (event === "error") throw new Error(data.message);
    }
  }
  return {
    route: meta?.route,
    docs: (meta?.documents ?? []).map((d: { documentName: string }) => d.documentName),
    answer: done?.answer,
    ttftMs: ttftMs === undefined ? undefined : Math.round(ttftMs),
    totalMs: Math.round(performance.now() - t0),
    server: done?.timings,
  };
}

function percentile(xs: number[], p: number): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const fmt = (ms?: number) => (ms === undefined ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

// --------------------------------------------------------------------------- //
interface Health {
  documents: number;
  llm: { provider: string; model: string };
  webSearch: { connected: boolean };
}
const health = await fetch(`${base}/api/health`).then((r) => r.json() as Promise<Health>).catch((): never => {
  console.error(`API not reachable at ${base}. Start it with "npm run dev" first.`);
  process.exit(1);
});
if (health.documents === 0) {
  console.log("Index is empty: loading sample documents...");
  await fetch(`${base}/api/documents/samples`, { method: "POST" });
}
console.log(`LLM: ${health.llm.provider} (${health.llm.model}) | web search: ${health.webSearch.connected ? "connected" : "OFF"}`);

const questions: EvalQuestion[] = (await readFile(values.file!, "utf8"))
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

await ask("warm-up: hello").catch(() => undefined); // opens connections, not counted

const results: RunResult[] = [];
for (let run = 1; run <= runs; run++) {
  for (const q of questions) {
    try {
      const r = await ask(q.question);
      const answer = (r.answer ?? "").toLowerCase();
      const groups = q.answer_keywords.map((g) => g.split("|").some((k) => answer.includes(k.toLowerCase())));
      results.push({
        id: q.id,
        run,
        expectedRoute: q.expected_route,
        route: r.route,
        routeOk: r.route === q.expected_route,
        sourceHit: q.expected_source ? r.docs.includes(q.expected_source) : undefined,
        keywordRecall: groups.length && q.expected_route === "docs" ? groups.filter(Boolean).length / groups.length : undefined,
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        server: r.server,
        answer: r.answer,
      });
      process.stdout.write(".");
    } catch (err) {
      results.push({ id: q.id, run, expectedRoute: q.expected_route, routeOk: false, totalMs: 0, error: String(err) });
      process.stdout.write("x");
    }
  }
}
console.log("\n");

// --------------------------------------------------------------------------- //
const ok = results.filter((r) => !r.error);
const rows = [];
for (let run = 1; run <= runs; run++) {
  for (const route of ["docs", "hybrid", "web", "all"]) {
    const subset = ok.filter((r) => r.run === run && (route === "all" || r.expectedRoute === route));
    if (!subset.length) continue;
    const ttft = subset.flatMap((r) => (r.ttftMs === undefined ? [] : [r.ttftMs]));
    const total = subset.map((r) => r.totalMs);
    rows.push({
      run: run === 1 ? "1 (cold)" : `${run} (warm)`,
      questions: route,
      n: subset.length,
      "p50 first token": fmt(percentile(ttft, 50)),
      "p95 first token": fmt(percentile(ttft, 95)),
      "p50 total": fmt(percentile(total, 50)),
      "p95 total": fmt(percentile(total, 95)),
      "< 2 s total": pct(total.filter((t) => t < 2000).length / total.length),
    });
  }
}
console.table(rows);

const firstRun = ok.filter((r) => r.run === 1);
const withSource = firstRun.filter((r) => r.sourceHit !== undefined);
const withKeywords = firstRun.filter((r) => r.keywordRecall !== undefined);
const quality = {
  "route accuracy": pct(firstRun.filter((r) => r.routeOk).length / Math.max(1, firstRun.length)),
  "retrieval hit rate": pct(withSource.filter((r) => r.sourceHit).length / Math.max(1, withSource.length)),
  "keyword recall (docs)": pct(withKeywords.reduce((s, r) => s + (r.keywordRecall ?? 0), 0) / Math.max(1, withKeywords.length)),
  errors: results.length - ok.length,
};
console.table([quality]);

const misrouted = firstRun.filter((r) => !r.routeOk).map((r) => `${r.id}: expected ${r.expectedRoute}, got ${r.route}`);
if (misrouted.length) console.log(`Misrouted:\n  ${misrouted.join("\n  ")}`);

const outDir = `${REPO_ROOT}benchmarks/results`;
await mkdir(outDir, { recursive: true });
const outFile = `${outDir}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(outFile, JSON.stringify({ url: base, health, latency: rows, quality, results }, null, 2));
console.log(`\nReport: ${outFile}`);
