/** Turns an answer into text that sounds right when read aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\s*\[(?:D|W)\d+\](?:\s*\[(?:D|W)\d+\])*/g, "") // citation tags
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // markdown links -> link text
    .replace(/https?:\/\/\S+/g, "") // bare URLs
    .replace(/[*_`#>]+/g, "") // markdown emphasis, headings, quotes, code
    .replace(/^\s*[-•]\s+/gm, "") // bullet markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collects streamed tokens and releases whole sentences, so text-to-speech can
 * start on the first sentence while the rest of the answer is still arriving.
 */
export class SentenceBuffer {
  private buffer = "";

  constructor(private readonly minLength = 40) {}

  /** Adds streamed text; returns the sentences that are now complete. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    // A sentence ends at . ! ? or a line break, followed by whitespace. Skip decimals ("1.5")
    // and abbreviations like "e.g." by requiring the next character to start a new sentence.
    const boundary = /([.!?])\s+(?=[A-Z0-9"“(\[])|\n+/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const end = match.index + (match[1] ? 1 : 0);
      const sentence = this.buffer.slice(start, end).trim();
      if (sentence.length >= this.minLength || match[0].includes("\n")) {
        if (sentence) out.push(sentence);
        start = boundary.lastIndex;
      }
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Returns whatever is left at the end of the answer. */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest;
  }
}
