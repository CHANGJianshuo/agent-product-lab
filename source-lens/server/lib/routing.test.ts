import { describe, expect, it } from "vitest";
import type { ClaimSeed } from "../../shared/types";
import {
  augmentQueriesForRoute,
  buildFallbackQuestionProfile,
  buildFallbackRoutePlan,
  guardQuestionProfile,
  guardRoutePlan,
  claimStaysWithinPopulationScope,
} from "./routing";

function seed(text: string, claimType: ClaimSeed["claimType"] = "other"): ClaimSeed {
  return {
    id: "claim-1",
    text,
    query: text,
    queries: [text],
    entities: [],
    claimType,
    timeScope: null,
    verificationPoints: [],
    extractionMethod: "rules",
  };
}

describe("question profiling and evidence routing", () => {
  it("branches an undefined internet concept instead of forcing a yes/no answer", () => {
    const profile = buildFallbackQuestionProfile("美国斩杀线真的存在吗？");
    expect(profile.ambiguityLevel).toBe("material");
    expect(profile.strategy).toBe("branched");
    expect(profile.interpretations.length).toBeGreaterThanOrEqual(2);
    expect(profile.routes).toEqual(expect.arrayContaining(["conceptual", "statistics", "scientific"]));
    expect(profile.operationalDefinitions[0]?.term).toBe("斩杀线");
  });

  it("routes causal research claims to the scientific evidence regime", () => {
    const claim = seed("一项研究证明失业会导致长期抑郁风险上升", "causal");
    const route = buildFallbackRoutePlan(claim);
    expect(route.routes).toContain("scientific");
    expect(route.primaryRoute).toBe("scientific");
    expect(route.sourcePriorities.join(" ")).toContain("同行评议");
  });

  it("routes named supplements and broad efficacy claims to science", () => {
    const claim = seed("鱼油中的 DHA 成分对成年人无效");
    const route = buildFallbackRoutePlan(claim);
    expect(route.primaryRoute).toBe("scientific");
  });

  it("does not let planned claims invent a new comparison population", () => {
    const source = "鱼油中的 DHA 成分对成年人无效";
    expect(claimStaysWithinPopulationScope(source, "DHA 对成年人认知功能无显著效果")).toBe(true);
    expect(claimStaysWithinPopulationScope(source, "DHA 对成年人无效，但对儿童有效")).toBe(false);
  });

  it("does not let an LLM expand a clear science question into legal or news routes", () => {
    const text = "长期饮用咖啡能降低全因死亡率吗？请核查这个因果说法。";
    const guarded = guardQuestionProfile({
      summary: text,
      ambiguityLevel: "material",
      interpretations: [{ id: "interpretation-1", label: "无关制度解释", description: "检查官方制度", routes: ["legal_policy"] }],
      operationalDefinitions: [],
      strategy: "branched",
      clarificationQuestion: "是否指法律？",
      routes: ["scientific", "statistics", "legal_policy", "event_fact"],
      rationale: "model proposal",
      profiledBy: "llm",
    }, text);
    expect(guarded.ambiguityLevel).toBe("low");
    expect(guarded.routes).toEqual(expect.arrayContaining(["scientific", "statistics"]));
    expect(guarded.routes).not.toContain("legal_policy");
    expect(guarded.interpretations).toEqual([]);
  });

  it("preserves material ambiguity when a scientific question has no concrete outcome", () => {
    const text = "成年人补充DHA对健康有用吗？";
    const guarded = guardQuestionProfile({
      summary: text,
      ambiguityLevel: "material",
      interpretations: [
        { id: "interpretation-1", label: "心血管结局", description: "核查心血管事件", routes: ["scientific"] },
        { id: "interpretation-2", label: "认知结局", description: "核查记忆和执行功能", routes: ["scientific"] },
      ],
      operationalDefinitions: [],
      strategy: "branched",
      clarificationQuestion: "你最关心哪一种健康结局？",
      routes: ["scientific", "statistics", "event_fact"],
      rationale: "健康有用没有指定结局。",
      profiledBy: "llm",
    }, text);
    expect(guarded.ambiguityLevel).toBe("material");
    expect(guarded.strategy).toBe("branched");
    expect(guarded.interpretations).toHaveLength(3);
    expect(guarded.interpretations.map((item) => item.label)).toEqual([
      "功能性结局",
      "临床结局",
      "指标与安全性",
    ]);
    expect(guarded.routes).not.toContain("event_fact");
  });

  it("adds scientific evidence to an epidemiological statistics route", () => {
    const claim = seed("长期饮用咖啡与全因死亡率降低存在统计关联", "number");
    const guarded = guardRoutePlan(claim, {
      primaryRoute: "statistics",
      routes: ["statistics"],
      rationale: "统计关联",
      sourcePriorities: ["统计材料"],
      freshnessRequired: false,
    });
    expect(guarded.routes).toContain("scientific");
  });

  it("adds route-specific queries without replacing the original query", () => {
    const claim = seed("某治疗可以降低复发风险", "causal");
    claim.queries.push("adult treatment recurrence randomized trial");
    claim.routePlan = buildFallbackRoutePlan(claim);
    const queries = augmentQueriesForRoute(claim);
    expect(queries[0]).toBe(claim.query);
    expect(queries.some((query) => /systematic review/i.test(query))).toBe(true);
  });

  it("does not send a Chinese query with generic English suffixes to academic indexes", () => {
    const claim = seed("成年人补充某营养素是否有用", "causal");
    claim.routePlan = buildFallbackRoutePlan(claim);
    const queries = augmentQueriesForRoute(claim);
    expect(queries).toEqual([claim.query]);
  });

  it("builds concrete English academic fallbacks when the LLM planner is unavailable", () => {
    const claim = seed("成年人补充DHA对健康有用吗？", "causal");
    claim.verificationPoints = ["成年人", "DHA 补充", "具体健康结局"];
    claim.routePlan = buildFallbackRoutePlan(claim);
    const queries = augmentQueriesForRoute(claim);
    const academic = queries.filter((query) => !/[\u4e00-\u9fff]/.test(query));
    expect(academic.length).toBeGreaterThanOrEqual(2);
    expect(academic.every((query) => /adults DHA supplementation/i.test(query))).toBe(true);
    expect(academic.some((query) => /cognitive function/i.test(query))).toBe(true);
    expect(academic.some((query) => /cardiovascular outcomes/i.test(query))).toBe(true);
  });
});
