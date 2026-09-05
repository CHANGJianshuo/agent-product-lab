import { describe, expect, it } from "vitest";
import type { ClaimSeed, EvidenceItem, ReasoningScorecard } from "../../shared/types";
import {
  buildFallbackArgumentMap,
  buildFallbackReasoningScorecard,
  detectStructuralFallacies,
  guardReasoningAudit,
  inferArgumentType,
  removeRedundantCompoundClaims,
} from "./logic";

function source(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "evidence-1",
    title: "研究原文",
    url: "https://example.gov.cn/report",
    domain: "example.gov.cn",
    publishedAt: "2026-08-01",
    accessedAt: "2026-09-03T00:00:00.000Z",
    quote: "该研究观察到两个指标同期变化，但没有确认因果关系。",
    quoteType: "page",
    relation: "related",
    relevance: 0.75,
    sourceKind: "政府或公共机构网站",
    quality: { score: 94, label: "较高", reasons: [] },
    promptInjectionIgnored: false,
    ...overrides,
  };
}

function scorecard(score = 0.95): ReasoningScorecard {
  const item = { score, status: "strong" as const, explanation: "模型认为本项较强。" };
  return {
    premiseReliability: { ...item },
    evidenceRelevance: { ...item },
    inferenceStrength: { ...item },
    evidenceCoverage: { ...item },
    sourceIndependence: { ...item },
  };
}

describe("argument audit guards", () => {
  it("recognizes common argument forms and supplies type-specific assumptions", () => {
    expect(inferArgumentType("other", "冰淇淋销量上升导致溺水人数增加")).toBe("causal");
    const map = buildFallbackArgumentMap("调查显示支持率为80%", "number");
    expect(map.argumentType).toBe("statistical");
    expect(map.implicitAssumptions.join(" ")).toContain("统计口径");
  });

  it("does not manufacture logical confidence when no original evidence exists", () => {
    const result = buildFallbackReasoningScorecard([]);
    expect(result.inferenceStrength.status).toBe("unknown");
    expect(result.sourceIndependence.score).toBe(0);
  });

  it("flags only high-signal structural overreach with cautious confidence", () => {
    const map = buildFallbackArgumentMap("摄像头是犯罪率下降的唯一原因", "causal");
    map.statedPremises = ["安装摄像头后犯罪率下降"];
    const findings = detectStructuralFallacies({
      id: "claim-1",
      text: map.conclusion,
      query: map.conclusion,
      queries: [map.conclusion],
      entities: [],
      claimType: "causal",
      timeScope: null,
      verificationPoints: [],
      extractionMethod: "rules",
      argumentMap: map,
    });
    expect(findings[0].code).toBe("causal_oversimplification");
    expect(findings[0].confidence).toBeLessThanOrEqual(0.8);
  });

  it("removes a repeated because-therefore compound when atomic parts already exist", () => {
    const makeSeed = (text: string, id: string): ClaimSeed => ({
      id,
      text,
      query: text,
      queries: [text],
      entities: [],
      claimType: "other",
      timeScope: null,
      verificationPoints: [],
      extractionMethod: "llm",
    });
    const result = removeRedundantCompoundClaims([
      makeSeed("一项研究调查了100名大学生，发现他们爱喝咖啡", "claim-1"),
      makeSeed("喝咖啡必然能让所有人长寿", "claim-2"),
      makeSeed("因为一项只调查了100名大学生的研究发现他们爱喝咖啡，所以喝咖啡必然能让所有人长寿", "claim-3"),
    ]);
    expect(result.map((claim) => claim.text)).toHaveLength(2);
    expect(result.map((claim) => claim.id)).toEqual(["claim-1", "claim-2"]);
  });

  it("caps model scores by actual evidence and drops unsupported fallacy labels", () => {
    const seed: ClaimSeed = {
      id: "claim-1",
      text: "冰淇淋销量上升导致溺水人数增加",
      query: "冰淇淋 溺水 因果",
      queries: ["冰淇淋 溺水 因果"],
      entities: [],
      claimType: "causal",
      timeScope: null,
      verificationPoints: ["检查替代原因"],
      extractionMethod: "rules",
      argumentMap: buildFallbackArgumentMap("冰淇淋销量上升导致溺水人数增加", "causal"),
    };
    const result = guardReasoningAudit({
      scorecard: scorecard(),
      fallacyFindings: [
        {
          code: "correlation_causation",
          label: "相关性冒充因果",
          confidence: 0.96,
          severity: "high",
          scope: "冰淇淋销量上升导致溺水人数增加",
          explanation: "尚未排除气温这一共同原因。",
          impact: "因果结论不能成立。",
          repair: "控制气温并检验机制。",
          evidenceIds: ["evidence-1", "invented-id"],
        },
        {
          code: "straw_man",
          label: "稻草人",
          confidence: 0.9,
          severity: "medium",
          scope: "原材料中不存在的句子",
          explanation: "无依据。",
          impact: "无。",
          repair: "无。",
          evidenceIds: [],
        },
      ],
      alternativeExplanations: [],
      criticalQuestions: [],
      whatWouldChangeMind: [],
    }, seed, [source()], "supported");

    expect(result.scorecard.sourceIndependence.score).toBeLessThanOrEqual(0.38);
    expect(result.scorecard.evidenceCoverage.score).toBeLessThanOrEqual(0.38);
    expect(result.fallacyFindings).toHaveLength(1);
    expect(result.fallacyFindings[0].confidence).toBe(0.8);
    expect(result.fallacyFindings[0].evidenceIds).toEqual(["evidence-1"]);
  });
});
