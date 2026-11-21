import type { ChatTurn, DocumentRecord, HealthResponse, Mode, PipelineEvent } from "../types";
import { createSseParser } from "./sse";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed with status ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const getHealth = () => request<HealthResponse>("/api/health");

export const listDocuments = () => request<{ documents: DocumentRecord[]; chunks: number }>("/api/documents");

export function uploadDocuments(files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return request<{ documents: (DocumentRecord & { duplicate: boolean })[] }>("/api/documents", { method: "POST", body: form });
}

export const loadSampleDocuments = () =>
  request<{ documents: DocumentRecord[] }>("/api/documents/samples", { method: "POST" });

export const deleteDocument = (id: string) => request<void>(`/api/documents/${id}`, { method: "DELETE" });

export async function transcribe(audio: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, audio.type.includes("mp4") ? "speech.mp4" : "speech.webm");
  const { text } = await request<{ text: string }>("/api/voice/transcribe", { method: "POST", body: form });
  return text;
}

/** POST /api/chat/stream and hand every server event to `onEvent` as it arrives. */
export async function streamChat(
  body: { question: string; mode: Mode; history: ChatTurn[] },
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
    throw new Error(err.details?.join(", ") ?? err.error ?? `Request failed with status ${res.status}`);
  }

  const parser = createSseParser(({ data }) => onEvent(JSON.parse(data) as PipelineEvent));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
  }
}
