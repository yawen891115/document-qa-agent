// API types are defined once, in the server, and imported here as types only
// (erased at build time, so no server code reaches the browser bundle).
export type {
  ChatTurn,
  DocSource,
  DocumentKind,
  DocumentRecord,
  HealthResponse,
  Mode,
  PipelineEvent,
  Route,
  Timings,
  WebSource,
} from "../../server/src/types.js";

import type { DocSource, Mode, Route, Timings, WebSource } from "../../server/src/types.js";

/** One question and its answer, as shown in the conversation. */
export interface Turn {
  id: string;
  question: string;
  mode: Mode;
  status: "thinking" | "streaming" | "done" | "error" | "stopped";
  /** Progress message while thinking ("Searching your documents…"). */
  stage?: string;
  answer: string;
  route?: Route;
  reason?: string;
  documents: DocSource[];
  web: WebSource[];
  webError?: string;
  timings?: Timings;
  model?: string;
  error?: string;
}
