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

/** Aborts the pipeline (and the OpenAI request) if the client disconnects mid-answer. */
function abortOnDisconnect(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(new Error("client disconnected"));
  });
  return controller.signal;
}

export function chatRouter(s: Services): Router {
  const router = Router();

  /** One-shot JSON answer. */
  router.post("/", async (req, res) => {
    const body = ChatRequestSchema.parse(req.body);
    const result = await s.pipeline.ask(body.question, { ...body, signal: abortOnDisconnect(res) });
    res.json(result);
  });

  /** Streaming answer over SSE: status* -> meta -> token* -> done | error. */
  router.post("/stream", async (req, res) => {
    const body = ChatRequestSchema.parse(req.body);
    const signal = abortOnDisconnect(res);
    openSse(res);
    for await (const event of s.pipeline.stream(body.question, { ...body, signal })) {
      if (signal.aborted) break;
      sendSse(res, event.type, event);
    }
    res.end();
  });

  return router;
}
