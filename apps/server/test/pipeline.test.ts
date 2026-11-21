import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createModels } from "../src/llm/models.js";
import { HashingEmbeddings } from "../src/llm/offline.js";
import { createServices, type Services } from "../src/services.js";
import { DisabledWebSearch } from "../src/mcp/webSearchClient.js";
import { collect, FakeWebSearch, SAMPLES_DIR, testConfig } from "./helpers.js";

async function setup(web = new FakeWebSearch()) {
  const services = await createServices(testConfig(), { web, persist: false });
  for (const name of ["northwind-employee-handbook.pdf", "northwind-security-policy.docx"]) {
    await services.kb.ingest(await readFile(join(SAMPLES_DIR, name)), name);
  }
  return { services, web };
}

describe("QAPipeline", () => {
  let s: Services;
  let web: FakeWebSearch;

  beforeEach(async () => {
    ({ services: s, web } = await setup());
  });

  it("streams status -> meta -> tokens -> done for a document question", async () => {
    const events = await collect(s.pipeline.stream("How long is paid parental leave?"));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("status");
    expect(types.indexOf("meta")).toBeLessThan(types.indexOf("token"));
    expect(types.at(-1)).toBe("done");

    const meta = events.find((e) => e.type === "meta")!;
    expect(meta).toMatchObject({ route: "docs", web: [] });
    if (meta.type === "meta") expect(meta.documents[0]).toMatchObject({ id: "D1", documentName: "northwind-employee-handbook.pdf", page: 3 });

    const done = events.at(-1)!;
    if (done.type !== "done") throw new Error("expected done");
    expect(done.answer).toContain("16 weeks");
    expect(done.answer).toContain("[D1]");
    expect(done.timings.firstTokenMs).toBeLessThanOrEqual(done.timings.totalMs);
    expect(web.calls).toHaveLength(0); // no web search for a pure document question
  });

  it("goes hybrid when relevant documents meet a question about current facts", async () => {
    const result = await s.pipeline.ask("What is the current IRS mileage rate that our travel policy uses for a personal car?");
    expect(result.route).toBe("hybrid");
    expect(result.documents[0]?.section).toBe("6. Travel and Expenses");
    expect(result.web[0]).toMatchObject({ id: "W1", title: "Search engine answer box" });
    expect(web.calls).toHaveLength(1);
    expect(web.calls[0]!.query).toMatch(/ \d{4}$/); // "current" -> year appended to the search query
  });

  it("runs web search in parallel with retrieval, not after it", async () => {
    // Make both steps take 60 ms. Sequential would need >= 120 ms before sources are ready.
    class SlowEmbeddings extends HashingEmbeddings {
      override async embedQuery(text: string) {
        await new Promise((r) => setTimeout(r, 60));
        return super.embedQuery(text);
      }
    }
    const config = testConfig();
    const slowWeb = new FakeWebSearch(60);
    const services = await createServices(config, {
      models: { ...createModels(config.llm), embeddings: new SlowEmbeddings() },
      web: slowWeb,
      persist: false,
    });
    await services.kb.ingest(await readFile(join(SAMPLES_DIR, "northwind-employee-handbook.pdf")), "handbook.pdf");

    const t0 = performance.now();
    let sourcesReadyMs = 0;
    let route = "";
    for await (const e of services.pipeline.stream("Is the $75 daily meal limit for business travel above the national average?")) {
      if (e.type === "meta") {
        sourcesReadyMs = performance.now() - t0;
        route = e.route;
      }
    }
    expect(route).toBe("hybrid");
    expect(sourcesReadyMs).toBeLessThan(110);
  });

  it("answers from the web when no document is relevant", async () => {
    const result = await s.pipeline.ask("Who won the most recent football world cup?");
    expect(result.route).toBe("web");
    expect(result.documents).toEqual([]);
    expect(result.answer).toMatch(/\[W\d\]/);
  });

  it("honors docs-only mode even for fresh questions", async () => {
    const result = await s.pipeline.ask("What's the latest travel policy on meals?", { mode: "docs" });
    expect(result.route).toBe("docs");
    expect(web.calls).toHaveLength(0);
  });

  it("keeps answering from documents when web search fails in hybrid mode", async () => {
    web.fail = "SerpAPI timed out";
    const result = await s.pipeline.ask("What is the meal limit when traveling?", { mode: "hybrid" });
    expect(result.route).toBe("hybrid");
    expect(result.webError).toBe("SerpAPI timed out");
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.answer).toContain("$75");
  });

  it("explains a web failure instead of calling the model when the web was the only source", async () => {
    web.fail = "MCP server unreachable";
    const result = await s.pipeline.ask("What is NVIDIA's stock price right now?", { mode: "web" });
    expect(result.answer).toMatch(/couldn't search the web/);
  });

  it("falls back to documents when web search is disabled", async () => {
    const services = await createServices(testConfig(), { web: new DisabledWebSearch(), persist: false });
    await services.kb.ingest(Buffer.from("The office closes from December 26 through December 31."), "notes.txt");
    const result = await services.pipeline.ask("Is the office open on December 28 this year?");
    expect(result.route).toBe("docs");
  });

  it("stops quietly when the caller aborts", async () => {
    const controller = new AbortController();
    const events = [];
    for await (const e of s.pipeline.stream("How long is paid parental leave?", { signal: controller.signal })) {
      events.push(e);
      if (e.type === "token") controller.abort();
    }
    expect(events.some((e) => e.type === "done" || e.type === "error")).toBe(false);
  });
});
