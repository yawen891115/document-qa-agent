import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The repo keeps a single .env at its root (two levels above apps/mcp-search/{src,dist}).
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export type SearchProviderName = "serpapi" | "mock";

export interface McpSearchConfig {
  transport: "http" | "stdio";
  publicLiveDemo?: boolean;
  host: string;
  port: number;
  /** Host headers accepted by the HTTP endpoint (DNS-rebinding protection). */
  allowedHosts?: string[];
  provider: SearchProviderName;
  serpApiKey?: string;
  serpApiTimeoutMs: number;
  serpApiGl: string;
  serpApiHl: string;
  cacheTtlMs: number;
  cacheMaxEntries: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(argv = process.argv, env = process.env): McpSearchConfig {
  const publicLiveDemo = env.PUBLIC_LIVE_DEMO === "true" || env.PUBLIC_LIVE_DEMO === "1";
  const serpApiKey = env.SERPAPI_API_KEY?.trim() || undefined;
  const requested = env.SEARCH_PROVIDER?.trim().toLowerCase();
  const provider: SearchProviderName =
    publicLiveDemo ? "serpapi" : requested === "mock" || requested === "serpapi" ? requested : serpApiKey ? "serpapi" : "mock";
  if (provider === "serpapi" && !serpApiKey) {
    throw new Error("SEARCH_PROVIDER=serpapi but SERPAPI_API_KEY is not set");
  }

  const allowedHosts = env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);

  return {
    publicLiveDemo,
    transport: publicLiveDemo ? "http" : argv.includes("--stdio") || env.MCP_TRANSPORT === "stdio" ? "stdio" : "http",
    host: publicLiveDemo ? "127.0.0.1" : env.MCP_HOST?.trim() || "127.0.0.1",
    port: publicLiveDemo ? 8787 : int(env.MCP_PORT, 8787),
    allowedHosts: publicLiveDemo ? ["127.0.0.1"] : allowedHosts?.length ? allowedHosts : undefined,
    provider,
    serpApiKey,
    serpApiTimeoutMs: publicLiveDemo ? 4500 : int(env.SERPAPI_TIMEOUT_MS, 5000),
    serpApiGl: env.SERPAPI_GL?.trim() || "us",
    serpApiHl: env.SERPAPI_HL?.trim() || "en",
    cacheTtlMs: publicLiveDemo ? 300_000 : int(env.SEARCH_CACHE_TTL_SECONDS, 600) * 1000,
    cacheMaxEntries: publicLiveDemo ? 128 : int(env.SEARCH_CACHE_MAX_ENTRIES, 500),
  };
}
