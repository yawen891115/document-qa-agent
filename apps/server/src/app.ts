import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import * as z from "zod";
import { log } from "./logger.js";
import { UnsupportedFileError } from "./rag/loaders.js";
import { chatRouter } from "./routes/chat.js";
import { documentsRouter } from "./routes/documents.js";
import { voiceRouter } from "./routes/voice.js";
import type { Services } from "./services.js";
import type { HealthResponse } from "./types.js";

export function createApp(s: Services): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (s.config.publicDemo) {
    app.use((_req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "microphone=(), camera=(), geolocation=()");
      res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      next();
    });
  } else app.use(cors({ origin: s.config.corsOrigin }));
  app.use(express.json({ limit: s.config.publicDemo ? "32kb" : "1mb", inflate: !s.config.publicDemo }));

  app.use((req, res, next) => {
    const started = performance.now();
    res.on("finish", () => {
      if (!s.config.publicDemo && req.path !== "/api/health") {
        log.debug(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
      }
    });
    next();
  });

  // Probe the actual local MCP transport, not providers. Reuse one shared probe
  // and cache its result briefly so public health polling cannot fan out.
  let mcpProbe: Promise<boolean> | undefined;
  let mcpProbeAfter = 0;
  const probeMcp = () => {
    if (!mcpProbe || Date.now() >= mcpProbeAfter) {
      mcpProbeAfter = Infinity;
      mcpProbe = s.web.status().then((status) => status.connected && status.tools.includes("web_search"))
        .catch(() => false).finally(() => { mcpProbeAfter = Date.now() + 15_000; });
    }
    return mcpProbe;
  };
  app.get("/api/health", async (_req, res) => {
    if (s.config.publicDemo) res.setHeader("Cache-Control", "no-store");
    const body: HealthResponse = {
      status: "ok",
      publicDemo: s.config.publicDemo,
      publicLiveDemo: s.config.publicLiveDemo,
      llm: {
        provider: s.models.provider,
        model: s.models.chatModelName,
        embeddingModel: s.models.embeddingModelName,
      },
      webSearch: s.config.publicDemo ? {
        enabled: s.config.publicLiveDemo,
        connected: s.config.publicLiveDemo && await probeMcp(),
        url: "", tools: [],
      } : await s.web.status(),
      voice: { serverTranscription: !s.config.publicDemo && Boolean(s.models.openai) },
      documents: s.kb.list().length,
      chunks: s.kb.chunkCount,
    };
    res.json(body);
  });
  app.use("/api/documents", documentsRouter(s));
  app.use("/api/chat", chatRouter(s));
  if (!s.config.publicDemo) app.use("/api/voice", voiceRouter(s));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // In production the API also serves the built React app (single port, no CORS).
  const indexHtml = join(s.config.paths.webDist, "index.html");
  if (s.config.serveWeb && existsSync(indexHtml)) {
    app.use(express.static(s.config.paths.webDist, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => (req.method === "GET" ? res.sendFile(indexHtml) : next()));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request", details: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    } else if (err instanceof multer.MulterError) {
      res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.message });
    } else if (err instanceof UnsupportedFileError) {
      res.status(415).json({ error: err.message });
    } else if ((err as { type?: string } | null)?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body too large" });
    } else if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Malformed JSON body" });
    } else if ((err as { type?: string } | null)?.type === "encoding.unsupported") {
      res.status(415).json({ error: "Unsupported request encoding" });
    } else {
      log.error("Unhandled error", s.config.publicDemo ? undefined : { error: err instanceof Error ? err.stack : String(err) });
      res.status(500).json({ error: !s.config.publicDemo && err instanceof Error ? err.message : "Internal server error" });
    }
  };
  app.use(onError);

  return app;
}
