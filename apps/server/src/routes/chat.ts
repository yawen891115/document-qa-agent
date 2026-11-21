import { Router, type Response } from "express";
import * as z from "zod";
import type { Services } from "../services.js";
import { openSse, sendSse } from "../utils/sse.js";

export const ChatRequestSchema = z.object({
  question: z.string().trim().min(1, "question is required").max(2000),
  mode: z.enum(["auto", "docs", "web", "hybrid"]).default("auto"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(50)
    .default([]),
});

const DemoChatRequestSchema = ChatRequestSchema.extend({
  question: z.string().trim().min(1, "question is required").max(512),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(6).default([]),
});

/** Aborts the pipeline (and the OpenAI request) if the client disconnects mid-answer. */
function abortOnDisconnect(res: Response, timeout?: number): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(new Error("client disconnected"));
  });
  return timeout ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) : controller.signal;
}

export function chatRouter(s: Services): Router {
  const router = Router();
  const schema = s.config.publicDemo ? DemoChatRequestSchema : ChatRequestSchema;
  const live = s.config.publicLiveDemo;
  if (s.config.publicDemo) {
    // Shared, bounded work per process. Do not trust caller-controlled forwarding headers.
    let windowStart = Date.now();
    let started = 0;
    let active = 0;
    let utcDay = -1;
    let today = 0;
    router.use((req, res, next) => {
      if (req.method !== "POST") { next(); return; }
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; started = 0; }
      const day = Math.floor(now / 86_400_000);
      if (day !== utcDay) { utcDay = day; today = 0; }
      if (live && today >= 30) {
        res.setHeader("Retry-After", String(Math.ceil(((day + 1) * 86_400_000 - now) / 1000)));
        res.status(429).json({ error: "The public demo reached today's request limit. Try again tomorrow (UTC)." });
        return;
      }
      if (started >= (live ? 5 : 60) || active >= (live ? 2 : 4)) {
        res.setHeader("Retry-After", started >= (live ? 5 : 60) ? String(Math.ceil((60_000 - (now - windowStart)) / 1000)) : "2");
        res.status(429).json({ error: "The public preview is busy. Try again shortly." });
        return;
      }
      started++;
      today++;
      active++;
      const release = () => { active--; };
      res.once("close", release);
      res.setHeader("Cache-Control", "no-store");
      next();
    });
  }

  const selectedMode = (mode: "auto" | "docs" | "web" | "hybrid") =>
    s.config.publicDemo && !live ? "auto" : mode;

  /** One-shot JSON answer. */
  router.post("/", async (req, res) => {
    const body = schema.parse(req.body);
    const signal = abortOnDisconnect(res, live ? 25_000 : undefined);
    try {
      const result = await s.pipeline.ask(body.question, { ...body, mode: selectedMode(body.mode), signal });
      res.json(result);
    } catch (error) {
      if (!live || !signal.aborted) throw error;
      if (!res.destroyed) res.status(504).json({ error: "The request timed out. Please try again." });
    }
  });

  /** Streaming answer over SSE: status* -> meta -> token* -> done | error. */
  router.post("/stream", async (req, res) => {
    const body = schema.parse(req.body);
    const signal = abortOnDisconnect(res, live ? 25_000 : undefined);
    openSse(res, s.config.publicDemo);
    for await (const event of s.pipeline.stream(body.question, { ...body, mode: selectedMode(body.mode), signal })) {
      if (signal.aborted) break;
      sendSse(res, event.type, event);
    }
    if (live && signal.aborted && !res.destroyed) {
      sendSse(res, "error", { type: "error", message: "The request timed out. Please try again." });
    }
    res.end();
  });

  return router;
}
