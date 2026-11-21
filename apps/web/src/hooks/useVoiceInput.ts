import { useCallback, useEffect, useRef, useState } from "react";
import { transcribe } from "../lib/api";

export type VoiceState = "idle" | "listening" | "transcribing";

/**
 * "browser": Web Speech API (Chrome, Edge, Safari) - live transcript, no server round trip.
 * "server":  record a clip with MediaRecorder and send it to /api/voice/transcribe (e.g. Firefox).
 */
export type VoiceEngine = "browser" | "server" | "none";

interface Options {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  lang?: string;
}

const SILENCE_MS = 1500; // server engine: stop after this much silence once speech started
const MAX_RECORDING_MS = 30_000;

const RECOGNITION_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in the browser's site settings to use voice.",
  "service-not-allowed": "This browser's speech service is turned off. Type your question instead.",
  "audio-capture": "No microphone was found. Check that one is connected and allowed for this site.",
  network: "Speech recognition needs a network connection: the browser sends audio to its speech service.",
  "language-not-supported": "Speech recognition doesn't support this language in this browser.",
};

function detectEngine(): VoiceEngine {
  if (typeof window === "undefined") return "none";
  // ?voice=server forces server transcription (e.g. to keep audio away from the browser's speech service).
  const forceServer = new URLSearchParams(window.location.search).get("voice") === "server";
  if (!forceServer && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)) return "browser";
  if (typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined") return "server";
  return "none";
}

export function useVoiceInput({ onInterim, onFinal, onError, lang = "en-US" }: Options) {
  const [engine] = useState(detectEngine);
  const [state, setState] = useState<VoiceState>("idle");
  /** Microphone level 0..1, updated every animation frame while listening (read it, don't render it). */
  const level = useRef(0);

  const handlers = useRef({ onInterim, onFinal, onError });
  handlers.current = { onInterim, onFinal, onError };

  const session = useRef<{
    stream?: MediaStream;
    audio?: AudioContext;
    raf?: number;
    recognition?: SpeechRecognition;
    recorder?: MediaRecorder;
    stopTimer?: number;
  }>({});

  const releaseMic = useCallback(() => {
    const s = session.current;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.stopTimer) clearTimeout(s.stopTimer);
    s.stream?.getTracks().forEach((t) => t.stop());
    void s.audio?.close().catch(() => undefined);
    session.current = {};
    level.current = 0;
  }, []);

  const stop = useCallback(() => {
    const s = session.current;
    if (s.recognition) s.recognition.stop();
    else if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop();
  }, []);

  /** Level meter (and silence detection for the server engine) from the mic stream. */
  const meter = useCallback(
    (stream: MediaStream) => {
      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let heardSpeech = false;
      let lastLoud = performance.now();
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / samples.length);
        level.current = Math.min(1, rms * 6);
        if (level.current > 0.12) {
          heardSpeech = true;
          lastLoud = performance.now();
        } else if (engine === "server" && heardSpeech && performance.now() - lastLoud > SILENCE_MS) {
          stop();
        }
        session.current.raf = requestAnimationFrame(tick);
      };
      tick();
      session.current.audio = audio;
    },
    [engine, stop],
  );

  const start = useCallback(async () => {
    if (engine === "none") {
      handlers.current.onError("Voice input is not supported in this browser.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      handlers.current.onError("Microphone access was blocked. Allow it in the browser's site settings to use voice.");
      return;
    }
    session.current.stream = stream;
    meter(stream);
    setState("listening");

    if (engine === "browser") {
      const Recognition = (window.SpeechRecognition ?? window.webkitSpeechRecognition)!;
      const recognition = new Recognition();
      recognition.lang = lang;
      recognition.interimResults = true;
      recognition.continuous = false; // ends by itself when the speaker pauses
      let finalText = "";
      recognition.onresult = (event) => {
        let interim = "";
        finalText = "";
        for (const result of Array.from(event.results)) {
          if (result.isFinal) finalText += result[0]?.transcript ?? "";
          else interim += result[0]?.transcript ?? "";
        }
        handlers.current.onInterim((finalText + interim).trim());
      };
      recognition.onerror = (event) => {
        if (event.error !== "no-speech" && event.error !== "aborted") {
          handlers.current.onError(RECOGNITION_ERRORS[event.error] ?? `Speech recognition stopped (${event.error}).`);
        }
      };
      recognition.onend = () => {
        releaseMic();
        setState("idle");
        handlers.current.onFinal(finalText.trim());
      };
      session.current.recognition = recognition;
      recognition.start();
      return;
    }

    // Server engine: record, then transcribe on the backend.
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = async () => {
      releaseMic();
      const clip = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (clip.size < 2000) {
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        handlers.current.onFinal((await transcribe(clip)).trim());
      } catch (err) {
        handlers.current.onError(err instanceof Error ? err.message : String(err));
      } finally {
        setState("idle");
      }
    };
    session.current.recorder = recorder;
    session.current.stopTimer = window.setTimeout(stop, MAX_RECORDING_MS);
    recorder.start();
  }, [engine, lang, meter, releaseMic, stop]);

  const toggle = useCallback(() => {
    if (state === "listening") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  useEffect(() => () => {
    session.current.recognition?.abort();
    releaseMic();
  }, [releaseMic]);

  return { engine, state, level, start, stop, toggle };
}
