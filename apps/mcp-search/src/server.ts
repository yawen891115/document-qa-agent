import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { SearchService } from "./search/service.js";
import type { SearchResponse } from "./search/types.js";

export const SERVER_INFO = { name: "docqa-web-search", version: "1.0.0" } as const;

const resultItemSchema = z.object({
  position: z.number(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  source: z.string().optional(),
  date: z.string().optional(),
});

const searchResponseSchema = z.object({
  query: z.string(),
  provider: z.string(),
  answer: z.string().optional(),
  results: z.array(resultItemSchema),
  cached: z.boolean(),
  tookMs: z.number(),
});

/**
 * Builds the MCP server. In HTTP mode this factory runs once per request
 * (stateless MCP, spec 2026-07-28), so it must stay cheap: the SearchService
 * (and its cache) is created once and shared.
 */
export function createMcpServer(search: SearchService): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "web_search",
    {
      title: "Web search (Google via SerpAPI)",
      description:
        "Search the public web for fresh or general information that is not in the user's documents. " +
        "Returns ranked results (title, URL, snippet) and a direct answer when Google shows one.",
      inputSchema: z.object({
        query: z.string().min(1).max(400).describe("The search query"),
        num_results: z.number().int().min(1).max(10).default(5).describe("Number of results to return"),
        time_range: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("Only return results from this recent period"),
        location: z
          .string()
          .max(100)
          .optional()
          .describe('Where to search from, e.g. "Seattle, Washington, United States"'),
      }),
      outputSchema: searchResponseSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, num_results, time_range, location }, ctx): Promise<CallToolResult> => {
      try {
        const response = await search.search(query, {
          num: num_results,
          timeRange: time_range,
          location,
          signal: ctx.mcpReq.signal,
        });
        return {
          content: [{ type: "text", text: formatForModel(response) }],
          structuredContent: { ...response },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Web search failed: ${message}` }], isError: true };
      }
    },
  );

  return server;
}

/** Plain-text rendering of the results, for MCP clients that only read `content`. */
export function formatForModel(r: SearchResponse): string {
  const lines = [`Web results for "${r.query}" (${r.provider}${r.cached ? ", cached" : ""}):`];
  if (r.answer) lines.push(`Direct answer: ${r.answer}`);
  for (const item of r.results) {
    lines.push(`[${item.position}] ${item.title}${item.date ? ` (${item.date})` : ""}`, `    ${item.url}`);
    if (item.snippet) lines.push(`    ${item.snippet}`);
  }
  if (r.results.length === 0 && !r.answer) lines.push("No results.");
  return lines.join("\n");
}
