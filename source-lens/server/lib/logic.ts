import type {
  AdversarialPlan,
  AlternativeExplanation,
  ArgumentMap,
  ArgumentType,
  AuditDimension,
  AuditStatus,
  ClaimSeed,
  ClaimType,
  CriticalQuestion,
  EvidenceItem,
  FallacyFinding,
  IssueType,
  ReasoningScorecard,
  Verdict,
} from "../../shared/types";
import { domainGroup } from "./evidence";

const CAUSAL_MARKERS = /(?:导致|造成|引发|促使|使得|归因于|因为|因此|所以|源于|后果)/;
const GENERALIZATION_MARKERS = /(?:所有|任何|普遍|总是|从来|大多数|都认为|说明.*人|代表.*群体)/;
const AUTHORITY_MARKERS = /(?:专家|学者|教授|院士|机构|研究者|医生).{0,16}(?:称|表示|认为|指出|证实)/;
const ANALOGY_MARKERS = /(?:如同|就像|类似于|好比|同样地)/;
const DEDUCTIVE_MARKERS = /(?:如果.+那么|只有.+才|所有.+都是|必然|因此必定)/;
const STATISTICAL_MARKERS = /(?:\d+(?:\.\d+)?%|增长率|下降率|平均|样本|调查显示|数据表明|倍)/;
const POLICY_MARKERS = /(?:应该|必须|应当|需要|禁止|允许|建议|政策|措施)/;

export function inferArgumentType(claimType: ClaimType, text: string): ArgumentType {
  if (claimType === "causal" || CAUSAL_MARKERS.test(text)) return "causal";
  if (claimType === "policy" || POLICY_MARKERS.test(text)) return "policy";
  if (claimType === "number" || STATISTICAL_MARKERS.test(text)) return "statistical";
  if (GENERALIZATION_MARKERS.test(text)) return "generalization";
  if (AUTHORITY_MARKERS.test(text)) return "authority";
  if (ANALOGY_MARKERS.test(text)) return "analogy";
  if (DEDUCTIVE_MARKERS.test(text)) return "deductive";
  if (["event", "quote", "identity", "image_context"].includes(claimType)) return "factual";
  return "other";
}

function normalizedArgumentText(text: string): string {
  return text.toLowerCase().replace(/[\s，,。！？!?；;：“”"'（）()]/g, "");
}

function phraseCoverage(container: string, phrase: string): number {
  const longer = normalizedArgumentText(container);
  const shorter = normalizedArgumentText(phrase);
  if (!shorter) return 0;
  if (longer.includes(shorter)) return 1;
  if (shorter.length < 3) return 0;
  const grams = new Set<string>();
  for (let index = 0; index < shorter.length - 1; index += 1) grams.add(shorter.slice(index, index + 2));
  let shared = 0;
  for (const gram of grams) if (longer.includes(gram)) shared += 1;
  return shared / Math.max(1, grams.size);
}

export function removeRedundantCompoundClaims(claims: ClaimSeed[]): ClaimSeed[] {
  const compoundMarker = /(?:因为|由于).{2,}(?:所以|因此|从而)|(?:基于|鉴于).{2,}(?:所以|因此|可见)/;
  const filtered = claims.filter((candidate, index, all) => {
    if (!compoundMarker.test(candidate.text)) return true;
    const candidateLength = normalizedArgumentText(candidate.text).length;
    const coveredBy = all.filter((other, otherIndex) => (
      otherIndex !== index
      && normalizedArgumentText(other.text).length < candidateLength
      && phraseCoverage(candidate.text, other.text) >= 0.52
    ));
    const coveredLength = coveredBy.reduce((sum, other) => sum + normalizedArgumentText(other.text).length, 0);
    return coveredBy.length < 2 || coveredLength < candidateLength * 0.55;
  });
  return (filtered.length ? filtered : claims.slice(0, 1)).map((claim, index) => ({
    ...claim,
    id: `claim-${index + 1}`,
  }));
}

function issueTypeFor(argumentType: ArgumentType): IssueType {
  return argumentType === "policy" ? "prescriptive" : "descriptive";
}

function fallbackAssumptions(argumentType: ArgumentType): string[] {
  const assumptions: Partial<Record<ArgumentType, string[]>> = {
    causal: ["观察到的变化确由所述原因造成，且不存在足以解释结果的主要混杂因素。"],
    statistical: ["统计口径、样本选择、基准值和比较时间范围保持一致。"],
    generalization: ["所用样本足以代表结论覆盖的整体人群或情形。"],
    authority: ["被引用者在相关领域具备专长，且其意见被准确转述。"],
    analogy: ["被比较对象在影响结论的关键属性上足够相似。"],
    deductive: ["全部前提成立，且自然语言没有隐藏例外或量词变化。"],
    policy: ["建议能够实现所述目标，且不存在明显更优、代价更低的替代方案。"],
  };
  return assumptions[argumentType] ?? [];
}

function extractQualifiers(text: string): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(/20\d{2}年(?:\d{1,2}月(?:\d{1,2}日)?)?/g)) values.add(match[0]);
  for (const match of text.matchAll(/\d+(?:\.\d+)?(?:%|％|万|亿|人|例|次|倍|元|吨|公里)/g)) values.add(match[0]);
  for (const match of text.matchAll(/(?:全部|所有|任何|大多数|部分|可能|必然|首次|至少|至多|超过|低于)/g)) values.add(match[0]);
  return [...values].slice(0, 8);
}

