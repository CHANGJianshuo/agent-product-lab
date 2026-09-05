import { createHash } from "node:crypto";
import type {
  ClaimRoutePlan,
  EvidenceItem,
  EvidenceRoute,
  SourceCategory,
  TrustProfile,
} from "../../shared/types";
import { domainGroup, tokenize } from "./evidence";

const CATEGORY_PRIOR: Record<SourceCategory, number> = {
  systematic_review: 0.88,
  academic_paper: 0.75,
  academic_index: 0.58,
  official_record: 0.84,
  official_statistics: 0.88,
  authoritative_news: 0.78,
  news: 0.62,
  aggregator: 0.38,
  social: 0.28,
  general_web: 0.45,
};

const PRIMARYNESS: Record<SourceCategory, number> = {
  systematic_review: 0.78,
  academic_paper: 0.92,
  academic_index: 0.5,
  official_record: 0.96,
  official_statistics: 0.96,
  authoritative_news: 0.74,
  news: 0.62,
  aggregator: 0.28,
  social: 0.24,
  general_web: 0.38,
};

const ROUTE_FIT: Record<EvidenceRoute, Partial<Record<SourceCategory, number>>> = {
  scientific: {
    systematic_review: 0.98,
    academic_paper: 0.92,
    academic_index: 0.64,
    official_statistics: 0.76,
    official_record: 0.58,
    authoritative_news: 0.38,
    news: 0.28,
  },
  event_fact: {
    official_record: 0.96,
    authoritative_news: 0.9,
    news: 0.7,
    official_statistics: 0.68,
    academic_paper: 0.42,
    aggregator: 0.34,
  },
  official_record: {
    official_record: 0.99,
    official_statistics: 0.88,
    authoritative_news: 0.74,
    news: 0.56,
    academic_paper: 0.4,
  },
  statistics: {
    official_statistics: 0.99,
    academic_paper: 0.86,
    systematic_review: 0.82,
    official_record: 0.78,
    authoritative_news: 0.5,
    academic_index: 0.58,
  },
  legal_policy: {
    official_record: 0.99,
    authoritative_news: 0.7,
    academic_paper: 0.68,
    news: 0.52,
    aggregator: 0.25,
  },
  conceptual: {
    academic_paper: 0.78,
    systematic_review: 0.8,
    official_statistics: 0.76,
    official_record: 0.7,
    authoritative_news: 0.68,
    news: 0.5,
  },
  normative: {
    systematic_review: 0.76,
    academic_paper: 0.76,
    official_statistics: 0.78,
    official_record: 0.74,
    authoritative_news: 0.62,
  },
};

const OFFICIAL_STATS = /(?:stats\.gov|data\.gov|census\.gov|bls\.gov|bea\.gov|oecd\.org|worldbank\.org|data\.un\.org|ec\.europa\.eu\/eurostat)/i;
const OFFICIAL = /(?:\.gov(?:\.|$)|gov\.cn$|who\.int$|un\.org$|europa\.eu$|court|regulator|sec\.gov$)/i;
const ACADEMIC = /(?:pubmed|ncbi\.nlm\.nih\.gov|nature\.com|science\.org|sciencedirect|springer|wiley|tandfonline|jstor|doi\.org|arxiv|openalex|aclanthology|ieee|acm\.org)/i;
const AUTHORITATIVE_NEWS = /(?:reuters\.com|apnews\.com|bbc\.|xinhua|news\.cn|people\.com\.cn|cctv\.com|theguardian\.com|nytimes\.com|washingtonpost\.com|ft\.com|economist\.com)/i;
const NEWS = /(?:news|daily|times|post|journal|电视台|日报|晚报|新闻网)/i;
const AGGREGATOR = /(?:baijiahao\.baidu\.com|sohu\.com|163\.com|toutiao\.com|qq\.com)/i;
const SOCIAL = /(?:weibo\.com|douyin\.com|kuaishou\.com|xiaohongshu\.com|zhihu\.com|bilibili\.com|facebook\.com|x\.com|twitter\.com|reddit\.com)/i;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function inferSourceCategory(item: Pick<EvidenceItem, "domain" | "title" | "sourceKind">): SourceCategory {
  const haystack = `${item.domain} ${item.title} ${item.sourceKind}`;
  if (/系统综述|荟萃分析|systematic review|meta-analysis/i.test(haystack)) return "systematic_review";
  if (OFFICIAL_STATS.test(haystack) || /统计机构|原始统计/.test(item.sourceKind)) return "official_statistics";
  if (/学术索引/.test(item.sourceKind)) return "academic_index";
  if (ACADEMIC.test(haystack) || /同行评议|学术研究/.test(item.sourceKind)) return "academic_paper";
  if (OFFICIAL.test(haystack) || /政府|公共机构|官方记录/.test(item.sourceKind)) return "official_record";
  if (AUTHORITATIVE_NEWS.test(haystack) || /中央新闻机构|权威媒体/.test(item.sourceKind)) return "authoritative_news";
  if (SOCIAL.test(item.domain) || /社交|用户生成/.test(item.sourceKind)) return "social";
  if (AGGREGATOR.test(item.domain) || /聚合|门户/.test(item.sourceKind)) return "aggregator";
  if (NEWS.test(haystack) || /新闻媒体/.test(item.sourceKind)) return "news";
  return "general_web";
}

function wireAttribution(item: EvidenceItem): string | null {
  const text = `${item.title} ${item.quote}`;
  const wires: Array<[RegExp, string]> = [
    [/(?:Reuters|路透社|路透)/i, "reuters"],
    [/(?:Associated Press|美联社|\bAP\b)/i, "ap"],
    [/(?:新华社|Xinhua)/i, "xinhua"],
    [/(?:中国新闻社|中新社)/i, "chinanews"],
    [/(?:Agence France-Presse|法新社|\bAFP\b)/i, "afp"],
  ];
  return wires.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|spm|from|source|ref)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return value;
  }
}

