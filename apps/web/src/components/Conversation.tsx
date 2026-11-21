import { useEffect, useRef } from "react";
import type { Turn } from "../types";
import { Answer } from "./Answer";

const EXAMPLES: { kind: "docs" | "web" | "hybrid"; label: string; questions: string[] }[] = [
  {
    kind: "docs",
    label: "Answered from your documents",
    questions: ["How many PTO days does a new employee get?", "What is the minimum password length?"],
  },
  { kind: "web", label: "Answered from the web", questions: ["What's the weather in Chicago today?"] },
  {
    kind: "hybrid",
    label: "Answered from both",
    questions: ["What is the current IRS mileage rate that our travel policy reimburses?"],
  },
];

interface Props {
  turns: Turn[];
  readOnly: boolean;
  publicLiveDemo: boolean;
  hasDocuments: boolean;
  busy: boolean;
  onAsk: (question: string) => void;
  onLoadSamples: () => void;
}

export function Conversation({ turns, readOnly, publicLiveDemo, hasDocuments, busy, onAsk, onLoadSamples }: Props) {
  const scroller = useRef<HTMLDivElement>(null);

  // The newest turn is at least one screen tall, so a new question can scroll to the top
  // of the page and its answer streams in below it, in place, like reading down a page.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => el.style.setProperty("--viewport-height", `${el.clientHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const id = turns.at(-1)?.id;
    if (!id) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }, [turns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="conversation" ref={scroller}>
      <div className="conversation-inner">
        {turns.length === 0 ? (
          <section className="empty">
            <h1>{publicLiveDemo ? "Ask the sample documents or the web." : readOnly ? "Ask the sample documents." : "Ask your documents."}</h1>
            <p className="empty-lede">
              {publicLiveDemo ? "Ask a question and inspect the cited documents or search results." : readOnly
                ? "Try a question about the fictional company's policies and check the cited passages."
                : "Speak or type a question. Answers quote the passages they come from, and search the web when your files don't cover it."}
            </p>
            {!readOnly && !hasDocuments && (
              <div className="empty-library">
                <p>Your library is empty. Add your own files on the left, or start with the sample documents.</p>
                <button type="button" className="button button--primary" onClick={onLoadSamples}>
                  Load sample documents
                </button>
              </div>
            )}
            <div className="examples">
              {EXAMPLES.filter((group) => !readOnly || publicLiveDemo || group.kind === "docs").map((group) => (
                <div key={group.kind} className="example-group">
                  <p className="example-label">
                    <span className={`route-mark route-mark--${group.kind}`} aria-hidden="true" />
                    {readOnly && !publicLiveDemo ? "Try a sample question" : group.label}
                  </p>
                  {group.questions.map((q) => (
                    <button key={q} type="button" className="example" disabled={busy} onClick={() => onAsk(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </section>
        ) : (
          turns.map((turn, i) => (
            <article key={turn.id} id={turn.id} className="turn">
              <h2 className="question">{turn.question}</h2>
              <Answer turn={turn} restrictedLinks={publicLiveDemo} isLatest={i === turns.length - 1} onRetry={() => onAsk(turn.question)} />
            </article>
          ))
        )}
      </div>
    </div>
  );
}