export function buildFallbackArgumentMap(text: string, claimType: ClaimType): ArgumentMap {
  const argumentType = inferArgumentType(claimType, text);
  return {
    issue: `现有证据是否足以接受“${text}”这一结论？`,
    issueType: issueTypeFor(argumentType),
    conclusion: text,
    argumentType,
    statedPremises: [],
    implicitAssumptions: fallbackAssumptions(argumentType),
    ambiguousTerms: [],
    qualifiers: extractQualifiers(text),
  };
}

export function buildFallbackAdversarialPlan(argumentMap: ArgumentMap): AdversarialPlan {
  const typeSpecific: Partial<Record<ArgumentType, string>> = {
    causal: "即使现象同时发生，也可能由共同原因、时间趋势或选择偏差造成。",
    statistical: "数字可能因样本、分母、基准值或时间窗口不同而呈现相反印象。",
    generalization: "现有个案或样本可能不具代表性，反例会削弱整体结论。",
    authority: "专家身份不能替代可核验依据，还需确认专业匹配、共识与利益冲突。",
    analogy: "关键差异可能比表面相似更能决定结论。",
    deductive: "即使前提为真，结论也可能因量词、条件或推理形式变化而不成立。",
    policy: "同一目标可能存在副作用更小或成本更低的替代方案。",
  };
  return {
    strongestCounterargument: typeSpecific[argumentMap.argumentType] ?? "当前材料可能只陈述了结论，尚未给出足以排除反例的理由。",
    alternativeExplanations: [],
    missingInformation: ["能够直接检验核心结论的一手材料或原始数据。"],
    falsificationQueries: [],
  };
}

export function buildFallbackCriticalQuestions(argumentMap: ArgumentMap): CriticalQuestion[] {
  const questions = [
    "结论所依赖的事实前提是否有可核验的一手证据？",
    "关键用词、主体、时间和统计口径是否保持一致？",
    "即使前提为真，它是否足以推出当前结论？",
    "是否存在尚未检验的反例、替代原因或遗漏信息？",
  ];
  const typeSpecific: Partial<Record<ArgumentType, string>> = {
    causal: "是否排除了共同原因、反向因果和同期趋势？",
    statistical: "样本、分母、基准值、误差范围和时间窗口是什么？",
    generalization: "样本是否足够且能代表结论覆盖的整体？",
    authority: "被引用者的专业是否匹配，并给出了可复核依据吗？",
    analogy: "两个对象在决定结论的关键属性上真的相似吗？",
    deductive: "推理形式有效吗，量词或条件是否在推导中发生变化？",
    policy: "目标、替代方案、代价、副作用和价值冲突是否都被比较？",
  };
  if (typeSpecific[argumentMap.argumentType]) questions.push(typeSpecific[argumentMap.argumentType]!);
  return questions.map((question) => ({
    question,
    status: "open",
    answer: "规则模式无法独立回答，需要结合原文证据与人工复核。",
    evidenceIds: [],
  }));
}

function statusForScore(score: number): AuditStatus {
  if (score >= 0.72) return "strong";
  if (score >= 0.45) return "mixed";
  if (score > 0.12) return "weak";
  return "unknown";
}

