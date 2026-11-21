import { describe, expect, it } from "vitest";
import { buildWebQuery } from "../src/agent/pipeline.js";
import { analyzeQuestion, buildRetrievalQuery, decideRoute, type RouteInput } from "../src/agent/router.js";

const base: RouteInput = {
  mode: "auto",
  intent: { needsFreshInfo: false, externalComparison: false },
  topScore: 0.5,
  minScore: 0.3,
  hasDocuments: true,
  webAvailable: true,
};

describe("analyzeQuestion", () => {
  it.each([
    ["What's the weather in Seattle today?", true, false],
    ["Who is the current CEO of OpenAI?", true, false],
    ["What are the latest AI headlines?", true, false],
    ["Is 18 days of PTO above the US average?", false, true],
    ["Compare our 401(k) match with other companies", false, true],
    ["How many PTO days do new employees get?", false, false],
    ["How should constants be named in PEP 8?", false, false],
    ["How should you compare a variable to None?", false, false],
    ["Compare PTO for new vs. senior employees", false, false],
  ])("%s", (question, fresh, comparison) => {
    expect(analyzeQuestion(question)).toEqual({ needsFreshInfo: fresh, externalComparison: comparison });
  });
});

describe("decideRoute", () => {
  it("answers from documents when they are relevant and nothing external is needed", () => {
    expect(decideRoute(base).route).toBe("docs");
  });

  it("goes hybrid when documents are relevant but the question needs fresh info", () => {
    expect(decideRoute({ ...base, intent: { needsFreshInfo: true, externalComparison: false } }).route).toBe("hybrid");
  });

  it("goes to the web when documents are not relevant", () => {
    const r = decideRoute({ ...base, topScore: 0.1 });
    expect(r.route).toBe("web");
    expect(r.reason).toMatch(/0.10 < 0.3/);
  });

  it("goes to the web when there are no documents", () => {
    expect(decideRoute({ ...base, hasDocuments: false, topScore: undefined }).route).toBe("web");
  });

  it("respects explicit modes", () => {
    expect(decideRoute({ ...base, mode: "docs", topScore: 0.01 }).route).toBe("docs");
    expect(decideRoute({ ...base, mode: "web" }).route).toBe("web");
    expect(decideRoute({ ...base, mode: "hybrid", topScore: 0.01 }).route).toBe("hybrid");
  });

  it("falls back to documents when web search is unavailable", () => {
    expect(decideRoute({ ...base, mode: "web", webAvailable: false }).route).toBe("docs");
    expect(decideRoute({ ...base, topScore: 0.1, webAvailable: false }).route).toBe("docs");
  });
});

describe("buildRetrievalQuery", () => {
  const history = [
    { role: "user" as const, content: "How many PTO days do new employees get?" },
    { role: "assistant" as const, content: "18 days [D1]." },
  ];

  it("expands short follow-ups with the previous question", () => {
    expect(buildRetrievalQuery("And after 6 years?", history)).toBe(
      "How many PTO days do new employees get?\nAnd after 6 years?",
    );
  });

  it("keeps standalone questions unchanged", () => {
    const q = "What is the hotel nightly cap in New York?";
    expect(buildRetrievalQuery(q, history)).toBe(q);
    expect(buildRetrievalQuery("And after 6 years?", [])).toBe("And after 6 years?");
  });
});

describe("buildWebQuery", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  it("adds the year to questions about current facts", () => {
    expect(buildWebQuery("What is the current IRS mileage rate?", now)).toBe("What is the current IRS mileage rate? 2026");
  });
  it("leaves other questions alone", () => {
    expect(buildWebQuery("IRS mileage rate 2025", now)).toBe("IRS mileage rate 2025");
    expect(buildWebQuery("Is 18 days of PTO above average?", now)).toBe("Is 18 days of PTO above average?");
  });
});
