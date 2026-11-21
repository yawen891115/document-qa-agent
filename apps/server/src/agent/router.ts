import type { ChatTurn, Mode, Route } from "../types.js";

/** Signals that the answer depends on information newer than any document. */
const FRESHNESS =
  /\b(today|tonight|yesterday|tomorrow|right now|current(?:ly)?|latest|newest|recent(?:ly)?|this (?:week|month|year)|news|headlines?|breaking|stock|share price|weather|forecast|scores?)\b/i;

/**
 * Signals that the question compares the documents with the outside world.
 * A bare "compare"/"vs" is not enough: it is just as often a comparison inside
 * the documents ("compare PTO for new vs. senior staff", "compare a variable to None").
 */
const EXTERNAL_COMPARISON =
  /\b(average|benchmark|industry|national|nationwide|typical|market rate|competitors?|other companies|other employers)\b/i;

export interface QuestionIntent {
  needsFreshInfo: boolean;
  externalComparison: boolean;
}

export function analyzeQuestion(question: string): QuestionIntent {
  return { needsFreshInfo: FRESHNESS.test(question), externalComparison: EXTERNAL_COMPARISON.test(question) };
}

export const wantsWeb = (intent: QuestionIntent) => intent.needsFreshInfo || intent.externalComparison;

export interface RouteInput {
  mode: Mode;
  intent: QuestionIntent;
  /** Best cosine similarity among retrieved chunks (undefined if retrieval was skipped). */
  topScore?: number;
  minScore: number;
  hasDocuments: boolean;
  webAvailable: boolean;
}

/**
 * Rule-based router: decides which sources answer the question. It runs in
 * microseconds, so routing adds no latency (an LLM router would add a round trip).
 */
export function decideRoute(input: RouteInput): { route: Route; reason: string } {
  const { mode, intent, topScore, minScore, hasDocuments, webAvailable } = input;
  const docsRelevant = hasDocuments && topScore !== undefined && topScore >= minScore;
  const scoreText = topScore === undefined ? "n/a" : topScore.toFixed(2);

  if (mode === "docs") return { route: "docs", reason: "Documents only (selected by user)" };
  if (!webAvailable) {
    return { route: "docs", reason: mode === "auto" ? "Web search is unavailable" : "Web search is unavailable; using documents" };
  }
  if (mode === "web") return { route: "web", reason: "Web only (selected by user)" };
  if (mode === "hybrid") return { route: "hybrid", reason: "Documents + web (selected by user)" };

  // mode === "auto"
  if (docsRelevant && wantsWeb(intent)) {
    const why = intent.needsFreshInfo ? "needs current information" : "compares with outside data";
    return { route: "hybrid", reason: `Relevant documents (score ${scoreText}) and the question ${why}` };
  }
  if (docsRelevant) return { route: "docs", reason: `Relevant documents found (score ${scoreText})` };
  if (!hasDocuments) return { route: "web", reason: "No documents uploaded yet" };
  return { route: "web", reason: `No relevant documents (best score ${scoreText} < ${minScore})` };
}

/**
 * Short follow-ups ("and for part-time staff?") retrieve poorly on their own,
 * so they are expanded with the previous user question. No extra LLM call.
 */
export function buildRetrievalQuery(question: string, history: ChatTurn[]): string {
  const words = question.trim().split(/\s+/).length;
  const followUp = /^(and|what about|how about|also|then|but|same for|what if|or)\b/i.test(question.trim());
  const previous = [...history].reverse().find((t) => t.role === "user")?.content;
  return previous && (followUp || words <= 4) ? `${previous}\n${question}` : question;
}
