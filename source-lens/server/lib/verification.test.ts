import { describe, expect, it } from "vitest";
import type { ClaimSeed, EvidenceItem, SpecialistReview } from "../../shared/types";
import { componentAttributionLimit, decideFalsification, selectEvidenceForIndependentReview } from "./verification";

function claim(text = "成年人补充 DHA 是否改善认知功能"): ClaimSeed {
  return {
    id: "claim-1",
    text,
    query: text,
    queries: [text],
    entities: ["DHA"],
    claimType: "causal",
    timeScope: null,
    verificationPoints: ["成年人", "DHA 补充", "认知功能"],
    extractionMethod: "rules",
    routePlan: {
      primaryRoute: "scientific",
      routes: ["scientific"],
      rationale: "test",
      sourcePriorities: ["同行评议研究"],
      freshnessRequired: false,
    },
  };
}

function evidence(id: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id,
    title: "Randomized trial of DHA supplementation and cognition in adults",
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    domain: "pubmed.ncbi.nlm.nih.gov",
    publishedAt: "2025-01-01",
    accessedAt: "2026-09-04T00:00:00.000Z",
    quote: "Adults were randomized to DHA or placebo and cognitive outcomes were measured.",
    quoteType: "abstract",
    relation: "supporting_context",
    relevance: 0.78,
    sourceKind: "随机对照试验（PubMed）",
    sourceCategory: "academic_paper",
    provider: "pubmed",
    quality: { score: 87, label: "较高", reasons: [] },
    trust: {
      overall: 0.82,
      sourcePrior: 0.75,
      routeFit: 0.92,
      primaryness: 0.92,
      freshness: 0.9,
      independence: 0.92,
      label: "较高",
      reasons: [],
      model: "rules-v1",
    },
    evidenceRole: "direct",
    directness: 0.82,
    routeFit: 0.92,
    promptInjectionIgnored: false,
    ...overrides,
  };
}

function review(overrides: Partial<SpecialistReview> = {}): SpecialistReview {
  const mixed = { score: 0.55, status: "mixed" as const, explanation: "部分信息可见。" };
  return {
    criticType: "scientific",
    overallAssessment: "可进行有限审查。",
    designQuality: mixed,
    biasControl: mixed,
    directness: mixed,
    precision: mixed,
    sourceIntegrity: mixed,
    limitations: [],
    evidenceIds: ["1"],
    reviewedBy: "llm",
    ...overrides,
  };
}

describe("independent verification controls", () => {
  it("caps direct attribution when a DHA claim is matched only to mixed fish oil", () => {
    const mixed = evidence("1", { title: "Effects of omega-3 fatty acids on cardiovascular events" });
    expect(componentAttributionLimit(claim(), mixed)).toBe(0.45);
    const isolated = evidence("2", { title: "Effects of DHA supplementation on cognition" });
    expect(componentAttributionLimit(claim(), isolated)).toBeNull();
  });
  it("only sends inspectable, minimally plausible material to the two reviewers", () => {
    const selected = selectEvidenceForIndependentReview(claim(), [
      evidence("1"),
      evidence("2", { quoteType: "search_snippet" }),
      evidence("3", {
        sourceCategory: "general_web",
        relevance: 0.03,
        trust: { ...evidence("x").trust!, overall: 0.2 },
      }),
    ]);
    expect(selected.map((item) => item.id)).toEqual(["1"]);
  });

  it("starts falsification for a high-stakes health claim with directional evidence", () => {
    const decision = decideFalsification(claim(), [evidence("1")], review());
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("高风险主张已有方向性证据");
  });

  it("starts falsification when independent reviewers materially disagree", () => {
    const decision = decideFalsification(
      claim("某项普通产品功能可以缩短任务时间"),
      [evidence("1", { directness: 0.84 })],
      review({ directness: { score: 0.2, status: "weak", explanation: "总体不匹配。" } }),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("命题匹配与质量审查存在明显分歧");
  });

  it("does not add an agent call for an ordinary claim with one weak clue", () => {
    const decision = decideFalsification(
      claim("某项普通产品功能可以缩短任务时间"),
      [evidence("1", { evidenceRole: "indirect", directness: 0.38, relation: "related" })],
      review(),
    );
    expect(decision).toEqual({ required: false, reasons: [] });
  });
});
