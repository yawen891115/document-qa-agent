import { useCallback, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Library } from "./components/Library";
import { useChat } from "./hooks/useChat";
import { useLibrary } from "./hooks/useLibrary";
import { useSpeech } from "./hooks/useSpeech";
import { useVoiceInput } from "./hooks/useVoiceInput";
import { SentenceBuffer } from "./lib/speech";
import type { Mode } from "./types";

export function App() {
  const library = useLibrary();
  const speech = useSpeech();
  const health = library.health;
  const publicDemo = health?.publicDemo === true;
  const publicLiveDemo = health?.publicLiveDemo === true;
  const [mode, setMode] = useState<Mode>("auto");
  const [draft, setDraft] = useState("");
  const [readAloud, setReadAloud] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false); // small screens only
  const [bannerHidden, setBannerHidden] = useState(false);

  // Read the answer aloud sentence by sentence while it streams in.
  const sentences = useRef(new SentenceBuffer());
  const readAloudRef = useRef(readAloud);
  readAloudRef.current = readAloud;

  const chat = useChat({
    onToken: (text) => {
      if (readAloudRef.current) sentences.current.push(text).forEach(speech.speak);
    },
    onDone: () => {
      const rest = sentences.current.flush();
      if (readAloudRef.current && rest) speech.speak(rest);
    },
  });

  const ask = useCallback(
    (question: string) => {
      if (!question.trim()) return;
      speech.cancel();
      sentences.current = new SentenceBuffer();
      setDraft("");
      void chat.ask(question, publicDemo && !publicLiveDemo ? "docs" : mode);
    },
    [chat, mode, publicDemo, publicLiveDemo, speech],
  );

  const voice = useVoiceInput({
    onInterim: setDraft,
    onFinal: (text) => (text ? ask(text) : setDraft("")),
    onError: setNotice,
  });

  const toggleVoice = () => {
    speech.cancel(); // talking over the answer interrupts it
    setNotice(null);
    voice.toggle();
  };

  const offline = health?.llm.provider === "offline";

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <p className="brand">
            DocQA <span className="brand-sub">Document Q&amp;A agent</span>
          </p>
          <button
            type="button"
            className="library-toggle"
            aria-expanded={libraryOpen}
            aria-controls="library"
            onClick={() => setLibraryOpen((open) => !open)}
          >
            {libraryOpen ? "Hide library" : `Library (${library.documents.length})`}
          </button>
        </div>
        <ul className="status" aria-label="Service status">
          {library.apiDown ? (
            <li className="status-item is-off">API not reachable, start it with npm run dev</li>
          ) : health ? (
            <>
              <li className={`status-item${offline ? " is-warn" : ""}`}>{publicLiveDemo ? "Public demo" : publicDemo ? "Public sample preview" : offline ? "Offline extractive model" : health.llm.model}</li>
              <li className={`status-item${health.webSearch.connected ? "" : " is-off"}`}>
                {publicDemo && !publicLiveDemo ? "Web search off" : health.webSearch.connected ? "Web search connected" : "Web search unavailable"}
              </li>
            </>
          ) : null}
        </ul>
      </header>

      <Library
        open={libraryOpen}
        readOnly={!health || publicDemo}
        documents={library.documents}
        chunks={library.chunks}
        working={library.working}
        error={library.error}
        onUpload={library.upload}
        onLoadSamples={library.loadSamples}
        onRemove={library.remove}
        onDismissError={library.dismissError}
      />

      <main className="page">
        {publicLiveDemo && (
          <p className="banner">
            Public demo: ask GPT about the fictional Northwind documents, the web, or both.
            Questions may be sent to OpenAI and SerpAPI. Do not enter personal or confidential text.
            Uploads and voice are disabled.
          </p>
        )}
        {publicDemo && !publicLiveDemo && (
          <p className="banner">
            Public sample preview. Answers quote the bundled fictional Northwind documents without a generative model.
            No uploads, voice, or web search. Please do not enter personal or confidential information.
          </p>
        )}
        {offline && !publicDemo && !bannerHidden && (
          <p className="banner">
            Demo mode: no OpenAI key is set, so answers quote the best-matching sentences instead of being written by
            GPT-5. Add <code>OPENAI_API_KEY</code> to <code>.env</code> and restart to switch.{" "}
            <button type="button" className="link-button" onClick={() => setBannerHidden(true)}>
              Hide
            </button>
          </p>
        )}
        <Conversation
          turns={chat.turns}
          readOnly={!health || publicDemo}
          publicLiveDemo={publicLiveDemo}
          hasDocuments={library.documents.length > 0}
          busy={chat.busy}
          onAsk={ask}
          onLoadSamples={library.loadSamples}
        />
        {notice && (
          <p className="notice" role="alert">
            {notice}{" "}
            <button type="button" className="link-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </p>
        )}
        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={ask}
          busy={chat.busy}
          readOnlyPreview={!health || publicDemo}
          allowWeb={publicLiveDemo || Boolean(health && !publicDemo)}
          onStop={chat.stop}
          mode={publicDemo && !publicLiveDemo ? "docs" : mode}
          onModeChange={setMode}
          voice={{ engine: voice.engine, state: voice.state, level: voice.level, toggle: toggleVoice }}
          readAloud={{
            supported: speech.supported,
            enabled: readAloud,
            speaking: speech.speaking,
            onToggle: (on) => {
              setReadAloud(on);
              if (!on) speech.cancel();
            },
            onStop: speech.cancel,
          }}
        />
      </main>
    </div>
  );
}
