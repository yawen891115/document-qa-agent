import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import type { DocSource, WebSource } from "../types.js";

export const QUESTION_MARKER = "QUESTION\n";

const SYSTEM_PROMPT = `You are DocQA, an assistant that answers questions from the user's documents and from web search results.

Rules:
- Use only the CONTEXT in the user's message. If it does not contain the answer, say that you could not find it. Do not guess.
- Cite every fact with the tag of its source, for example [D1] for a document excerpt or [W2] for a web result. Use only tags that appear in the CONTEXT.
- Company-specific facts come from the documents; current or public facts come from the web. If they disagree, say so.
- Open with a direct answer in one or two sentences, then add details only if they help. Stay under 150 words unless the user asks for more.
- Answers may be read aloud: write plain sentences or short bullet points, no tables, no code unless asked.

Today's date is {today}.`;

export const qaPrompt = ChatPromptTemplate.fromMessages([
  ["system", SYSTEM_PROMPT],
  new MessagesPlaceholder("history"),
  ["human", `CONTEXT\n{context}\n\n${QUESTION_MARKER}{question}`],
]);

/**
 * Renders retrieved chunks and web results into the CONTEXT block.
 * Every source starts with a "[TAG] header" line so the model can cite it.
 */
export function formatContext(docs: DocSource[], web: WebSource[]): string {
  const parts: string[] = [];
  if (docs.length) {
    parts.push("Document excerpts:");
    for (const d of docs) {
      const where = [d.documentName, d.page ? `page ${d.page}` : undefined, d.section ? `section "${d.section}"` : undefined]
        .filter(Boolean)
        .join(", ");
      parts.push(`[${d.id}] ${where}\n${d.text.trim()}`);
    }
  }
  if (web.length) {
    parts.push("Web search results:");
    for (const w of web) {
      const meta = [w.source, w.date].filter(Boolean).join(", ");
      parts.push(`[${w.id}] ${w.title}${meta ? ` (${meta})` : ""}\n${w.url}\n${w.snippet}`);
    }
  }
  return parts.length ? parts.join("\n\n") : "(no relevant documents or web results were found)";
}

/** Inverse of formatContext, used by the offline extractive model. */
export function parseContextSources(prompt: string): { tag: string; text: string }[] {
  const context = prompt.split(QUESTION_MARKER)[0] ?? "";
  const out: { tag: string; text: string }[] = [];
  const re = /^\[([DW]\d+)\][^\n]*\n([\s\S]*?)(?=^\[[DW]\d+\]|^Web search results:|(?![\s\S]))/gm;
  for (const m of context.matchAll(re)) {
    const tag = m[1]!;
    // Web results carry the URL on their first line; drop it from the quotable text.
    const text = tag.startsWith("W") ? m[2]!.split("\n").slice(1).join(" ") : m[2]!;
    if (text.trim()) out.push({ tag, text: text.trim() });
  }
  return out;
}
