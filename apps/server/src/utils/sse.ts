import type { Response } from "express";

/** Starts a Server-Sent Events response. POST + fetch() on the client, since EventSource is GET-only. */
export function openSse(res: Response): void {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering (nginx)
  });
  res.flushHeaders();
}

export function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