function dimension(score: number, explanation: string): AuditDimension {
  const bounded = Math.max(0, Math.min(1, score));
  return { score: bounded, status: statusForScore(bounded), explanation };
}

export function buildFallbackReasoningScorecard(evidence: EvidenceItem[]): ReasoningScorecard {
  const readable = evidence.filter((item) => item.quoteType === "page");
  const relevant = readable.filter((item) => item.relevance >= 0.28);
  const independent = new Set(relevant.map((item) => domainGroup(item.domain))).size;
  const qualityAverage = relevant.length
    ? relevant.reduce((sum, item) => sum + item.quality.score / 100, 0) / relevant.length
    : 0;
  const relevanceAverage = relevant.length
    ? relevant.reduce((sum, item) => sum + item.relevance, 0) / relevant.length
    : 0;
  const independenceScore = independent >= 3 ? 0.86 : independent === 2 ? 0.68 : independent === 1 ? 0.34 : 0;
  const coverageScore = relevant.length >= 4 ? 0.82 : relevant.length >= 2 ? 0.62 : relevant.length === 1 ? 0.32 : 0;

  return {
    premiseReliability: dimension(qualityAverage * 0.75, relevant.length ? "按已读取来源质量估计；规则模式无法确认全部前提。" : "尚未取得可核验的原文前提。"),
    evidenceRelevance: dimension(relevanceAverage, relevant.length ? "按来源片段与主张的文本相关度估计，尚未完成语义蕴含判断。" : "尚未取得与主张直接相关的原文。"),
    inferenceStrength: dimension(0, "规则模式无法判断前提是否足以推出结论。"),
    evidenceCoverage: dimension(coverageScore, relevant.length ? `取得 ${relevant.length} 条相关原文，仍需检查是否遗漏关键反证。` : "当前证据未覆盖核心结论。"),
    sourceIndependence: dimension(independenceScore, independent ? `当前相关原文来自 ${independent} 个独立域名组。` : "尚无可计算独立性的相关原文。"),
  };
}

function capDimension(value: AuditDimension, maximum: number, guardExplanation?: string): AuditDimension {
  const score = Math.max(0, Math.min(maximum, value.score));
  return {
    score,
    status: statusForScore(score),
    explanation: value.score > maximum && guardExplanation ? `${value.explanation} ${guardExplanation}`.trim() : value.explanation,
  };
}

export interface ReasoningAuditInput {
  scorecard: ReasoningScorecard;
  fallacyFindings: FallacyFinding[];
  alternativeExplanations: AlternativeExplanation[];
  criticalQuestions: CriticalQuestion[];
  whatWouldChangeMind: string[];
}

export function detectStructuralFallacies(seed: ClaimSeed): FallacyFinding[] {
  const map = seed.argumentMap ?? buildFallbackArgumentMap(seed.text, seed.claimType);
  const premiseText = map.statedPremises.join(" ");
  const conclusion = map.conclusion;
  const findings: FallacyFinding[] = [];
  const hasAssociationPremise = /(?:之后|以后|随后|同时|相关|伴随|上升|下降|增加|减少)/.test(premiseText);

  if (map.argumentType === "causal" && hasAssociationPremise && /(?:导致|造成|原因|归因于|使得)/.test(conclusion)) {
    const exclusive = /(?:唯一原因|完全由|仅由|必然导致)/.test(conclusion);
    findings.push({
      code: exclusive ? "causal_oversimplification" : "correlation_causation",
      label: exclusive ? "疑似把复杂结果归为单一原因" : "疑似由相关性跳到因果性",
      confidence: exclusive ? 0.68 : 0.58,
      severity: exclusive ? "high" : "medium",
      scope: conclusion,
      explanation: exclusive
        ? "现有理由只呈现时间或统计关联，却把结果完全归结为一个因素，尚未排除其他原因。"
        : "现有理由呈现了共同变化或先后顺序，但这本身不足以证明因果方向和作用机制。",
      impact: "如果替代原因、反向因果或同期趋势成立，当前因果结论会明显减弱。",
      repair: "补充有对照的研究设计、机制证据，并系统检验主要混杂因素和替代原因。",
      evidenceIds: [],
    });
  }

  const universal = /(?:所有人|所有情况|任何人|无一例外|必然会|总是)/.test(conclusion);
  const limitedPremise = /(?:某研究|样本|部分|一些|观察|调查|个案|平均)/.test(premiseText);
  if (universal && limitedPremise) {
    findings.push({
      code: "hasty_generalization",
      label: "疑似从有限观察过度概括",
      confidence: 0.66,
      severity: "high",
      scope: conclusion,
      explanation: "前提只覆盖特定研究、样本或平均趋势，结论却扩展到所有人或所有情况。",
      impact: "样本外人群、反例或个体差异足以推翻绝对化结论。",
      repair: "明确适用人群和边界，报告样本代表性、效应差异与反例，并降低绝对措辞。",
      evidenceIds: [],
    });
  }

  if (/(?:要么.{1,80}要么|不是.{1,80}就是)/.test(conclusion)) {
    findings.push({
      code: "false_dilemma",
      label: "疑似假两难",
      confidence: 0.62,
      severity: "medium",
      scope: conclusion,
      explanation: "结论只保留两个选项，但尚未证明其他可能性都不存在。",
      impact: "被遗漏的第三种方案可能改变比较结果。",
      repair: "列出可行替代选项，并说明为何能够合理排除它们。",
      evidenceIds: [],
    });
  }
  return findings;
}

