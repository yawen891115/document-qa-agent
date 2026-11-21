import { LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import type { VoiceState } from "../hooks/useVoiceInput";

interface Props {
  state: VoiceState;
  level: RefObject<number>;
  disabled?: boolean;
  onClick: () => void;
}

const LABELS: Record<VoiceState, string> = {
  idle: "Ask by voice",
  listening: "Stop listening and send",
  transcribing: "Transcribing your question",
};

/** The voice button. While listening, its halo follows the microphone level. */
export function MicOrb({ state, level, disabled, onClick }: Props) {
  const halo = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (state !== "listening") return;
    let raf = 0;
    let smoothed = 0;
    const tick = () => {
      smoothed += ((level.current ?? 0) - smoothed) * 0.35;
      halo.current?.style.setProperty("--level", smoothed.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      halo.current?.style.setProperty("--level", "0");
    };
  }, [state, level]);

  return (
    <button
      type="button"
      className={`orb orb--${state}`}
      onClick={onClick}
      disabled={disabled || state === "transcribing"}
      aria-pressed={state === "listening"}
      aria-label={LABELS[state]}
      title={LABELS[state]}
    >
      <span className="orb-halo" ref={halo} aria-hidden="true" />
      {state === "listening" ? (
        <Square size={18} fill="currentColor" aria-hidden="true" />
      ) : state === "transcribing" ? (
        <LoaderCircle size={22} className="spin" aria-hidden="true" />
      ) : (
        <Mic size={22} aria-hidden="true" />
      )}
    </button>
  );
}
