import { randomUUID } from "node:crypto";
import type {
  AnalysisProgress,
  AnalysisResult,
  AgentRun,
  ClaimAnalysis,
  ClaimSeed,
  ContextCheck,
  ContextCheckType,
  EvidenceItem,
  EvidenceRelation,
  QuestionProfile,
  SpecialistReview,
  Verdict,
} from "../../shared/types";
import { extractAtomicClaims, normalizeInputText } from "./claims";
import {
  addUsage,
  EMPTY_USAGE,
  isDeepSeekConfigured,
  resolveDeepSeekModels,
  type DeepSeekModelSelection,
  type TokenUsage,
} from "./deepseek";
import { buildWarnings, domainGroup, inferVerdict } from "./evidence";
import {
  analyzeImageWithLlm,
  auditSourceQualityWithLlm,
  falsifyClaimsWithLlm,
  judgeEvidenceWithLlm,
  matchEvidenceWithLlm,
  planVerificationWithLlm,
  type ClaimJudgment,
  type EvidenceRankAssessment,
  type VisionAnalysis,
} from "./llm";
import {
  buildFallbackAdversarialPlan,
  buildFallbackArgumentMap,
  buildFallbackCriticalQuestions,
  buildFallbackReasoningScorecard,
  guardReasoningAudit,
} from "./logic";
import { augmentQueriesForRoute, buildFallbackQuestionProfile, buildFallbackRoutePlan } from "./routing";
import { collectEvidenceForRoute } from "./search";
import {
  enrichEvidenceTrust,
  evidenceRankValue,
  independentGroup,
  isInspectableEvidence,
} from "./trust";
import { componentAttributionLimit, decideFalsification, selectEvidenceForIndependentReview } from "./verification";

type ProgressCallback = (progress: AnalysisProgress) => void;

interface AnalyzeOptions {
  imageDataUrl?: string;
  onProgress?: ProgressCallback;
  forceRules?: boolean;
}

interface SearchedClaim {
  seed: ClaimSeed;
  evidence: EvidenceItem[];
  rounds: number;
  errors: string[];
  executedQueries: Array<{ round: number; query: string; purpose: "primary" | "falsification" }>;
  specialistReview?: SpecialistReview;
}

const VERDICT_ORDER: Record<Verdict, number> = {
  disputed: 6,
  refuted: 5,
  misleading: 4,
  insufficient: 3,
  unknown: 2,
  supported: 1,
};

const VERDICT_LABELS: Record<Verdict, string> = {
  supported: "证据支持",
  refuted: "证据反驳",
  misleading: "语境可能误导",
  disputed: "存在可靠冲突",
  insufficient: "证据不足",
  unknown: "未找到可用证据",
};

const CONTEXT_LABELS: Record<ContextCheckType, string> = {
  old_news: "旧闻翻炒",
  out_of_context: "断章取义",
  subject_confusion: "主体混淆",
  image_text_mismatch: "图文不一致",
};

function emit(callback: ProgressCallback | undefined, progress: AnalysisProgress): void {
  callback?.(progress);
}