function provenanceGroups(items: EvidenceItem[]): string[] {
  const parent = items.map((_, index) => index);
  const find = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const union = (left: number, right: number) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) parent[rootRight] = rootLeft;
  };
  const tokens = items.map((item) => tokenize(`${item.title} ${item.quote}`));
  const urls = items.map((item) => canonicalUrl(item.url));
  const wires = items.map(wireAttribution);
  const isIndexDomain = (domain: string) => /(?:^|\.)(?:pubmed\.ncbi\.nlm\.nih\.gov|openalex\.org|doi\.org)$/i.test(domain);

  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const sameDoi = Boolean(items[left].doi && items[left].doi === items[right].doi);
      const sameUrl = urls[left] === urls[right];
      const samePublisher = !isIndexDomain(items[left].domain)
        && !isIndexDomain(items[right].domain)
        && domainGroup(items[left].domain) === domainGroup(items[right].domain);
      const sameWire = Boolean(wires[left] && wires[left] === wires[right]);
      const nearDuplicate = jaccard(tokens[left], tokens[right]) >= 0.76;
      if (sameDoi || sameUrl || samePublisher || sameWire || nearDuplicate) union(left, right);
    }
  }

  const memberKeys = new Map<number, string[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const values = memberKeys.get(root) ?? [];
    values.push(item.doi ?? wires[index] ?? urls[index] ?? item.domain);
    memberKeys.set(root, values);
  });
  const names = new Map<number, string>();
  for (const [root, values] of memberKeys) {
    const digest = createHash("sha1").update(values.sort().join("|")).digest("hex").slice(0, 10);
    names.set(root, `prov-${digest}`);
  }
  return items.map((_, index) => names.get(find(index))!);
}

function freshnessScore(item: EvidenceItem, route: EvidenceRoute, required: boolean): number {
  if (!item.publishedAt) return required ? 0.42 : 0.62;
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return required ? 0.42 : 0.62;
  const ageDays = Math.max(0, (Date.now() - published) / 86_400_000);
  if (route === "event_fact" || route === "official_record" || route === "legal_policy") {
    if (ageDays <= 45) return 0.96;
    if (ageDays <= 365) return 0.84;
    if (ageDays <= 1_825) return required ? 0.48 : 0.7;
    return required ? 0.24 : 0.54;
  }
  if (route === "scientific" || route === "statistics") {
    if (ageDays <= 1_825) return 0.9;
    if (ageDays <= 3_650) return 0.75;
    return 0.56;
  }
  return 0.74;
}

function trustFor(
  item: EvidenceItem,
  plan: ClaimRoutePlan,
  category: SourceCategory,
  independence: number,
): TrustProfile {
  const sourcePrior = CATEGORY_PRIOR[category];
  const routeFit = ROUTE_FIT[plan.primaryRoute][category] ?? 0.38;
  const primaryness = PRIMARYNESS[category];
  const freshness = freshnessScore(item, plan.primaryRoute, plan.freshnessRequired);
  const readablePenalty = item.quoteType === "search_snippet" ? 0.16 : item.quoteType === "metadata" ? 0.12 : 0;
  const overall = clamp(
    sourcePrior * 0.27
      + routeFit * 0.28
      + primaryness * 0.2
      + freshness * 0.12
      + independence * 0.13
      - readablePenalty,
  );
  const reasons = [
    `来源类别：${category}`,
    `与${plan.primaryRoute}路线适配度 ${Math.round(routeFit * 100)}%`,
    independence < 0.7 ? "与其他结果存在同站、转载或共同稿源风险" : "本轮未发现明显同源复制",
    item.quoteType === "search_snippet" ? "只获得搜索摘要" : item.quoteType === "metadata" ? "只有书目信息，未取得摘要或正文" : "取得可核对内容",
  ];
  return {
    overall,
    sourcePrior,
    routeFit,
    primaryness,
    freshness,
    independence,
    label: overall >= 0.74 ? "较高" : overall >= 0.5 ? "一般" : "较低",
    reasons,
    model: "rules-v1",
  };
}

export function enrichEvidenceTrust(items: EvidenceItem[], plan: ClaimRoutePlan): EvidenceItem[] {
  if (!items.length) return [];
  const groups = provenanceGroups(items);
  const sizes = new Map<string, number>();
  for (const group of groups) sizes.set(group, (sizes.get(group) ?? 0) + 1);
  return items.map((item, index) => {
    const sourceCategory = item.sourceCategory ?? inferSourceCategory(item);
    const group = groups[index];
    const independence = (sizes.get(group) ?? 1) > 1 ? 0.48 : 0.92;
    return {
      ...item,
      sourceCategory,
      provenanceGroup: group,
      trust: trustFor(item, plan, sourceCategory, independence),
    };
  });
}

export function evidenceRankValue(item: EvidenceItem): number {
  const readable = item.quoteType === "page" || item.quoteType === "abstract" ? 0.12 : 0;
  return (item.directness ?? item.relevance) * 0.34
    + (item.routeFit ?? item.trust?.routeFit ?? 0.4) * 0.2
    + (item.trust?.overall ?? item.quality.score / 100) * 0.3
    + item.relevance * 0.16
    + readable;
}

export function isInspectableEvidence(item: EvidenceItem): boolean {
  return item.quoteType === "page" || item.quoteType === "abstract";
}

export function independentGroup(item: EvidenceItem): string {
  return item.provenanceGroup ?? domainGroup(item.domain);
}
