import { useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import type { Route, Turn } from "../types";
import { Timeline } from "./Timeline";

const ROUTE_TEXT: Record<Route, string> = {
  docs: "Answered from your documents",
  web: "Answered from the web",
  hybrid: "Answered from your documents and the web",
};

/** "[D1]" -> "[D1](#cite-D1)" so react-markdown hands citations to our link renderer. */
const linkCitations = (text: string) => text.replace(/\[([DW]\d+)\](?!\()/g, "[$1](#cite-$1)");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function Answer({ turn, isLatest, onRetry }: { turn: Turn; isLatest: boolean; onRetry: () => void }) {
  const [active, setActive] = useState<string | null>(null);
  const sources = useRef<HTMLDetailsElement>(null);
  const known = new Set([...turn.documents.map((d) => d.id), ...turn.web.map((w) => w.id)]);

  const showSource = (tag: string) => {
    setActive(tag);
    if (sources.current) sources.current.open = true;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() =>
      document.getElementById(`${turn.id}-${tag}`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" }),
    );
  };

  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith("#cite-")) {
        const tag = href.slice("#cite-".length);
        if (!known.has(tag)) return <span className="cite cite--missing">{tag}</span>;
        const kind = tag.startsWith("D") ? "doc" : "web";
        return (
          <button type="button" className={`cite cite--${kind}`} onClick={() => showSource(tag)} aria-label={`Show source ${tag}`}>
            {tag}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children as ReactNode}
        </a>
      );
    },
  };

  const thinking = turn.status === "thinking";

  return (
    <div className="answer-block">
      {thinking && (
        <p className="stage" aria-live="polite">
          {turn.stage ?? "Thinking…"}
        </p>
      )}

      {turn.answer && (
        <div className={`answer${turn.status === "streaming" ? " is-streaming" : ""}`} aria-live={isLatest ? "polite" : undefined}>
          <Markdown components={components}>{linkCitations(turn.answer)}</Markdown>
        </div>
      )}

      {turn.status === "stopped" && <p className="stage">Stopped before the answer started.</p>}

      {turn.status === "error" && (
        <p className="answer-error" role="alert">
          The question couldn't be answered: {turn.error}{" "}
          <button type="button" className="link-button" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}

      {turn.route && (
        <div className="provenance">
          <span className={`route-mark route-mark--${turn.route}`} aria-hidden="true" />
          <div>
            <p className="route-text">{ROUTE_TEXT[turn.route]}</p>
            {turn.reason && <p className="route-reason">{turn.reason}</p>}
            {turn.webError && <p className="route-reason route-reason--warn">Web search failed: {turn.webError}</p>}
          </div>
        </div>
      )}

      {turn.status === "done" && turn.timings && <Timeline timings={turn.timings} model={turn.model} />}

      {(turn.documents.length > 0 || turn.web.length > 0) && (
        <details className="sources" ref={sources} open={isLatest}>
          <summary>
            Sources:{" "}
            {[
              turn.documents.length ? plural(turn.documents.length, "passage from your documents", "passages from your documents") : "",
              turn.web.length ? plural(turn.web.length, "web result", "web results") : "",
            ]
              .filter(Boolean)
              .join(" and ")}
          </summary>
          <ol className="source-list">
            {turn.documents.map((d) => (
              <li key={d.id} id={`${turn.id}-${d.id}`} className={`source source--doc${active === d.id ? " is-active" : ""}`}>
                <span className="tag tag--doc">{d.id}</span>
                <div className="source-body">
                  <p className="source-title">{d.documentName}</p>
                  <p className="source-where">
                    {[d.page ? `Page ${d.page}` : "", d.section ?? "", `match ${d.score.toFixed(2)}`].filter(Boolean).join(", ")}
                  </p>
                  <p className="source-excerpt">{d.text}</p>
                </div>
              </li>
            ))}
            {turn.web.map((w) => (
              <li key={w.id} id={`${turn.id}-${w.id}`} className={`source source--web${active === w.id ? " is-active" : ""}`}>
                <span className="tag tag--web">{w.id}</span>
                <div className="source-body">
                  <a className="source-title" href={w.url} target="_blank" rel="noreferrer">
                    {w.title}
                  </a>
                  <p className="source-where">{[w.source ?? hostname(w.url), w.date].filter(Boolean).join(", ")}</p>
                  <p className="source-excerpt">{w.snippet}</p>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
