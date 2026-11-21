import { useEffect, useRef, useSyncExternalStore, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import type { VoiceEngine, VoiceState } from "../hooks/useVoiceInput";
import type { Mode } from "../types";
import { MicOrb } from "./MicOrb";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "The agent decides between your documents and the web" },
  { value: "docs", label: "Documents", hint: "Answer only from your documents" },
  { value: "web", label: "Web", hint: "Answer only from web search" },
  { value: "hybrid", label: "Both", hint: "Always use your documents and web search" },
];

interface Props {
  draft: string;
  onDraftChange: (text: string) => void;
  onSubmit: (text: string) => void;
  busy: boolean;
  onStop: () => void;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  voice: { engine: VoiceEngine; state: VoiceState; level: RefObject<number>; toggle: () => void };
  readAloud: { supported: boolean; enabled: boolean; speaking: boolean; onToggle: (on: boolean) => void; onStop: () => void };
}

const narrowQuery = typeof window !== "undefined" ? window.matchMedia("(max-width: 520px)") : undefined;
const subscribeNarrow = (cb: () => void) => {
  narrowQuery?.addEventListener("change", cb);
  return () => narrowQuery?.removeEventListener("change", cb);
};

export function Composer({ draft, onDraftChange, onSubmit, busy, onStop, mode, onModeChange, voice, readAloud }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea with its content, up to a limit.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!busy && draft.trim()) onSubmit(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  };

  const narrow = useSyncExternalStore(subscribeNarrow, () => narrowQuery?.matches ?? false);
  const listening = voice.state === "listening";
  const placeholder = listening
    ? narrow
      ? "Listening…"
      : "Listening… pause when you're done"
    : voice.state === "transcribing"
      ? "Transcribing…"
      : narrow
        ? "Ask a question"
        : "Ask a question about your documents";

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-row">
        <MicOrb state={voice.state} level={voice.level} onClick={voice.toggle} disabled={voice.engine === "none" || busy} />
        <label className="visually-hidden" htmlFor="question">
          Question
        </label>
        <textarea
          id="question"
          ref={input}
          className={`composer-input${listening ? " is-listening" : ""}`}
          rows={1}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          readOnly={listening}
        />
        {busy ? (
          <button type="button" className="button button--quiet" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button button--primary" disabled={!draft.trim()}>
            Ask
          </button>
        )}
      </div>

      <div className="composer-options">
        <div className="modes" role="radiogroup" aria-label="Where answers come from">
          {MODES.map((m) => (
            <label key={m.value} title={m.hint}>
              <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => onModeChange(m.value)} />
              <span>{m.label}</span>
            </label>
          ))}
        </div>

        {readAloud.supported && (
          <div className="read-aloud">
            <label className="switch">
              <input type="checkbox" checked={readAloud.enabled} onChange={(e) => readAloud.onToggle(e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
              Read answers aloud
            </label>
            {readAloud.speaking && (
              <button type="button" className="link-button" onClick={readAloud.onStop}>
                Stop reading
              </button>
            )}
          </div>
        )}

        <p className="voice-note">
          {voice.engine === "browser" && "Voice is transcribed in your browser."}
          {voice.engine === "server" && "Voice is transcribed on the server."}
          {voice.engine === "none" && "This browser doesn't support voice input."}
        </p>
      </div>
    </form>
  );
}
