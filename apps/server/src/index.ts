import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./logger.js";
import { createServices } from "./services.js";

const config = loadConfig();
setLogLevel(config.logLevel);

const services = await createServices(config);
const app = createApp(services);

const server = app.listen(config.port, config.host, () => {
  log.info(`API listening on http://${config.host}:${config.port}`);
});

// Connect to the MCP server up front so the first question does not pay for it.
void services.web.status().then((status) => {
  if (!status.enabled) return;
  if (status.connected) log.info("MCP web search ready", { tools: status.tools });
  else log.warn(`MCP web search not reachable at ${status.url} (will retry on demand)`, { error: status.error });
});

const shutdown = () => {
  log.info("Shutting down");
  server.close();
  void services.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
