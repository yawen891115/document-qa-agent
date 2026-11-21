# Benchmarks

`npm run bench` runs every question in [`data/eval/questions.jsonl`](../data/eval/questions.jsonl)
against a running API (`npm run dev` first) and writes a JSON report to `benchmarks/results/`.

```bash
npm run bench                      # 2 runs: cold, then warm caches
npm run bench -- --runs 3          # more runs
npm run bench -- --mode hybrid     # force a route instead of the auto router
```

What it reports:

| Metric | Meaning |
|---|---|
| p50 / p95 first token | Time from sending the question to the first answer token, measured by the client over HTTP + SSE. This is what a user waits before the answer starts. |
| p50 / p95 total | Time until the full answer has streamed. |
| < 2 s total | Share of questions fully answered within 2 seconds. |
| route accuracy | How often the auto router picked the expected route (docs, web or hybrid). |
| retrieval hit rate | How often the expected document was among the retrieved passages. |
| keyword recall (docs) | Share of expected facts (for example "16 weeks") present in answers to document questions. |

Results depend on the model, the network and SerpAPI's response time, so measure on your own
machine with real keys before quoting numbers. The offline demo mode makes the latency numbers
meaningless (there is no LLM call) but still exercises the whole pipeline.
