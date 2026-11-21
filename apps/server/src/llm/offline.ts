/**
 * Offline stand-ins for OpenAI, used when OPENAI_API_KEY is not set (demo mode, tests, CI).
 *
 * - HashingEmbeddings: deterministic bag-of-words embeddings (feature hashing). Similarity
 *   reflects keyword overlap, which is enough to exercise retrieval end to end.
 * - ExtractiveChatModel: a LangChain chat model that "answers" by quoting the best-matching
 *   sentence of the top sources, with citations. It streams like a real model.
 *
 * Both implement the standard LangChain interfaces, so the RAG pipeline code is identical
 * in online and offline mode.
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import { SimpleChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { parseContextSources, QUESTION_MARKER } from "../rag/prompts.js";

const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "may me my no not of on or our should so than that the their them then there these they this to under up " +
    "us was we were what when where which who why will with would you your about after all also any each just " +
    "more most much must per same such very").split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ch|sh|ss|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class HashingEmbeddings extends Embeddings {
  readonly modelName: string;

  constructor(
    private readonly dims = 512,
    params: EmbeddingsParams = {},
  ) {
    super(params);
    this.modelName = `offline-hashing-${dims}`;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embed(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  private embed(text: string): number[] {
    const tokens = tokenize(text);
    const weights = new Map<string, number>();
    tokens.forEach((t, i) => {
      weights.set(t, (weights.get(t) ?? 0) + 1);
      if (i > 0) weights.set(`${tokens[i - 1]}_${t}`, (weights.get(`${tokens[i - 1]}_${t}`) ?? 0) + 0.5);
    });

    const v = new Array<number>(this.dims).fill(0);
    for (const [feature, count] of weights) {
      const h = fnv1a(feature);
      const sign = h & 0x80000000 ? -1 : 1; // signed hashing keeps collisions unbiased
      const idx = h % this.dims;
      v[idx] = v[idx]! + sign * (1 + Math.log(count));
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

export const OFFLINE_NOTE =
  "_Offline demo mode: extracted from the sources without an LLM. Set OPENAI_API_KEY to answer with GPT-5._";

/** Builds an extractive answer from the CONTEXT/QUESTION prompt produced by rag/prompts.ts. */
export function extractiveAnswer(prompt: string): string {
  const question = prompt.split(QUESTION_MARKER).at(-1)?.trim() ?? prompt;
  const sources = parseContextSources(prompt);
  if (sources.length === 0) {
    return `I couldn't find anything about that in your documents or in the web results.\n\n${OFFLINE_NOTE}`;
  }

  const qTokens = new Set(tokenize(question));
  const scored = sources
    .map((source, rank) => {
      const sentences = toPlainText(source.text)
        // Sentence ends, but not after abbreviations such as "Jr." or "e.g.".
        .split(/(?<!\b(?:Jr|Mr|Mrs|Ms|Dr|St|vs|e\.g|i\.e|U\.S))(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
        .filter((s) => s.length > 20 && s.length < 600);
      let best = { sentence: sentences[0] ?? "", score: 0 };
      for (const sentence of sentences) {
        const tokens = new Set(tokenize(sentence));
        const overlap = [...tokens].filter((t) => qTokens.has(t)).length;
        const score = overlap / Math.sqrt(tokens.size + 1);
        if (score > best.score) best = { sentence, score };
      }
      return { tag: source.tag, ...best, rank };
    })
    .filter((p) => p.sentence)
    .sort((a, b) => b.score - a.score || a.rank - b.rank);

  // One sentence from the best document and one from the best web result (hybrid answers),
  // or a second document sentence if it is nearly as relevant as the first.
  const bestDoc = scored.find((p) => p.tag.startsWith("D"));
  const bestWeb = scored.find((p) => p.tag.startsWith("W"));
  const first = bestDoc ?? bestWeb;
  if (!first) return `I couldn't find a clear answer in the sources.\n\n${OFFLINE_NOTE}`;
  const second =
    bestDoc && bestWeb
      ? bestWeb
      : scored.find(
          (p) => p !== first && p.sentence !== first.sentence && p.tag[0] === first.tag[0] && p.score >= first.score * 0.6,
        );

  const lines = [first, second].filter(Boolean).map((p) => `${p!.sentence.trim()} [${p!.tag}]`);
  return `${lines.join("\n\n")}\n\n${OFFLINE_NOTE}`;
}

/** Strips code blocks, headings and markdown syntax so quoted sentences read as prose. */
function toPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*(#{1,6}\s.*|\d{1,2}(?:\.\d{1,2})*\.?\s+[A-Z][^.!?\n]{2,60}|[=\-~^"'`#*+]{3,})\s*$/gm, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^_Page: .*_$/gm, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class ExtractiveChatModel extends SimpleChatModel {
  constructor(private readonly tokenDelayMs = 8) {
    super({});
  }

  _llmType(): string {
    return "offline-extractive";
  }

  async _call(messages: BaseMessage[]): Promise<string> {
    return extractiveAnswer(messages.at(-1)?.text ?? "");
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const answer = extractiveAnswer(messages.at(-1)?.text ?? "");
    for (const piece of answer.match(/\S+\s*/g) ?? []) {
      options.signal?.throwIfAborted();
      if (this.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
      yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) });
      await runManager?.handleLLMNewToken(piece);
    }
  }
}
