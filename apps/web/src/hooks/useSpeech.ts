import { useCallback, useEffect, useRef, useState } from "react";
import { cleanForSpeech } from "../lib/speech";

/** Text-to-speech with the browser's speechSynthesis, one queued utterance per sentence. */
export function useSpeech() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const pending = useRef(0);
  const voice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (!supported) return;
    const pick = () => {
      const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
      voice.current = voices.find((v) => /natural|neural|google us|samantha|aria|jenny/i.test(v.name)) ?? voices[0] ?? null;
    };
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
    return () => speechSynthesis.removeEventListener("voiceschanged", pick);
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      const clean = cleanForSpeech(text);
      if (!supported || !clean) return;
      const utterance = new SpeechSynthesisUtterance(clean);
      if (voice.current) utterance.voice = voice.current;
      utterance.lang = voice.current?.lang ?? "en-US";
      utterance.rate = 1.05;
      const finished = () => {
        pending.current = Math.max(0, pending.current - 1);
        if (pending.current === 0) setSpeaking(false);
      };
      utterance.onend = finished;
      utterance.onerror = finished;
      pending.current += 1;
      setSpeaking(true);
      speechSynthesis.speak(utterance);
    },
    [supported],
  );

  const cancel = useCallback(() => {
    if (!supported) return;
    pending.current = 0;
    speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  return { supported, speaking, speak, cancel };
}
