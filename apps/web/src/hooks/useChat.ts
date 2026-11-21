import { useCallback, useRef, useState } from "react";
import { streamChat } from "../lib/api";
import type { ChatTurn, Mode, PipelineEvent, Turn } from "../types";

interface Callbacks {
  onToken?: (text: string) => void;
  onDone?: (answer: string) => void;
}

const HISTORY_TURNS = 3; // previous Q&A pairs sent for follow-up questions

let nextId = 0;

function applyEvent(turn: Turn, event: PipelineEvent): Turn {
  switch (event.type) {
    case "status":
      return { ...turn, stage: event.message };
    case "meta":
      return { ...turn, route: event.route, reason: event.reason, documents: event.documents, web: event.web, webError: event.webError };
    case "token":
      return { ...turn, status: "streaming", stage: undefined, answer: turn.answer + event.text };
    case "done":
      return { ...turn, status: "done", answer: event.answer, timings: event.timings, model: event.model };
    case "error":
      return { ...turn, status: "error", error: event.message };
  }
}

export function useChat(callbacks: Callbacks = {}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const controllerRef = useRef<AbortController | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const ask = useCallback(async (question: string, mode: Mode) => {
    const text = question.trim();
    if (!text || controllerRef.current) return;

    const history: ChatTurn[] = turnsRef.current
      .filter((t) => t.status === "done")
      .slice(-HISTORY_TURNS)
      .flatMap((t) => [
        { role: "user" as const, content: t.question },
        { role: "assistant" as const, content: t.answer },
      ]);

    const id = `turn-${++nextId}`;
    const update = (fn: (t: Turn) => Turn) => setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
    setTurns((prev) => [...prev, { id, question: text, mode, status: "thinking", answer: "", documents: [], web: [] }]);

    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    try {
      await streamChat(
        { question: text, mode, history },
        (event) => {
          update((t) => applyEvent(t, event));
          if (event.type === "token") callbacksRef.current.onToken?.(event.text);
          if (event.type === "done") callbacksRef.current.onDone?.(event.answer);
        },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) update((t) => ({ ...t, status: t.answer ? "done" : "stopped", stage: undefined }));
      else update((t) => ({ ...t, status: "error", error: err instanceof Error ? err.message : String(err) }));
    } finally {
      controllerRef.current = null;
      setBusy(false);
    }
  }, []);

  const stop = useCallback(() => controllerRef.current?.abort(), []);
  const clear = useCallback(() => {
    controllerRef.current?.abort();
    setTurns([]);
  }, []);

  return { turns, busy, ask, stop, clear };
}
