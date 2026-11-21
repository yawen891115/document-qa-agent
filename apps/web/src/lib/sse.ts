export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser. Feed it decoded text as it arrives;
 * it calls `onMessage` for every complete event. (EventSource only supports
 * GET, and the chat endpoint is a POST, so the stream is parsed by hand.)
 */
export function createSseParser(onMessage: (message: SseMessage) => void) {
  let buffer = "";

  return {
    push(text: string): void {
      buffer += text.replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue; // comments / keep-alives
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length > 0) onMessage({ event, data: data.join("\n") });
      }
    },
  };
}