async function mapLimit<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function dedupeEvidence(items: EvidenceItem[], maxEvidence: number): EvidenceItem[] {
  const byUrl = new Map<string, EvidenceItem>();
  for (const item of items) {
    const normalizedTitle = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
    const academic = ["pubmed", "openalex"].includes(item.provider ?? "");
    const key = academic && normalizedTitle.length >= 20
      ? `academic-title:${normalizedTitle}`
      : item.doi
        ? `doi:${item.doi}`
        : item.url.replace(/[#?](?:utm_[^=]+|from|spm)=.*$/i, "").replace(/\/$/, "");
    const existing = byUrl.get(key);
    const itemRank = evidenceRankValue(item);
    const existingRank = existing
      ? evidenceRankValue(existing)
      : -1;
    const itemDate = item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
    const existingDate = existing?.publishedAt ? new Date(existing.publishedAt).getTime() : 0;
    if (!existing || itemRank > existingRank || (Math.abs(itemRank - existingRank) < 0.02 && itemDate > existingDate)) {
      byUrl.set(key, item);
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => {
      const rankA = evidenceRankValue(a);
      const rankB = evidenceRankValue(b);
      return rankB - rankA;
    })
    .slice(0, maxEvidence);
}

function hasEnoughEvidence(evidence: EvidenceItem[], seed: ClaimSeed): boolean {
  const readable = evidence.filter(
    (item) => isInspectableEvidence(item)
      && item.relevance >= 0.24
      && (item.trust?.overall ?? item.quality.score / 100) >= 0.58,
  );
  const groups = new Set(readable.map(independentGroup));
  const route = seed.routePlan?.primaryRoute;
  if (route === "scientific") {
    const academic = readable.filter((item) => ["systematic_review", "academic_paper"].includes(item.sourceCategory ?? ""));
    return groups.size >= 2 && academic.length >= 2;
  }
  if (route === "official_record" || route === "legal_policy") {
    return readable.some((item) => ["official_record", "official_statistics"].includes(item.sourceCategory ?? ""))
      && groups.size >= 2;
  }
  return groups.size >= 2 && readable.some((item) => (item.trust?.overall ?? item.quality.score / 100) >= 0.7);
}

function readableSearchError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : "搜索服务暂不可用";
  return /fetch failed|network|timeout|timed out|abort/i.test(rawMessage)
    ? "网络连接失败或超时"
    : rawMessage;
}

async function searchClaim(
  seed: ClaimSeed,
  resultLimit: number,
  maxEvidence: number,
  onRound: (round: number, query: string) => void,
): Promise<SearchedClaim> {
  const queries = [...new Set(seed.queries.length ? seed.queries : [seed.query])].slice(0, 5);
  const firstRound = queries.slice(0, Math.min(2, queries.length));
  const secondRound = queries.slice(firstRound.length);
  const errors: string[] = [];
  const executedQueries: SearchedClaim["executedQueries"] = [];
  let evidence: EvidenceItem[] = [];

  const runRound = async (roundQueries: string[], round: number) => {
    const batches = await mapLimit(roundQueries, 2, async (query) => {
      onRound(round, query);
      executedQueries.push({ round, query, purpose: "primary" });
      try {
        return await collectEvidenceForRoute(seed, query, round, resultLimit);
      } catch (error) {
        errors.push(`检索词“${query.slice(0, 80)}”未完成：${readableSearchError(error)}`);
        return [];
      }
    });
    evidence = enrichEvidenceTrust(
      dedupeEvidence([...evidence, ...batches.flat()], maxEvidence),
      seed.routePlan ?? buildFallbackRoutePlan(seed),
    );
  };

  await runRound(firstRound, 1);
  let rounds = 1;
  if (!hasEnoughEvidence(evidence, seed) && secondRound.length) {
    rounds = 2;
    await runRound(secondRound, 2);
  }
  return { seed, evidence, rounds, errors: [...new Set(errors)], executedQueries };
}

async function searchFalsificationRound(
  searched: SearchedClaim,
  queries: string[],
  resultLimit: number,
  maxEvidence: number,
  onQuery: (query: string) => void,
): Promise<SearchedClaim> {
  const unique = [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 2);
  if (!unique.length) return searched;
  const round = searched.rounds + 1;
  const errors = [...searched.errors];
  const batches = await mapLimit(unique, 2, async (query) => {
    onQuery(query);
    try {
      return await collectEvidenceForRoute(searched.seed, query, round, resultLimit);
    } catch (error) {
      errors.push(`反证检索词“${query.slice(0, 80)}”未完成：${readableSearchError(error)}`);
      return [];
    }
  });
  const previousEvidence = searched.evidence.map((item) => ({
    ...item,
    evidenceRole: undefined,
    directness: undefined,
    routeFit: undefined,
    rankerExplanation: undefined,
  }));
  return {
    ...searched,
    evidence: enrichEvidenceTrust(
      dedupeEvidence([...previousEvidence, ...batches.flat()], maxEvidence),
      searched.seed.routePlan ?? buildFallbackRoutePlan(searched.seed),
    ),
    rounds: round,
    errors: [...new Set(errors)],
    executedQueries: [
      ...searched.executedQueries,
      ...unique.map((query) => ({ round, query, purpose: "falsification" as const })),
    ],
  };
}

function applyEvidenceMatches(
  searched: SearchedClaim[],
  reviewInput: Array<{ seed: ClaimSeed; evidence: EvidenceItem[] }>,
  assessments: EvidenceRankAssessment[],
): SearchedClaim[] {
  const reviewedIds = new Set(reviewInput.flatMap((claim) => claim.evidence.map((item) => `${claim.seed.id}:${item.id}`)));
  const byEvidence = new Map(assessments.map((assessment) => [`${assessment.claimId}:${assessment.evidenceId}`, assessment]));
  return searched.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((item) => {
      const key = `${claim.seed.id}:${item.id}`;
      const assessment = byEvidence.get(key);
      if (assessment) {
        const attributionLimit = componentAttributionLimit(claim.seed, item);
        const attributionLimited = attributionLimit !== null && assessment.directness > attributionLimit;
        return {
          ...item,
          relation: relationFromAssessment(assessment.relation),
          relationExplanation: attributionLimited
            ? `${assessment.explanation} 但该研究评估混合鱼油/omega-3，不能把效果直接归因于 DHA 单体。`
            : assessment.explanation,
          evidenceRole: attributionLimited && assessment.role === "direct" ? "indirect" as const : assessment.role,
          directness: attributionLimit === null ? assessment.directness : Math.min(assessment.directness, attributionLimit),
          routeFit: assessment.routeFit,
          rankerExplanation: attributionLimited
            ? `${assessment.explanation} 成分归因护栏已将直接性限制为 ${Math.round(attributionLimit * 100)}%。`
            : assessment.explanation,
        };
      }
      if (!reviewedIds.has(key)) {
        return {
          ...item,
          evidenceRole: "background" as const,
          directness: Math.min(item.relevance, item.quoteType === "metadata" ? 0.1 : 0.2),
          routeFit: item.trust?.routeFit ?? 0.35,
          rankerExplanation: "确定性预筛未将该项送入独立核验，因此只作为背景线索。",
        };
      }
      return {
        ...item,
        evidenceRole: item.relevance >= 0.28 ? "indirect" as const : "background" as const,
        directness: Math.min(item.relevance, item.quoteType === "metadata" ? 0.14 : 0.4),
        routeFit: item.trust?.routeFit ?? 0.4,
        rankerExplanation: "命题匹配核验未返回该项，按相关度和证据形态保守降级。",
      };
    }).sort((left, right) => evidenceRankValue(right) - evidenceRankValue(left)),
  }));
}

function relationFromAssessment(relation: string): EvidenceRelation {
  if (relation === "supports") return "supporting_context";
  if (relation === "refutes") return "counter_signal";
  return "related";
}

