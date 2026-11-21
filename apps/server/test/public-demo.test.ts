import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { FakeWebSearch, json, readSse, testConfig } from "./helpers.js";

const fakeWeb = new FakeWebSearch();
let base: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  const services = await createServices(testConfig({
    PUBLIC_DEMO: "true",
    WEB_SEARCH_ENABLED: "true",
    OPENAI_API_KEY: "unused-test-placeholder",
    LLM_PROVIDER: "openai",
  }), { web: fakeWeb });
  const server = createApp(services).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    await services.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
});

afterAll(async () => { await stop?.(); });

function chat(question: string, stream = false) {
  return fetch(`${base}/api/chat${stream ? "/stream" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, mode: "web" }),
  });
}

it("forces offline answers and exposes only the fictional, read-only corpus", async () => {
  const health = await fetch(`${base}/api/health`);
  expect(health.headers.get("permissions-policy")).toContain("microphone=()");
  expect(await json(health)).toMatchObject({
    status: "ok", publicDemo: true, documents: 2,
    llm: { provider: "offline" },
    webSearch: { enabled: false, connected: false, url: "", tools: [] },
    voice: { serverTranscription: false },
  });

  const { documents } = await json(await fetch(`${base}/api/documents`));
  expect(documents.map((d: { name: string }) => d.name)).toEqual([
    "northwind-employee-handbook.pdf", "northwind-security-policy.docx",
  ]);
  for (const [method, path] of [
    ["POST", "/api/documents"], ["POST", "/api/documents/samples"],
    ["DELETE", `/api/documents/${documents[0].id}`], ["POST", "/api/voice/transcribe"],
  ]) {
    expect((await fetch(`${base}${path}`, { method })).status).toBe(404);
  }

  const response = await chat("How many characters long must a password be?");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await json(response);
  expect(result).toMatchObject({ route: "docs", model: "offline-extractive", web: [] });
  expect(result.answer).toContain("14 characters");
  expect(result.documents.some((d: { documentName: string }) => d.documentName === "northwind-security-policy.docx")).toBe(true);
  expect(fakeWeb.calls).toHaveLength(0);
});

it("bounds input and marks streamed answers as not cacheable", async () => {
  expect((await chat("x".repeat(513))).status).toBe(400);
  expect((await chat("x".repeat(33 * 1024))).status).toBe(413);
  const response = await chat("How many characters long must a password be?", true);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const events = await readSse(response);
  expect(events.at(-1)?.data.answer).toContain("14 characters");
});
