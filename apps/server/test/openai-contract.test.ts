import { describe, expect, it } from "vitest";
import { createModels } from "../src/llm/models.js";
import { createServices } from "../src/services.js";
import { FakeWebSearch, testConfig } from "./helpers.js";

/**
 * Contract test for the real OpenAI code path, without network access:
 * a fake `fetch` stands in for api.openai.com, records each request and replies
 * in OpenAI's wire format (base64 embeddings, SSE chat-completion chunks).
 */
function fakeOpenAI() {
  const requests: { url: string; body: any }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, body });

    if (url.endsWith("/embeddings")) {
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((text, index) => {
        const v = new Float32Array(8).map((_, i) => ((text.length * (i + 1)) % 7) + 1);
        const embedding = body.encoding_format === "base64" ? Buffer.from(v.buffer).toString("base64") : Array.from(v);
        return { object: "embedding", index, embedding };
      });
      return Response.json({ object: "list", data, model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } });
    }

    if (url.endsWith("/chat/completions")) {
      const chunk = (delta: object, extra: object = {}) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
      const sse =
        chunk({ role: "assistant", content: "New hires get " }) +
        chunk({ content: "18 days of PTO [D1]." }) +
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 12, total_tokens: 432 } })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { requests, fetchImpl };
}

describe("OpenAI integration (GPT-5 request shape)", () => {
  it("sends GPT-5 low-latency parameters and streams the answer", async () => {
    const openai = fakeOpenAI();
    const config = testConfig({ OPENAI_API_KEY: "sk-test" });
    const models = createModels(config.llm, { fetch: openai.fetchImpl as typeof fetch });
    expect(models.provider).toBe("openai");

    const services = await createServices(config, { models, web: new FakeWebSearch(), persist: false });
    await services.kb.ingest(Buffer.from("New employees receive 18 days of PTO per year."), "handbook.txt");
    const result = await services.pipeline.ask("How many PTO days do new employees get?");

    // Embeddings: documents at ingest time, then the query.
    const embeddingCalls = openai.requests.filter((r) => r.url.endsWith("/embeddings"));
    expect(embeddingCalls[0]!.body.model).toBe("text-embedding-3-small");
    expect(embeddingCalls[0]!.body.input[0]).toContain("handbook.txt"); // contextual chunk header

    // Chat completion: GPT-5 with minimal reasoning, low verbosity, streaming, token cap.
    const chat = openai.requests.find((r) => r.url.endsWith("/chat/completions"))!.body;
    expect(chat).toMatchObject({
      model: "gpt-5",
      stream: true,
      reasoning_effort: "minimal",
      verbosity: "low",
      max_completion_tokens: 1000,
    });
    expect(chat.temperature).toBeUndefined(); // GPT-5 rejects non-default temperature
    expect(chat.messages[0].role).toBe("developer"); // system prompt becomes a developer message for reasoning models
    expect(chat.messages.at(-1).content).toContain("[D1] handbook.txt");

    expect(result.answer).toBe("New hires get 18 days of PTO [D1].");
    expect(result.usage).toEqual({ inputTokens: 420, outputTokens: 12, totalTokens: 432 });
    expect(result.model).toBe("gpt-5");
  });

  it("omits GPT-5-only parameters for other models", async () => {
    const openai = fakeOpenAI();
    const config = testConfig({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4.1-mini" });
    const models = createModels(config.llm, { fetch: openai.fetchImpl as typeof fetch });
    const services = await createServices(config, { models, web: new FakeWebSearch(), persist: false });
    await services.kb.ingest(Buffer.from("New employees receive 18 days of PTO per year."), "handbook.txt");
    await services.pipeline.ask("How many PTO days?", { mode: "docs" });

    const chat = openai.requests.find((r) => r.url.endsWith("/chat/completions"))!.body;
    expect(chat.model).toBe("gpt-4.1-mini");
    expect(chat.reasoning_effort).toBeUndefined();
    expect(chat.verbosity).toBeUndefined();
    expect(chat.max_tokens).toBe(1000);
  });
});