function guardJudgment(judgment: ClaimJudgment, evidence: EvidenceItem[], seed: ClaimSeed): ClaimJudgment {
  const validIds = new Set(evidence.map((item) => item.id));
  const assessments = judgment.evidenceAssessments.filter((item) => validIds.has(item.evidenceId));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const supportDomains = new Set(
    assessments
      .filter((item) => {
        const source = evidenceById.get(item.evidenceId);
        return item.relation === "supports"
          && Boolean(source && isInspectableEvidence(source))
          && ["direct", "indirect"].includes(source?.evidenceRole ?? "indirect")
          && (source?.directness ?? source?.relevance ?? 0) >= 0.42;
      })
      .map((item) => independentGroup(evidenceById.get(item.evidenceId)!)),
  );
  const refuteDomains = new Set(
    assessments
      .filter((item) => {
        const source = evidenceById.get(item.evidenceId);
        return item.relation === "refutes"
          && Boolean(source && isInspectableEvidence(source))
          && ["direct", "indirect"].includes(source?.evidenceRole ?? "indirect")
          && (source?.directness ?? source?.relevance ?? 0) >= 0.42;
      })
      .map((item) => independentGroup(evidenceById.get(item.evidenceId)!)),
  );
  const sourceMeetsRoute = (source: EvidenceItem): boolean => {
    if (seed.routePlan?.primaryRoute === "scientific") {
      return ["systematic_review", "academic_paper"].includes(source.sourceCategory ?? "");
    }
    if (["official_record", "legal_policy"].includes(seed.routePlan?.primaryRoute ?? "")) {
      return ["official_record", "official_statistics"].includes(source.sourceCategory ?? "");
    }
    if (seed.routePlan?.primaryRoute === "statistics") {
      return ["official_statistics", "systematic_review", "academic_paper"].includes(source.sourceCategory ?? "");
    }
    return true;
  };
  const hasHighQualitySupport = assessments.some((item) => {
    const source = evidenceById.get(item.evidenceId);
    return item.relation === "supports"
      && Boolean(source && isInspectableEvidence(source))
      && Boolean(source && sourceMeetsRoute(source))
      && (source?.trust?.overall ?? ((source?.quality.score ?? 0) / 100)) >= 0.68
      && (source?.directness ?? source?.relevance ?? 0) >= 0.55;
  });
  const hasHighQualityRefutation = assessments.some((item) => {
    const source = evidenceById.get(item.evidenceId);
    return item.relation === "refutes"
      && Boolean(source && isInspectableEvidence(source))
      && Boolean(source && sourceMeetsRoute(source))
      && (source?.trust?.overall ?? ((source?.quality.score ?? 0) / 100)) >= 0.68
      && (source?.directness ?? source?.relevance ?? 0) >= 0.55;
  });

  let verdict = judgment.verdict;
  let confidence = Math.min(0.85, judgment.confidence);
  let conclusion = judgment.conclusion;
  let reasoningSummary = judgment.reasoningSummary;
  const unknowns = [...judgment.unknowns];
  let reasoningAudit = guardReasoningAudit({
    scorecard: judgment.reasoningScorecard,
    fallacyFindings: judgment.fallacyFindings,
    alternativeExplanations: judgment.alternativeExplanations,
    criticalQuestions: judgment.criticalQuestions,
    whatWouldChangeMind: judgment.whatWouldChangeMind,
  }, seed, evidence, verdict);

  const downgrade = (reason: string) => {
    verdict = evidence.length ? "insufficient" : "unknown";
    confidence = Math.min(confidence, evidence.length ? 0.45 : 0.2);
    conclusion = evidence.length ? "当前证据不足以支撑确定结论。" : "本轮未取得可用证据。";
    reasoningSummary = reason;
    if (!unknowns.includes(reason)) unknowns.unshift(reason);
  };

  if (verdict === "supported" && (supportDomains.size < 2 || !hasHighQualitySupport)) {
    downgrade("支持证据未同时满足两个独立原文与至少一个高质量来源，已按保守规则降级。");
  } else if (verdict === "refuted" && (refuteDomains.size < 2 || !hasHighQualityRefutation)) {
    downgrade("反驳证据未同时满足两个独立原文与至少一个高质量来源，已按保守规则降级。");
  } else if (verdict === "disputed" && (!supportDomains.size || !refuteDomains.size)) {
    downgrade("尚未同时取得独立的支持与反向原文，不能判为可靠冲突。");
  } else if (verdict === "misleading" && !judgment.contextChecks.some((check) => check.status === "risk")) {
    downgrade("没有足够的时间、主体、图片或上下文证据支持“误导”判断。");
  } else if (["insufficient", "unknown"].includes(verdict)) {
    confidence = Math.min(confidence, verdict === "unknown" ? 0.25 : 0.45);
  }
  const coreScores = [
    reasoningAudit.scorecard.premiseReliability.score,
    reasoningAudit.scorecard.evidenceRelevance.score,
    reasoningAudit.scorecard.inferenceStrength.score,
  ];
  if (verdict === "supported" && coreScores.some((score) => score < 0.45)) {
    downgrade("证据可能触及部分前提，但前提可靠性、证据相关性或推理充分性至少一项未通过，已按论证护栏降级。");
  }
  if (["supported", "refuted"].includes(verdict)) {
    const corroboratingDomains = verdict === "supported" ? supportDomains.size : refuteDomains.size;
    confidence = Math.min(confidence, corroboratingDomains >= 3 ? 0.85 : 0.78);
  }
  reasoningAudit = guardReasoningAudit(reasoningAudit, seed, evidence, verdict);
  const scoreValues = Object.values(reasoningAudit.scorecard).map((item) => item.score);
  const auditAverage = scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length;
  confidence = Math.min(confidence, 0.12 + auditAverage * 0.82);

  return {
    ...judgment,
    verdict,
    confidence,
    conclusion,
    reasoningSummary,
    evidenceAssessments: assessments,
    contextChecks: judgment.contextChecks.map((check) => ({
      ...check,
      evidenceIds: check.evidenceIds.filter((id) => validIds.has(id)),
    })),
    unknowns: unknowns.slice(0, 6),
    reasoningScorecard: reasoningAudit.scorecard,
    fallacyFindings: reasoningAudit.fallacyFindings,
    alternativeExplanations: reasoningAudit.alternativeExplanations,
    criticalQuestions: reasoningAudit.criticalQuestions,
    whatWouldChangeMind: reasoningAudit.whatWouldChangeMind,
  };
}

function deterministicContextChecks(vision: VisionAnalysis | null): ContextCheck[] {
  if (!vision) return [];
  return [{
    type: "image_text_mismatch",
    label: CONTEXT_LABELS.image_text_mismatch,
    status: vision.mismatchStatus,
    explanation: vision.mismatchExplanation,
    evidenceIds: [],
  }];
}

