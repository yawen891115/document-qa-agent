import type { AddressInfo } from "node:net";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createApp } from "../src/app.js";
import { McpWebSearchClient } from "../src/mcp/webSearchClient.js";
import { createServices, type Services } from "../src/services.js";
import { json, readSse, testConfig } from "./helpers.js";

/**
 * End-to-end over HTTP: Express API -> pipeline -> real MCP client -> an
 * in-process MCP server exposing the same `web_search` tool contract.
 */
function fakeMcpServer() {
  const calls: string[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fake-search", version: "1.0.0" });
    server.registerTool(
      "web_search",
      { description: "fake", inputSchema: z.object({ query: z.string(), num_results: z.number().optional() }) },
      async ({ query }) => {
        calls.push(query);
        const structuredContent = {
          query,
          provider: "fake",
          results: [{ position: 1, title: "Seattle weather", url: "https://weather.example.com", snippet: "Rain likely today, high of 48°F." }],
          cached: false,
          tookMs: 5,
        };
        return { content: [{ type: "text", text: "Rain likely today." }], structuredContent };
      },
    );
    return server;
  });
  return { handler, calls };
}

describe("REST API", () => {
  let base: string;
  let services: Services;
  let close: () => Promise<void>;
  const mcp = fakeMcpServer();

  beforeAll(async () => {
    const config = testConfig();
    const web = new McpWebSearchClient("http://mcp.test/mcp", {
      timeoutMs: 2000,
      numResults: 3,
      fetch: (url, init) => mcp.handler.fetch(new Request(url, init)),
    });
    services = await createServices(config, { web });
    const server = createApp(services).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = async () => {
      await services.close();
      await new Promise((r) => server.close(r));
      await mcp.handler.close();
    };
  });

  afterAll(() => close());

  it("GET /api/health reports models, MCP tools and the index", async () => {
    const body = await json(await fetch(`${base}/api/health`));
    expect(body).toMatchObject({
      status: "ok",
      llm: { provider: "offline" },
      webSearch: { connected: true, tools: ["web_search"] },
      voice: { serverTranscription: false },
    });
  });

  it("uploads documents (including non-ASCII file names) and lists them", async () => {
    const form = new FormData();
    form.append("files", new Blob(["# 员工手册\n\nNew employees get 18 days of PTO per year."]), "员工手册.md");
    form.append("files", new Blob(["Hotels are capped at $250 per night."]), "travel.txt");
    const res = await fetch(`${base}/api/documents`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { documents } = await json(res);
    expect(documents.map((d: { name: string }) => d.name)).toEqual(["员工手册.md", "travel.txt"]);

    const list = await json(await fetch(`${base}/api/documents`));
    expect(list.documents).toHaveLength(2);
    expect(list.chunks).toBeGreaterThanOrEqual(2);
  });

  it("rejects unsupported uploads with 415", async () => {
    const form = new FormData();
    form.append("files", new Blob(["\x89PNG"]), "photo.png");
    expect((await fetch(`${base}/api/documents`, { method: "POST", body: form })).status).toBe(415);
  });

  it("POST /api/chat returns a cited JSON answer", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How many PTO days do new employees get?" }),
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.route).toBe("docs");
    expect(body.answer).toContain("18 days");
    expect(body.documents[0].documentName).toBe("员工手册.md");
  });

  it("POST /api/chat/stream streams SSE events and calls the MCP tool for fresh questions", async () => {
    const res = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What's the weather forecast in Seattle today?", mode: "auto" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    const names = events.map((e) => e.event);
    expect(names).toContain("meta");
    expect(names.at(-1)).toBe("done");

    const meta = events.find((e) => e.event === "meta")!.data;
    expect(meta.route).toBe("web");
    expect(meta.web[0]).toMatchObject({ id: "W1", title: "Seattle weather" });
    expect(mcp.calls.at(-1)).toMatch(/Seattle today\? 2026|Seattle today\? \d{4}/);

    const answer = events.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    expect(answer).toContain("[W1]");
  });

  it("validates the request body", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "", mode: "everything" }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).details.length).toBe(2);
  });

  it("reports that server-side transcription needs an API key in offline mode", async () => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(10)], { type: "audio/webm" }), "clip.webm");
    expect((await fetch(`${base}/api/voice/transcribe`, { method: "POST", body: form })).status).toBe(503);
  });

  it("DELETE /api/documents/:id removes a document", async () => {
    const { documents } = await json(await fetch(`${base}/api/documents`));
    const res = await fetch(`${base}/api/documents/${documents[0].id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await fetch(`${base}/api/documents/${documents[0].id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("ingests the bundled samples", async () => {
    const res = await fetch(`${base}/api/documents/samples`, { method: "POST" });
    const { documents } = await json(res);
    expect(documents.map((d: { name: string }) => d.name)).toEqual([
      "mcp-specification-2026-07-28.md",
      "northwind-employee-handbook.pdf",
      "northwind-security-policy.docx",
      "pep-0008-style-guide.rst",
    ]);
  });
});
