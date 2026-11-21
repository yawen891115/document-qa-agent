import { describe, expect, it } from "vitest";
import { cleanForSpeech, SentenceBuffer } from "../src/lib/speech";

describe("cleanForSpeech", () => {
  it("drops citations, markdown and URLs", () => {
    expect(cleanForSpeech("New hires get **18 days** of PTO [D1][W2]. See [the IRS](https://irs.gov) page.")).toBe(
      "New hires get 18 days of PTO. See the IRS page.",
    );
    expect(cleanForSpeech("- First point [D1]\n- Second point")).toBe("First point Second point");
  });
});

describe("SentenceBuffer", () => {
  it("releases complete sentences as tokens stream in", () => {
    const buffer = new SentenceBuffer(10);
    const tokens = ["New employees ", "get 18 days of PTO [D1]. ", "After six years ", "it rises to 25 days", "."];
    const spoken = tokens.flatMap((t) => buffer.push(t));
    expect(spoken).toEqual(["New employees get 18 days of PTO [D1]."]);
    expect(buffer.flush()).toBe("After six years it rises to 25 days.");
  });

  it("does not split decimals or merge-worthy short fragments", () => {
    const buffer = new SentenceBuffer(40);
    expect(buffer.push("Accrual is 0.75 days per pay period. Yes. ")).toEqual([]);
    expect(buffer.push("Unused days carry over up to five days per year. ")).toEqual([
      "Accrual is 0.75 days per pay period. Yes.",
    ]);
  });

  it("treats line breaks (bullet lists) as boundaries", () => {
    const buffer = new SentenceBuffer(40);
    expect(buffer.push("- Tuesday\n- Wednesday\n")).toEqual(["- Tuesday", "- Wednesday"]);
  });
});
