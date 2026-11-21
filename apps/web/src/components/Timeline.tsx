import type { Timings } from "../types";

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

/**
 * Where the time went for one answer. Document retrieval and web search start
 * together, so their bars overlap; the answer bar starts when the model's first
 * token arrives.
 */
export function Timeline({ timings, model }: { timings: Timings; model?: string }) {
  const total = Math.max(timings.totalMs, 1);
  const pct = (ms: number) => `${Math.min(100, (ms / total) * 100)}%`;

  const docsEnd = timings.retrievalMs;
  const webStart = timings.webSearchStartMs ?? 0;
  const webEnd = timings.webSearchMs !== undefined ? webStart + timings.webSearchMs : undefined;
  const firstToken = timings.firstTokenMs ?? total;
  const promptSent = Math.max(docsEnd ?? 0, webEnd ?? 0);

  const summary = `First words after ${seconds(firstToken)}, full answer in ${seconds(total)}${model ? ` with ${model}` : ""}.`;

  return (
    <figure className="timeline" aria-label={summary}>
      <div className="timeline-lanes" aria-hidden="true">
        {docsEnd !== undefined && (
          <>
            <span className="lane-label">Documents</span>
            <span className="lane">
              <span className="bar bar--docs" style={{ left: 0, width: pct(Math.max(docsEnd, total * 0.01)) }} title={`Retrieval ${seconds(docsEnd)}`} />
            </span>
          </>
        )}
        {webEnd !== undefined && (
          <>
            <span className="lane-label">Web</span>
            <span className="lane">
              <span
                className="bar bar--web"
                style={{ left: pct(webStart), width: pct(webEnd - webStart) }}
                title={`Web search ${seconds(webEnd - webStart)}${timings.webSearchCached ? " (cached)" : ""}`}
              />
            </span>
          </>
        )}
        <span className="lane-label">Answer</span>
        <span className="lane">
          <span className="bar bar--wait" style={{ left: pct(promptSent), width: pct(firstToken - promptSent) }} title="Waiting for the model" />
          <span className="bar bar--stream" style={{ left: pct(firstToken), width: pct(total - firstToken) }} title="Streaming the answer" />
        </span>
      </div>
      <figcaption>{summary}</figcaption>
    </figure>
  );
}
