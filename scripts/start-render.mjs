import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { OPENAI_API_KEY, SERPAPI_API_KEY, ...common } = process.env;
if (!OPENAI_API_KEY?.trim() || !SERPAPI_API_KEY?.trim()) {
  console.error("Set both OPENAI_API_KEY and SERPAPI_API_KEY in the hosting dashboard.");
  process.exit(1);
}

const children = new Set();
let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 3500).unref();
}
function run(entry, env, name) {
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => {
    children.delete(child);
    if (!stopping) {
      console.error(`${name} stopped unexpectedly`);
      shutdown(1);
    }
  });
  child.once("error", () => {
    children.delete(child);
    console.error(`Could not launch ${name}`);
    shutdown(1);
  });
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
const hosted = { ...common, PUBLIC_DEMO: "false", PUBLIC_LIVE_DEMO: "true" };
run("apps/mcp-search/dist/index.js", { ...hosted, SERPAPI_API_KEY }, "MCP search service");

try {
  const deadline = Date.now() + 12_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    const response = await fetch("http://127.0.0.1:8787/health", {
      signal: AbortSignal.timeout(1000), redirect: "error",
    }).catch(() => null);
    const status = await response?.json().catch(() => null);
    if (response?.ok && status?.status === "ok" && status.provider === "serpapi") {
      ready = true;
      break;
    }
    await delay(120);
  }
  if (!stopping && !ready) {
    console.error("Local MCP search did not become ready");
    shutdown(1);
  }
  if (!stopping) run("apps/server/dist/index.js", {
    ...hosted, OPENAI_API_KEY, HOST: common.HOST ?? "0.0.0.0",
  }, "API service");
} catch {
  console.error("Public demo startup failed");
  shutdown(1);
}
