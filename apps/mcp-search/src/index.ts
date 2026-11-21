#!/usr/bin/env node
/**
 * Entry point of the MCP web-search server.
 *
 *   node dist/index.js           -> Streamable HTTP on http://127.0.0.1:8787/mcp (used by the backend)
 *   node dist/index.js --stdio   -> stdio (for Claude Desktop, MCP Inspector, other MCP hosts)
 *
 * All logs go to stderr: on stdio, stdout is reserved for protocol messages.
 */
import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createSearchService } from "./search/service.js";
import { createMcpServer, SERVER_INFO } from "./server.js";

const log = (msg: string) => console.error(`[mcp-search] ${msg}`);

const config = loadConfig();
const search = createSearchService(config);
const factory = () => createMcpServer(search);

if (config.provider === "mock") {
  log("SERPAPI_API_KEY not set - web_search returns MOCK results. Add the key to .env for live Google results.");
}

if (config.transport === "stdio") {
  serveStdio(factory);
  log(`${SERVER_INFO.name} ready on stdio (provider: ${config.provider})`);
} else {
  const handler = createMcpHandler(factory);
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
  const nodeHandler = toNodeHandler(handler);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: SERVER_INFO, provider: search.provider.name, cacheEntries: search.cacheSize });
  });
  app.all("/mcp", (req, res) => void nodeHandler(req, res, req.body));

  const httpServer: Server = app.listen(config.port, config.host, () => {
    log(`${SERVER_INFO.name} listening on http://${config.host}:${config.port}/mcp (provider: ${config.provider})`);
  });

  const shutdown = () => {
    log("shutting down");
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