function criticTypeFor(seed: ClaimSeed): SpecialistReview["criticType"] {
  const route = seed.routePlan?.primaryRoute;
  if (route === "scientific") return "scientific";
  if (route === "statistics") return "statistics";
  if (route === "legal_policy" || route === "normative") return "policy";
  if (route === "conceptual") return "conceptual";
  if (route === "event_fact" || route === "official_record") return "news";
  return "general";
}

function buildFallbackSpecialistReview(seed: ClaimSeed, evidence: EvidenceItem[]): SpecialistReview {
  const inspectable = evidence.filter(isInspectableEvidence);
  const relevant = inspectable.filter((item) =>
    ["direct", "indirect"].includes(item.evidenceRole ?? "")
      && (item.directness ?? item.relevance) >= 0.2,
  );
  const average = (values: number[], fallback = 0): number => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : fallback;
  const dimension = (score: number, explanation: string) => ({
    score: Math.max(0, Math.min(1, score)),
    status: score >= 0.72 ? "strong" as const : score >= 0.44 ? "mixed" as const : score > 0 ? "weak" as const : "unknown" as const,
    explanation,
  });
  const directness = average(relevant.map((item) => item.directness ?? item.relevance));
  const integrity = average(relevant.map((item) => item.trust?.overall ?? item.quality.score / 100));
  const independent = new Set(relevant.map(independentGroup)).size;
  const criticType = criticTypeFor(seed);
  const methodObservable = relevant.some((item) => item.quoteType === "page") ? 0.48 : relevant.length ? 0.28 : 0;
  return {
    criticType,
    overallAssessment: relevant.length
      ? "来源质量核验未返回有效结构；以下仅为确定性证据可见性检查，不能替代研究方法或新闻取证审查。"
      : "本轮没有取得直接或足够相关的可检查证据，无法评价研究质量，也不能据此判断主张为真或为假。",
    designQuality: dimension(methodObservable, "规则只能确认材料是否可读，不能从摘要或网页片段完整判断研究设计。"),
    biasControl: dimension(0, "没有独立来源质量核验的结构化输出，偏倚控制保持未知。"),
    directness: dimension(directness, "依据命题匹配结果或词汇相关度给出保守直接性上限。"),
    precision: dimension(criticType === "statistics" || criticType === "scientific" ? methodObservable * 0.7 : methodObservable, "未完整取得样本、区间或事件细节时不提高精确性评分。"),
    sourceIntegrity: dimension(Math.min(integrity, independent >= 2 ? 0.82 : 0.4), "结合来源类别、可追溯性和本轮来源依赖组估计。"),
    limitations: relevant.length
      ? ["独立来源质量 Agent 不可用。", "规则模式不会从关键词推断未展示的研究方法或采访过程。"]
      : ["候选结果没有通过命题相关性门槛。", "需要更具体的人群、干预/暴露和结局后重新检索。"],
    evidenceIds: relevant.map((item) => item.id),
    reviewedBy: "rules",
  };
}

