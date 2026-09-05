import { describe, expect, it } from "vitest";
import type { ClaimRoutePlan, EvidenceItem } from "../../shared/types";
import { enrichEvidenceTrust, independentGroup } from "./trust";

const scientificPlan: ClaimRoutePlan = {
  primaryRoute: "scientific",
  routes: ["scientific"],
  rationale: "test",
  sourcePriorities: ["同行评议研究"],
  freshnessRequired: false,
};

function evidence(id: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id,
    title: "A cohort study of employment and depression",
    url: `https://example.com/${id}`,
    domain: "example.com",
    publishedAt: "2025-01-01",
    accessedAt: "2026-09-03T00:00:00.000Z",
    quote: "The cohort study measured employment status and subsequent depression outcomes.",
    quoteType: "abstract",
    relation: "related",
    relevance: 0.8,
    sourceKind: "学术研究（OpenAlex 索引）",
    sourceCategory: "academic_paper",
    provider: "openalex",
    doi: null,
    quality: { score: 76, label: "较高", reasons: [] },
    promptInjectionIgnored: false,
    ...overrides,
  };
}

describe("trust and provenance model", () => {
  it("does not count two pages from one publisher as independent evidence", () => {
    const enriched = enrichEvidenceTrust([evidence("one"), evidence("two")], scientificPlan);
    expect(independentGroup(enriched[0])).toBe(independentGroup(enriched[1]));
    expect(enriched[0].trust?.independence).toBeLessThan(0.6);
  });

  it("clusters syndicated wire reports across different domains", () => {
    const enriched = enrichEvidenceTrust([
      evidence("one", {
        domain: "alpha-news.example",
        url: "https://alpha-news.example/story",
        sourceCategory: "news",
        sourceKind: "新闻媒体",
        quote: "据路透社报道，该机构于周二发布声明。",
      }),
      evidence("two", {
        domain: "beta-news.example",
        url: "https://beta-news.example/story",
        sourceCategory: "news",
        sourceKind: "新闻媒体",
        quote: "路透社称，该机构周二发布了相关声明。",
      }),
    ], scientificPlan);
    expect(independentGroup(enriched[0])).toBe(independentGroup(enriched[1]));
  });

  it("weights an academic paper above news for a scientific route", () => {
    const enriched = enrichEvidenceTrust([
      evidence("paper"),
      evidence("news", {
        domain: "news.example",
        url: "https://news.example/story",
        sourceCategory: "news",
        sourceKind: "新闻媒体",
      }),
    ], scientificPlan);
    expect(enriched[0].trust!.routeFit).toBeGreaterThan(enriched[1].trust!.routeFit);
  });

  it("treats PubMed as an index rather than grouping every indexed paper as one publisher", () => {
    const enriched = enrichEvidenceTrust([
      evidence("pm-one", {
        provider: "pubmed",
        domain: "pubmed.ncbi.nlm.nih.gov",
        url: "https://pubmed.ncbi.nlm.nih.gov/111/",
        doi: "10.1000/one",
        title: "Randomized trial of DHA and cognition",
        quote: "A randomized trial measured cognition after DHA supplementation in adults.",
      }),
      evidence("pm-two", {
        provider: "pubmed",
        domain: "pubmed.ncbi.nlm.nih.gov",
        url: "https://pubmed.ncbi.nlm.nih.gov/222/",
        doi: "10.1000/two",
        title: "Cardiovascular outcomes after omega-3 supplementation",
        quote: "A separate cohort measured cardiovascular events after supplementation.",
      }),
    ], scientificPlan);
    expect(independentGroup(enriched[0])).not.toBe(independentGroup(enriched[1]));
    expect(enriched[0].trust?.independence).toBeGreaterThan(0.8);
  });
});
