import { describe, expect, it } from "vitest";
import { createSseParser, type SseMessage } from "../src/lib/sse";

describe("createSseParser", () => {
  it("parses events split across arbitrary chunks", () => {
    const got: SseMessage[] = [];
    const parser = createSseParser((m) => got.push(m));
    const stream = 'event: token\ndata: {"text":"Hel"}\n\nevent: token\ndata: {"text":"lo"}\n\nevent: done\ndata: {}\n\n';
    for (let i = 0; i < stream.length; i += 7) parser.push(stream.slice(i, i + 7));
    expect(got).toEqual([
      { event: "token", data: '{"text":"Hel"}' },
      { event: "token", data: '{"text":"lo"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("handles CRLF, comments, default event names and multi-line data", () => {
    const got: SseMessage[] = [];
    const parser = createSseParser((m) => got.push(m));
    parser.push(": keep-alive\r\n\r\ndata: line one\r\ndata: line two\r\n\r\n");
    expect(got).toEqual([{ event: "message", data: "line one\nline two" }]);
  });

  it("waits for the blank line before emitting", () => {
    const got: SseMessage[] = [];
    const parser = createSseParser((m) => got.push(m));
    parser.push("event: meta\ndata: {}\n");
    expect(got).toHaveLength(0);
    parser.push("\n");
    expect(got).toHaveLength(1);
  });
});
