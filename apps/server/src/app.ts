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
  app.use(cors({ origin: s.config.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const started = performance.now();
    res.on("finish", () => {
      if (req.path !== "/api/health") {
        log.debug(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
      }
    });
    next();
  });

  app.get("/api/health", async (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      llm: {
        provider: s.models.provider,
        model: s.models.chatModelName,
        embeddingModel: s.models.embeddingModelName,
      },
      webSearch: await s.web.status(),
      voice: { serverTranscription: Boolean(s.models.openai) },
      documents: s.kb.list().length,
      chunks: s.kb.chunkCount,
    };
    res.json(body);
  });
  app.use("/api/documents", documentsRouter(s));
  app.use("/api/chat", chatRouter(s));
  app.use("/api/voice", voiceRouter(s));
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
    } else if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Malformed JSON body" });
    } else {
      log.error("Unhandled error", { error: err instanceof Error ? err.stack : String(err) });
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  };
  app.use(onError);

  return app;
}
