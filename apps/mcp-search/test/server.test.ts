import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockSearchProvider } from "../src/search/mock.js";
import { SearchService } from "../src/search/service.js";
import { createMcpServer } from "../src/server.js";

// Drives the real MCP handler in-process through a real MCP client (no sockets).
describe("MCP server", () => {
  let client: Client;
  let handler: ReturnType<typeof createMcpHandler>;

  beforeEach(async () => {
    const search = new SearchService(new MockSearchProvider());
    handler = createMcpHandler(() => createMcpServer(search));
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await handler.close();
  });

  it("lists the web_search tool with its schema and annotations", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "web_search");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect((tool?.inputSchema as { required?: string[] }).required).toEqual(["query"]);
    expect(tool?.outputSchema).toBeDefined();
  });

  it("returns structured results and a text rendering", async () => {
    const result = await client.callTool({ name: "web_search", arguments: { query: "mcp spec", num_results: 2 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { provider: string; results: unknown[]; cached: boolean };
    expect(data.provider).toBe("mock");
    expect(data.results).toHaveLength(2);
    expect(data.cached).toBe(false);
    const text = result.content?.[0];
    expect(text?.type === "text" && text.text).toContain('Web results for "mcp spec"');
  });

  it("rejects invalid arguments as a tool error", async () => {
    const result = await client.callTool({ name: "web_search", arguments: { query: "" } });
    expect(result.isError).toBe(true);
  });
});