export function guardReasoningAudit(
  audit: ReasoningAuditInput,
  seed: ClaimSeed,
  evidence: EvidenceItem[],
  verdict: Verdict,
): ReasoningAuditInput {
  const validIds = new Set(evidence.map((item) => item.id));
  const readable = evidence.filter((item) => item.quoteType === "page" && item.relevance >= 0.28);
  const independentCount = new Set(readable.map((item) => domainGroup(item.domain))).size;
  const independenceCap = independentCount >= 3 ? 0.9 : independentCount === 2 ? 0.72 : independentCount === 1 ? 0.38 : 0.08;
  const coverageCap = readable.length >= 5 ? 0.9 : readable.length >= 3 ? 0.76 : readable.length === 2 ? 0.62 : readable.length === 1 ? 0.38 : 0.08;
  const premiseCap = readable.some((item) => item.quality.score >= 76) ? 0.9 : readable.length ? 0.68 : 0.12;
  const relevanceCap = readable.length ? Math.min(0.92, Math.max(...readable.map((item) => item.relevance)) + 0.16) : 0.12;
  const inferenceCap = ["insufficient", "unknown"].includes(verdict) ? 0.58 : 0.9;
  const argumentText = [seed.text, ...(seed.argumentMap?.statedPremises ?? []), ...(seed.argumentMap?.implicitAssumptions ?? [])].join("\n");
  const fallacyCandidates = [...audit.fallacyFindings, ...detectStructuralFallacies(seed)];
  const uniqueFallacies = [...new Map(fallacyCandidates.map((finding) => [`${finding.code}:${finding.scope}`, finding])).values()];

  return {
    scorecard: {
      premiseReliability: capDimension(audit.scorecard.premiseReliability, premiseCap, "已按实际取得的原文与来源质量下调。"),
      evidenceRelevance: capDimension(audit.scorecard.evidenceRelevance, relevanceCap, "已按实际文本相关度下调。"),
      inferenceStrength: capDimension(audit.scorecard.inferenceStrength, inferenceCap, "当前结论仍有未解决的证据缺口。"),
      evidenceCoverage: capDimension(audit.scorecard.evidenceCoverage, coverageCap, "已按可读证据数量下调。"),
      sourceIndependence: capDimension(audit.scorecard.sourceIndependence, independenceCap, "已按独立域名组数量下调。"),
    },
    fallacyFindings: uniqueFallacies
      .filter((finding) => finding.scope.length >= 2 && argumentText.includes(finding.scope))
      .map((finding) => ({
        ...finding,
        confidence: Math.min(0.8, finding.confidence),
        evidenceIds: finding.evidenceIds.filter((id) => validIds.has(id)),
      }))
      .slice(0, 4),
    alternativeExplanations: audit.alternativeExplanations.map((alternative) => ({
      ...alternative,
      evidenceIds: alternative.evidenceIds.filter((id) => validIds.has(id)),
    })).slice(0, 4),
    criticalQuestions: audit.criticalQuestions.map((question) => ({
      ...question,
      evidenceIds: question.evidenceIds.filter((id) => validIds.has(id)),
    })).slice(0, 8),
    whatWouldChangeMind: [...new Set(audit.whatWouldChangeMind.map((item) => item.trim()).filter(Boolean))].slice(0, 5),
  };
}
