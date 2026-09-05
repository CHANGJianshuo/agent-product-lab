import type { ClaimSeed, EvidenceItem, SpecialistReview } from "../../shared/types";
import { evidenceRankValue, isInspectableEvidence } from "./trust";

const HIGH_STAKES = /(?:健康|医疗|疾病|药物|治疗|诊断|疫苗|死亡|安全|有毒|致癌|认知|心血管|血压|营养|补充剂|法律|违法|投资|理财|借贷|保险|health|medical|disease|drug|treatment|diagnos|vaccine|death|safety|cancer|cognition|cardiovascular|supplement|legal|invest)/i;

function routeCompatible(seed: ClaimSeed, item: EvidenceItem): boolean {
  const route = seed.routePlan?.primaryRoute ?? "event_fact";
  const category = item.sourceCategory ?? "general_web";
  if (route === "scientific") return ["systematic_review", "academic_paper", "academic_index", "official_statistics"].includes(category);
  if (route === "statistics") return ["official_statistics", "systematic_review", "academic_paper", "official_record"].includes(category);
  if (route === "official_record" || route === "legal_policy") return ["official_record", "official_statistics", "authoritative_news"].includes(category);
  if (route === "event_fact") return ["official_record", "authoritative_news", "news"].includes(category);
  return true;
}

export function selectEvidenceForIndependentReview(
  seed: ClaimSeed,
  evidence: EvidenceItem[],
  limit = 8,
): EvidenceItem[] {
  return evidence
    .filter((item) => isInspectableEvidence(item)
      && (item.relevance >= 0.12 || routeCompatible(seed, item))
      && (item.trust?.overall ?? item.quality.score / 100) >= 0.32)
    .sort((left, right) => evidenceRankValue(right) - evidenceRankValue(left))
    .slice(0, limit);
}

export function componentAttributionLimit(seed: ClaimSeed, item: EvidenceItem): number | null {
  if (!/(?:\bDHA\b|二十二碳六烯酸)/i.test(seed.text)) return null;
  const title = item.title.replace(/\s+/g, " ");
  const explicitlyMixed = /(?:fish[- ]?oil|omega[- ]?3 fatty acids?|n\s*[-–]?\s*3(?:\s+long-chain)?\s+polyunsaturated fatty acid|combined with|combination with|plus strength training|EPA.{0,30}(?:and|&|\+).{0,30}DHA|DHA.{0,30}(?:and|&|\+).{0,30}EPA)/i.test(title);
  const explicitlyDhaFocused = /(?:DHA[- ]rich|DHA supplementation|docosahexaenoic acid supplementation|effects? of (?:the )?docosahexaenoic acid)/i.test(title);
  return explicitlyMixed && !explicitlyDhaFocused ? 0.45 : null;
}

export interface FalsificationDecision {
  required: boolean;
  reasons: string[];
}

export function decideFalsification(
  seed: ClaimSeed,
  evidence: EvidenceItem[],
  qualityReview?: SpecialistReview,
): FalsificationDecision {
  const matched = evidence.filter((item) =>
    isInspectableEvidence(item)
      && ["direct", "indirect"].includes(item.evidenceRole ?? "")
      && (item.directness ?? 0) >= 0.35,
  );
  if (!matched.length) return { required: false, reasons: [] };

  const directional = matched.filter((item) =>
    ["supporting_context", "counter_signal"].includes(item.relation)
      && (item.directness ?? 0) >= 0.45,
  );
  const supports = directional.filter((item) => item.relation === "supporting_context").length;
  const refutes = directional.filter((item) => item.relation === "counter_signal").length;
  const oneSided = directional.length >= 2 && (supports === 0 || refutes === 0);
  const highStakes = HIGH_STAKES.test(`${seed.text} ${seed.argumentMap?.issue ?? ""}`);
  const matcherAverage = matched.reduce((sum, item) => sum + (item.directness ?? 0), 0) / matched.length;
  const qualityDirectness = qualityReview?.directness.status === "unknown"
    ? null
    : qualityReview?.directness.score ?? null;
  const verifierDisagreement = qualityDirectness !== null
    && ((matcherAverage >= 0.62 && qualityDirectness <= 0.35)
      || (matcherAverage <= 0.35 && qualityDirectness >= 0.68));
  const weakIntegrity = matched.length >= 2
    && qualityReview?.sourceIntegrity.status === "weak";

  const reasons: string[] = [];
  if (highStakes && directional.length >= 1) reasons.push("高风险主张已有方向性证据");
  if (oneSided) reasons.push("当前直接证据明显单边");
  if (verifierDisagreement) reasons.push("命题匹配与质量审查存在明显分歧");
  if (weakIntegrity) reasons.push("可追溯性或来源完整性偏弱");
  return { required: reasons.length > 0, reasons };
}