function applyJudgment(
  searched: SearchedClaim,
  rawJudgment: ClaimJudgment | undefined,
  vision: VisionAnalysis | null,
  pipelineWarning: string | null,
): ClaimAnalysis {
  const rawFallback = inferVerdict(searched.evidence);
  const fallback = rawFallback.verdict === "unknown"
    ? rawFallback
    : {
      verdict: "insufficient" as const,
      label: "证据不足",
      confidence: Math.min(0.4, rawFallback.confidence),
      unknowns: ["语义裁决不可用；相关搜索结果不能自动视为对主张的支持或反驳。"],
    };
  const judgment = rawJudgment ? guardJudgment(rawJudgment, searched.evidence, searched.seed) : null;
  const assessments = new Map(judgment?.evidenceAssessments.map((item) => [item.evidenceId, item]) ?? []);
  const evidence = searched.evidence.map((item) => {
    const assessment = assessments.get(item.id);
    return assessment ? {
      ...item,
      relation: relationFromAssessment(assessment.relation),
      relationExplanation: assessment.explanation,
    } : item;
  });
  const rawContextChecks: ContextCheck[] = judgment
    ? judgment.contextChecks.map((check) => ({ ...check, label: CONTEXT_LABELS[check.type] }))
    : deterministicContextChecks(vision);
  const applicabilityChecks = rawContextChecks.filter((check) =>
    searched.seed.routePlan?.routes.includes("scientific")
      && ["subject_confusion", "out_of_context"].includes(check.type)
      && /(?:研究人群|受试|参与者|患者|样本|健康成人|一般成人|一般成年人|外推|适用)/.test(check.explanation),
  );
  const contextChecks = rawContextChecks.filter((check) => !applicabilityChecks.includes(check));
  if (vision && !contextChecks.some((check) => check.type === "image_text_mismatch")) {
    contextChecks.push(...deterministicContextChecks(vision));
  }

  const verdict = judgment?.verdict ?? fallback.verdict;
  const argumentMap = searched.seed.argumentMap ?? buildFallbackArgumentMap(searched.seed.text, searched.seed.claimType);
  const adversarialPlan = searched.seed.adversarialPlan ?? buildFallbackAdversarialPlan(argumentMap);
  const fallbackScorecard = buildFallbackReasoningScorecard(evidence);
  const decisionEvidence = evidence.filter((item) =>
    !["background", "irrelevant"].includes(item.evidenceRole ?? "")
      && (item.directness ?? item.relevance) >= 0.18,
  );
  const scopedUnknowns = (judgment?.unknowns.length ? judgment.unknowns : fallback.unknowns).map((item) => item
    .replace(/^缺乏/, "本轮未取得")
    .replace(/^没有找到/, "本轮未找到")
    .replace(/^未找到/, "本轮未找到"));
  return {
    id: searched.seed.id,
    text: searched.seed.text,
    query: searched.seed.query,
    entities: searched.seed.entities,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    confidence: judgment?.confidence ?? fallback.confidence,
    conclusion: judgment?.conclusion ?? fallback.label,
    reasoningSummary: judgment?.reasoningSummary ?? fallback.unknowns[0],
    evidence,
    independentSourceCount: new Set(decisionEvidence.map(independentGroup)).size,
    searchPlan: [
      `证据路线：${searched.seed.routePlan?.routes.join(" + ") ?? "event_fact"}`,
      ...(searched.seed.routePlan?.sourcePriorities.map((priority) => `来源优先级：${priority}`) ?? []),
      ...searched.executedQueries.map(({ round, query, purpose }) =>
        `第 ${round} 轮${purpose === "falsification" ? "反证" : ""}检索：“${query}”`),
    ],
    searchRounds: searched.rounds,
    extractionMethod: searched.seed.extractionMethod,
    judgedByLlm: Boolean(judgment),
    contextChecks,
    counterEvidenceIds: evidence.filter((item) => item.relation === "counter_signal").map((item) => item.id),
    followUpQueries: judgment?.followUpQueries ?? [],
    warnings: [
      ...buildWarnings(searched.seed, evidence),
      ...(searched.errors.length && !evidence.length ? ["本轮检索请求未成功返回可用来源，请稍后重试。"] : []),
      ...(pipelineWarning ? [pipelineWarning] : []),
    ],
    retrievalNotes: searched.errors.length
      ? searched.errors.map((error) => evidence.length ? `部分检索未完成，但已保留其他成功来源：${error}` : error)
      : [],
    unknowns: [...new Set([
      ...scopedUnknowns,
      ...applicabilityChecks.map((check) => check.explanation
        .replace(/存在主体混淆风险[。.]?$/, "因此不能直接外推到主张人群。")
        .replace(/主体混淆/g, "人群适用性不足")),
    ])].slice(0, 6),
    argumentMap,
    reasoningScorecard: judgment?.reasoningScorecard ?? fallbackScorecard,
    fallacyFindings: judgment?.fallacyFindings ?? [],
    alternativeExplanations: judgment?.alternativeExplanations ?? adversarialPlan.alternativeExplanations.map((text) => ({
      text,
      status: "unresolved" as const,
      assessment: "这是反方规划阶段提出的待检验解释，尚无语义裁决。",
      evidenceIds: [],
    })),
    criticalQuestions: judgment?.criticalQuestions ?? buildFallbackCriticalQuestions(argumentMap),
    whatWouldChangeMind: judgment?.whatWouldChangeMind.length
      ? judgment.whatWouldChangeMind
      : adversarialPlan.missingInformation,
    strongestCounterargument: adversarialPlan.strongestCounterargument,
    routePlan: searched.seed.routePlan,
    specialistReview: searched.specialistReview,
  };
}

function summaryFor(claims: ClaimAnalysis[]): { headline: string; verdict: Verdict } {
  if (!claims.length) return { headline: "没有提取到可验证主张", verdict: "unknown" };
  const verdict = [...claims].sort((a, b) => VERDICT_ORDER[b.verdict] - VERDICT_ORDER[a.verdict])[0].verdict;
  const labels: Record<Verdict, string> = {
    supported: "当前证据为所提取主张提供了交叉支持",
    refuted: "至少一项主张与可靠证据不符",
    misleading: "材料中的时间、主体或上下文可能造成误导",
    disputed: "可靠来源之间存在尚未解决的冲突",
    insufficient: "已找到相关材料，但证据仍不足",
    unknown: "公开检索未取得足够证据",
  };
  return { headline: labels[verdict], verdict };
}

