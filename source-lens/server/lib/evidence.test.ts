import { describe, expect, it } from "vitest";
import { buildWarnings, domainGroup, inferRelation, inferVerdict, relevanceScore, scoreSource } from "./evidence";
import type { ClaimSeed, EvidenceItem } from "../../shared/types";

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "e-1",
    title: "权威来源",
    url: "https://example.gov.cn/a",
    domain: "example.gov.cn",
    publishedAt: "2024-06-25",
    accessedAt: new Date().toISOString(),
    quote: "嫦娥六号返回器于2024年6月25日安全着陆，带回月球背面样品。",
    quoteType: "page",
    relation: "supporting_context",
    relevance: 0.8,
    sourceKind: "政府或公共机构网站",
    quality: { score: 94, label: "较高", reasons: [] },
    promptInjectionIgnored: false,
    ...overrides,
  };
}

function claim(text: string): ClaimSeed {
  return {
    id: "claim-1",
    text,
    query: text,
    queries: [text],
    entities: ["嫦娥六号"],
    claimType: "event",
    timeScope: null,
    verificationPoints: [],
    extractionMethod: "rules",
  };
}

describe("evidence heuristics", () => {
  it("groups Chinese second-level domains", () => {
    expect(domainGroup("news.example.com.cn")).toBe("example.com.cn");
  });

  it("scores readable government sources highly", () => {
    expect(scoreSource("space.gov.cn", "page").score).toBeGreaterThan(85);
  });

  it("requires independent sources for provisional support", () => {
    expect(inferVerdict([evidence()]).verdict).toBe("insufficient");
    expect(inferVerdict([
      evidence(),
      evidence({ id: "e-2", domain: "xinhua.com", url: "https://xinhua.com/a" }),
    ]).verdict).toBe("supported");
  });

  it("finds lexical relevance for a close passage", () => {
    const score = relevanceScore(
      "嫦娥六号于2024年6月25日带回月球背面样品",
      "6月25日，嫦娥六号返回器携带月球背面样品安全着陆。",
    );
    expect(score).toBeGreaterThan(0.35);
  });

  it("does not mistake ordinary 不/未 phrases for a contradiction", () => {
    expect(inferRelation(
      "嫦娥六号带回了月球背面样品",
      "前不久，研究团队利用嫦娥六号带回的月球背面样品取得最新成果。",
      0.9,
    )).toBe("supporting_context");
  });

  it("marks explicit refutations as a counter signal", () => {
    expect(inferRelation(
      "某地宣布明天停运地铁",
      "当地交通部门回应，网传明天停运地铁的消息不实。",
      0.9,
    )).toBe("counter_signal");
  });

  it("flags an exact month/day with a conflicting year", () => {
    const warnings = buildWarnings(
      claim("嫦娥六号于2023年6月25日返回地球"),
      [evidence()],
    );
    expect(warnings.some((warning) => warning.includes("2024-06-25"))).toBe(true);
  });
});