export async function analyzeText(
  rawText: string,
  inputKind: "text" | "image",
  ocrApplied: boolean,
  options: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const sourceText = normalizeInputText(rawText);
  const maxClaims = Math.max(1, Math.min(8, Number(process.env.MAX_CLAIMS) || 5));
  const resultLimit = Math.max(2, Math.min(5, Number(process.env.SEARCH_RESULTS_PER_QUERY) || 3));
  const maxEvidence = Math.max(4, Math.min(12, Number(process.env.MAX_EVIDENCE_PER_CLAIM) || 8));
  let usage: TokenUsage = { ...EMPTY_USAGE };
  let models: DeepSeekModelSelection | null = null;
  let vision: VisionAnalysis | null = null;
  let llmAvailable = isDeepSeekConfigured() && !options.forceRules;
  let pipelineWarning: string | null = null;
  let judgmentModelUsed: string | null = null;
  let questionProfile: QuestionProfile = buildFallbackQuestionProfile(sourceText);
  const agentRuns: AgentRun[] = [];
  const appendWarning = (warning: string) => {
    pipelineWarning = [pipelineWarning, warning].filter(Boolean).join("；");
  };

  emit(options.onProgress, { stage: "planning", message: "正在明确问题与核查范围", percent: 6 });
  if (llmAvailable) {
    try {
      models = await resolveDeepSeekModels();
      if (inputKind === "image" && options.imageDataUrl && models.vision) {
        emit(options.onProgress, { stage: "planning", message: "Vision Agent 正在检查图文一致性", detail: models.vision, percent: 9 });
        const visual = await analyzeImageWithLlm(options.imageDataUrl, sourceText, models);
        if (visual) {
          vision = visual.vision;
          usage = addUsage(usage, visual.usage);
          agentRuns.push({
            id: "vision-agent",
            label: "Vision Agent",
            role: "检查截图、OCR 与可见来源标识",
            model: models.vision,
            status: "completed",
            contextPolicy: "independent_request",
            detail: "只描述图片可见内容，不参与最终真假裁决。",
          });
        }
      }
    } catch (error) {
      llmAvailable = false;
      models = null;
      appendWarning(`LLM 暂不可用，已降级为规则模式：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  let seeds: ClaimSeed[];
  if (llmAvailable && models) {
    try {
      emit(options.onProgress, {
        stage: "planning",
        message: "正在一次完成消歧、拆题和检索规划",
        detail: "只规划需要核查的最少命题，不在这一阶段回答真假",
        percent: 14,
      });
      const planned = await planVerificationWithLlm(sourceText, maxClaims, models, vision);
      questionProfile = planned.profile;
      seeds = planned.claims;
      usage = addUsage(usage, planned.usage);
      agentRuns.push({
        id: "verification-planner",
        label: "Verification Planner",
        role: "一次完成问题消歧、必要核查点、证据路线和检索式",
        model: models.planning,
        status: "completed",
        contextPolicy: "independent_request",
        detail: `${questionProfile.strategy === "branched" ? "采用多解释分支；" : "问题含义明确；"}生成 ${seeds.length} 条必要核查点，替代原先四个串联规划角色。`,
      });
    } catch (error) {
      seeds = extractAtomicClaims(sourceText, maxClaims);
      const message = error instanceof Error ? error.message : "模型输出无效";
      if (/(?:余额不足|密钥|unauthori|forbidden|authentication)/i.test(message)) llmAvailable = false;
      appendWarning(`统一核查规划已降级为规则模式：${message}`);
      agentRuns.push({
        id: "verification-planner",
        label: "Verification Planner",
        role: "一次完成问题消歧、必要核查点、证据路线和检索式",
        model: models.planning,
        status: "fallback",
        contextPolicy: "independent_request",
        detail: "模型输出无效，采用确定性消歧、主张拆分和路由规则。",
      });
    }
  } else {
    seeds = extractAtomicClaims(sourceText, maxClaims);
    agentRuns.push({
      id: "verification-planner",
      label: "Verification Planner",
      role: "一次完成问题消歧、必要核查点、证据路线和检索式",
      model: "rules-v1",
      status: "fallback",
      contextPolicy: "deterministic",
      detail: `规则模式识别范围并提取 ${seeds.length} 条主张。`,
    });
  }

  seeds = seeds.map((seed) => {
    const routePlan = seed.routePlan ?? buildFallbackRoutePlan(seed);
    const adversarialPlan = seed.adversarialPlan ?? buildFallbackAdversarialPlan(
      seed.argumentMap ?? buildFallbackArgumentMap(seed.text, seed.claimType),
    );
    const prepared: ClaimSeed = {
      ...seed,
      routePlan,
      adversarialPlan,
      queries: [...new Set([
        seed.query,
        ...seed.queries.slice(0, 3),
      ])],
    };
    return { ...prepared, queries: augmentQueriesForRoute(prepared) };
  });

  emit(options.onProgress, {
    stage: "searching",
    message: `正在为 ${seeds.length} 个核查点定向寻找来源`,
    detail: seeds.some((seed) => seed.routePlan?.routes.includes("scientific"))
      ? "科学路线使用英文研究问题检索 PubMed、OpenAlex；事实路线追踪官方原文和报道"
      : "按证据路线执行官方原文、事件事实和反向检索",
    percent: 29,
  });

  let completedClaims = 0;
  let searched = await mapLimit(seeds, 2, async (seed) => {
    const result = await searchClaim(seed, resultLimit, maxEvidence, (round, query) => {
      emit(options.onProgress, {
        stage: "searching",
        message: `核查点 ${Number(seed.id.split("-")[1]) || ""} · 第 ${round} 轮检索`,
        detail: query,
        percent: Math.min(62, 30 + completedClaims * (27 / Math.max(1, seeds.length)) + round * 3),
      });
    });
    completedClaims += 1;
    return result;
  });

  agentRuns.push({
    id: "retrieval-workers",
    label: "Route-specific Retrieval",
    role: "按路线检索学术索引、官方原文与公开报道",
    model: "tools",
    status: searched.some((claim) => claim.evidence.length) ? "completed" : "fallback",
    contextPolicy: "deterministic",
    detail: `取得 ${searched.reduce((sum, claim) => sum + claim.evidence.length, 0)} 项候选证据；科学路线使用 PubMed + OpenAlex + Web。`,
  });
  agentRuns.push({
    id: "trust-provenance",
    label: "Trust & Provenance Model",
    role: "按来源类别、路线适配、时效与同源关系计算透明权重",
    model: "rules-v1",
    status: "completed",
    contextPolicy: "deterministic",
    detail: "当前为可解释规则模型；不会伪称已从历史标签训练。",
  });

  const reviewable = searched.filter((claim) => claim.evidence.length > 0);
  let specialistReviews = new Map<string, SpecialistReview>();
  const buildReviewInput = (claimsToReview: SearchedClaim[]) => claimsToReview
    .map((claim) => ({
      seed: claim.seed,
      evidence: selectEvidenceForIndependentReview(claim.seed, claim.evidence),
    }))
    .filter((claim) => claim.evidence.length > 0);
  const initialReviewInput = buildReviewInput(searched);

  if (llmAvailable && models && initialReviewInput.length) {
    emit(options.onProgress, {
      stage: "reviewing",
      message: "两个独立核验正在交叉检查真实性",
      detail: "一方核对命题是否匹配，另一方独立审查来源与方法；二者不共享上下文",
      percent: 68,
    });
    const [matched, qualityAudited] = await Promise.all([
      matchEvidenceWithLlm(initialReviewInput, models),
      auditSourceQualityWithLlm(initialReviewInput, models),
    ]);
    usage = addUsage(addUsage(usage, matched.usage), qualityAudited.usage);
    agentRuns.push(...matched.runs, ...qualityAudited.runs);
    searched = applyEvidenceMatches(searched, initialReviewInput, matched.value);
    specialistReviews = qualityAudited.value;
    searched = searched.map((claim) => ({
      ...claim,
      specialistReview: specialistReviews.get(claim.seed.id) ?? buildFallbackSpecialistReview(claim.seed, claim.evidence),
    }));

    const falsificationTargets = searched
      .map((claim) => ({ claim, decision: decideFalsification(claim.seed, claim.evidence, claim.specialistReview) }))
      .filter((item) => item.decision.required);
    if (falsificationTargets.length) {
      emit(options.onProgress, {
        stage: "reviewing",
        message: "发现单边证据或高风险结论，正在主动寻找反证",
        detail: [...new Set(falsificationTargets.flatMap((item) => item.decision.reasons))].join("；"),
        percent: 76,
      });
      const falsified = await falsifyClaimsWithLlm(
        falsificationTargets.map(({ claim }) => ({ seed: claim.seed, evidence: claim.evidence })),
        models,
      );
      usage = addUsage(usage, falsified.usage);
      agentRuns.push(falsified.run);
      const planById = new Map(falsified.challenges.map((challenge) => [challenge.id, challenge.plan]));
      searched = searched.map((claim) => {
        const plan = planById.get(claim.seed.id);
        return plan ? { ...claim, seed: { ...claim.seed, adversarialPlan: plan } } : claim;
      });
      const targetIds = new Set(falsificationTargets.map(({ claim }) => claim.seed.id));
      const beforeCount = searched.reduce((sum, claim) => sum + claim.evidence.length, 0);
      searched = await mapLimit(searched, 2, async (claim) => {
        if (!targetIds.has(claim.seed.id)) return claim;
        return searchFalsificationRound(
          claim,
          claim.seed.adversarialPlan?.falsificationQueries ?? [],
          resultLimit,
          maxEvidence,
          (query) => emit(options.onProgress, {
            stage: "searching",
            message: "正在执行按需反证检索",
            detail: query,
            percent: 79,
          }),
        );
      });
      const afterCount = searched.reduce((sum, claim) => sum + claim.evidence.length, 0);
      const actuallySearchedIds = new Set(falsified.challenges
        .filter((challenge) => challenge.plan.falsificationQueries.length > 0)
        .map((challenge) => challenge.id));
      agentRuns.push({
        id: "falsification-retrieval",
        label: "Counter-evidence Retrieval",
        role: "只在触发条件成立时执行额外反证检索",
        model: "tools",
        status: actuallySearchedIds.size ? "completed" : "skipped",
        contextPolicy: "deterministic",
        detail: actuallySearchedIds.size
          ? `为 ${actuallySearchedIds.size} 条主张增加一轮反证检索，候选证据净变化 ${afterCount - beforeCount} 项。`
          : "Falsification Agent 未返回可执行查询，未增加检索轮次。",
      });

      const secondPassClaims = searched.filter((claim) => actuallySearchedIds.has(claim.seed.id));
      const secondReviewInput = buildReviewInput(secondPassClaims);
      if (secondReviewInput.length) {
        const [rematched, reaudited] = await Promise.all([
          matchEvidenceWithLlm(secondReviewInput, models),
          auditSourceQualityWithLlm(secondReviewInput, models),
        ]);
        usage = addUsage(addUsage(usage, rematched.usage), reaudited.usage);
        agentRuns.push(
          ...rematched.runs.map((run) => ({ ...run, id: `${run.id}-after-falsification`, label: `${run.label} · 反证后复核` })),
          ...reaudited.runs.map((run) => ({ ...run, id: `${run.id}-after-falsification`, label: `${run.label} · 反证后复核` })),
        );
        const revised = applyEvidenceMatches(secondPassClaims, secondReviewInput, rematched.value);
        const revisedById = new Map(revised.map((claim) => [claim.seed.id, {
          ...claim,
          specialistReview: reaudited.value.get(claim.seed.id) ?? buildFallbackSpecialistReview(claim.seed, claim.evidence),
        }]));
        searched = searched.map((claim) => revisedById.get(claim.seed.id) ?? claim);
        for (const [id, review] of reaudited.value) specialistReviews.set(id, review);
      }
    } else {
      agentRuns.push({
        id: "adaptive-falsifier",
        label: "Falsification Agent · 按需启动",
        role: "仅在高风险、证据单边或核验分歧时寻找额外反证",
        model: "rules-v1",
        status: "skipped",
        contextPolicy: "deterministic",
        detail: "本轮未达到触发阈值，没有增加一次只为展示流程的 LLM 请求。",
      });
    }
  } else {
    searched = searched.map((claim) => {
      const evidence = claim.evidence.map((item) => ({
        ...item,
        evidenceRole: isInspectableEvidence(item) && item.relevance >= 0.28 ? "indirect" as const : "background" as const,
        directness: Math.min(item.relevance, isInspectableEvidence(item) ? 0.45 : 0.1),
        routeFit: item.trust?.routeFit ?? 0.4,
        rankerExplanation: "未调用独立命题匹配核验；相关搜索结果不能自动视为直接证据。",
      })).sort((left, right) => evidenceRankValue(right) - evidenceRankValue(left));
      return { ...claim, evidence, specialistReview: buildFallbackSpecialistReview(claim.seed, evidence) };
    });
    agentRuns.push({
      id: "evidence-matcher",
      label: "Evidence Matching Agent",
      role: "独立核对材料是否回答命题以及支持或反驳关系",
      model: "rules-v1",
      status: reviewable.length ? "fallback" : "skipped",
      contextPolicy: "deterministic",
      detail: reviewable.length ? "LLM 不可用或没有材料通过预筛，采用保守相关度上限。" : "没有候选证据可供核验。",
    });
    agentRuns.push({
      id: "source-quality-auditor",
      label: "Source Quality Agent",
      role: "独立检查来源生产方法、偏倚、精度与完整性",
      model: "rules-v1",
      status: reviewable.length ? "fallback" : "skipped",
      contextPolicy: "deterministic",
      detail: reviewable.length ? "只执行可见性与来源完整性护栏。" : "没有可审查证据。",
    });
    agentRuns.push({
      id: "adaptive-falsifier",
      label: "Falsification Agent · 按需启动",
      role: "仅在双核验后满足触发条件时寻找额外反证",
      model: "rules-v1",
      status: "skipped",
      contextPolicy: "deterministic",
      detail: "独立 LLM 核验不可用，本轮不启动自适应反证请求。",
    });
  }

  let judgments = new Map<string, ClaimJudgment>();
  if (llmAvailable && models && searched.length) {
    emit(options.onProgress, {
      stage: "judging",
      message: "正在综合证据并生成有边界的结论",
      detail: `${models.judgment} · 不按 Agent 多数投票，只按证据强度裁决`,
      percent: 86,
    });
    try {
      const judged = await judgeEvidenceWithLlm(searched, models, vision);
      usage = addUsage(usage, judged.usage);
      judgmentModelUsed = judged.modelUsed;
      if (judged.fallbackReason) {
        appendWarning(judged.fallbackReason);
      }
      judgments = new Map(judged.judgment.claims.map((judgment) => [judgment.id, judgment]));
      agentRuns.push({
        id: "final-judge",
        label: "Final Judge",
        role: "综合原始证据、命题匹配、来源质量与按需反证结果",
        model: judged.modelUsed,
        status: "completed",
        contextPolicy: "structured_handoff",
        detail: "只接收结构化交接，不使用模型记忆补充来源。",
      });
    } catch (error) {
      appendWarning(`证据裁决已降级为保守规则：${error instanceof Error ? error.message : "模型输出无效"}`);
      agentRuns.push({
        id: "final-judge",
        label: "Final Judge",
        role: "综合原始证据、命题匹配、来源质量与按需反证结果",
        model: models.judgment,
        status: "fallback",
        contextPolicy: "structured_handoff",
        detail: "最终模型输出无效，确定性护栏拒绝从相关性推断真假。",
      });
    }
  } else {
    agentRuns.push({
      id: "final-judge",
      label: "Final Judge",
      role: "综合原始证据、命题匹配、来源质量与按需反证结果",
      model: "rules-v1",
      status: "fallback",
      contextPolicy: "deterministic",
      detail: "未调用 LLM，规则模式只输出证据不足或未知。",
    });
  }

  agentRuns.push({
    id: "citation-verifier",
    label: "Citation Verifier",
    role: "拒绝虚构证据 ID，并校验证据可读性、直接性与独立来源组",
    model: "rules-v1",
    status: "completed",
    contextPolicy: "deterministic",
    detail: "最终裁决仍需通过确定性引用与置信度护栏。",
  });

  const claims = searched.map((item) => applyJudgment(item, judgments.get(item.seed.id), vision, pipelineWarning));
  const aggregate = summaryFor(claims);
  const evidenceCount = claims.reduce((sum, claim) => sum + claim.evidence.length, 0);
  const readableEvidenceCount = claims.reduce(
    (sum, claim) => sum + claim.evidence.filter(isInspectableEvidence).length,
    0,
  );
  const llmUsed = agentRuns.some((run) => run.status === "completed" && !["rules-v1", "tools"].includes(run.model));
  const searchRounds = Math.max(0, ...claims.map((claim) => claim.searchRounds));

  const result: AnalysisResult = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    input: { kind: inputKind, characterCount: sourceText.length, ocrApplied },
    sourceText,
    questionProfile,
    summary: {
      headline: aggregate.headline,
      verdict: aggregate.verdict,
      claimCount: claims.length,
      evidenceCount,
      readableEvidenceCount,
      unknownCount: claims.filter((claim) => ["insufficient", "unknown", "disputed"].includes(claim.verdict)).length,
      riskCount: claims.reduce((sum, claim) => sum + claim.contextChecks.filter((check) => check.status === "risk").length, 0),
    },
    claims,
    methodology: {
      version: llmUsed ? "SourceLens Evidence Review · 2.2.0" : "Rules fallback · 2.2.0",
      searchProvider: `DuckDuckGo HTML + PubMed + OpenAlex（按路线启用，最多 ${searchRounds} 轮，带本地缓存）`,
      pipeline: llmUsed ? "multi_agent" : "deterministic_fallback",
      llmUsed,
      planningModel: llmUsed ? models?.planning ?? null : null,
      judgmentModel: claims.some((claim) => claim.judgedByLlm) ? judgmentModelUsed ?? models?.judgment ?? null : null,
      visionModel: vision ? models?.vision ?? null : null,
      searchRounds,
      tokenUsage: llmUsed ? usage : null,
      agentRuns,
      trustModel: "Trust & Provenance rules-v1（来源类别 × 证据路线 × 时效 × 同源关系；尚未使用历史标签训练）",
      limitations: [
        "结论只基于本轮实际取得的网页、论文摘要或元数据；模型记忆不作为证据。",
        "命题匹配与来源质量由两个隔离上下文的 LLM 请求独立核验；最终结论不是 Agent 多数投票。",
        "反证 Agent 只在高风险、证据单边、核验分歧或来源完整性偏弱时按需启动。",
        "PubMed 与 OpenAlex 提供学术发现和摘要索引，不等于完成全文方法审查；仅有元数据的论文不能支持结论。",
        "公开检索可能遗漏动态页面、付费全文、数据库记录和未被索引的一手材料。",
        "Trust Model 当前是透明规则先验而非已训练模型；其分数只用于排序和置信度护栏。",
        "谬误卡表示带文本依据的疑似推理风险，不是对作者动机或人格的判断。",
        "论证评分经过确定性上限约束，但自然语言重建仍可能遗漏隐含前提。",
        "高风险领域的报告仅供信息核查，不能替代专业意见。",
      ],
    },
  };
  emit(options.onProgress, { stage: "complete", message: "报告已生成", percent: 100 });
  return result;
}
