import type {
  ClaimSeed,
  EvidenceItem,
  EvidenceRelation,
  SourceCategory,
  SourceQuality,
  Verdict,
} from "../../shared/types";

const HIGH_AUTHORITY_DOMAINS: Array<[RegExp, string, number]> = [
  [/(?:^|\.)gov\.cn$/i, "政府或公共机构网站", 94],
  [/(?:^|\.)gov$/i, "政府机构网站", 92],
  [/(?:^|\.)xinhua(?:net)?\.com$/i, "中央新闻机构", 89],
  [/(?:^|\.)news\.cn$/i, "中央新闻机构", 89],
  [/(?:^|\.)people\.com\.cn$/i, "中央新闻机构", 87],
  [/(?:^|\.)cctv\.com$/i, "中央新闻机构", 86],
  [/(?:^|\.)cas\.cn$/i, "科研机构", 88],
  [/(?:^|\.)who\.int$/i, "国际公共机构", 92],
  [/(?:^|\.)(?:reuters\.com|apnews\.com)$/i, "国际权威通讯社", 86],
  [/(?:^|\.)bbc\.(?:com|co\.uk)$/i, "国际权威新闻机构", 84],
  [/(?:^|\.)(?:pubmed\.ncbi\.nlm\.nih\.gov|nature\.com|science\.org|aclanthology\.org)$/i, "学术出版或索引平台", 82],
];

const SOCIAL_DOMAINS = /(?:weibo\.com|douyin\.com|kuaishou\.com|xiaohongshu\.com|zhihu\.com|bilibili\.com)$/i;
const AGGREGATOR_DOMAINS = /(?:baijiahao\.baidu\.com|sohu\.com|163\.com|toutiao\.com|qq\.com)$/i;
const STRONG_NEGATIONS = /(?:并非|不是|没有|否认|不实|虚假|谣言|错误|不存在|未曾|尚未|未能|未发生)/;
const INJECTION_PATTERNS = /(?:ignore (?:all |the )?(?:previous|prior) instructions|system prompt|you are chatgpt|assistant must|忽略.{0,8}(?:指令|提示)|系统提示词|执行.{0,10}(?:命令|工具))/i;

const STOP_WORDS = new Set([
  "这个", "那个", "一个", "已经", "目前", "近日", "今天", "消息", "表示", "称", "的是",
  "以及", "并且", "因为", "所以", "可能", "网传", "据说", "相关", "进行", "关于", "其中",
]);

export function domainGroup(domain: string): string {
  const parts = domain.replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const cnSecondLevels = new Set(["com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn"]);
  const tail2 = parts.slice(-2).join(".");
  return cnSecondLevels.has(tail2) ? parts.slice(-3).join(".") : tail2;
}

export function tokenize(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/https?:\/\/\S+/g, " ");
  const result = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]{1,30}/g)) result.add(match[0]);
  for (const block of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const word of block.match(/[\u4e00-\u9fff]{2,8}/g) ?? []) {
      if (!STOP_WORDS.has(word) && word.length <= 4) result.add(word);
    }
    for (let i = 0; i < block.length - 1; i += 1) {
      const gram = block.slice(i, i + 2);
      if (!STOP_WORDS.has(gram)) result.add(gram);
    }
  }
  return result;
}

export function relevanceScore(claim: string, candidate: string): number {
  const claimTokens = tokenize(claim);
  const candidateTokens = tokenize(candidate);
  if (!claimTokens.size || !candidateTokens.size) return 0;
  let shared = 0;
  for (const token of claimTokens) if (candidateTokens.has(token)) shared += token.length > 2 ? 1.3 : 1;
  return Math.min(1, shared / Math.max(4, claimTokens.size * 0.52));
}

export function scoreSource(
  domain: string,
  quoteType: EvidenceItem["quoteType"],
): SourceQuality & { sourceKind: string; sourceCategory: SourceCategory } {
  let score = 58;
  let sourceKind = "一般网页";
  let sourceCategory: SourceCategory = "general_web";
  const reasons: string[] = [];

  const authority = HIGH_AUTHORITY_DOMAINS.find(([pattern]) => pattern.test(domain));
  if (authority) {
    sourceKind = authority[1];
    score = authority[2];
    reasons.push(authority[1]);
    if (/学术/.test(authority[1])) sourceCategory = "academic_paper";
    else if (/新闻|通讯社/.test(authority[1])) sourceCategory = "authoritative_news";
    else sourceCategory = "official_record";
  } else if (/\.edu(?:\.cn)?$/i.test(domain)) {
    sourceKind = "教育机构";
    score = 80;
    reasons.push("教育机构域名");
    sourceCategory = "academic_index";
  } else if (SOCIAL_DOMAINS.test(domain)) {
    sourceKind = "社交或内容平台";
    score = 36;
    reasons.push("用户生成内容，需追溯原始出处");
    sourceCategory = "social";
  } else if (AGGREGATOR_DOMAINS.test(domain)) {
    sourceKind = "门户或聚合平台";
    score = 51;
    reasons.push("可能包含转载内容");
    sourceCategory = "aggregator";
  } else {
    reasons.push("尚未验证发布主体");
  }

  if (quoteType === "search_snippet") {
    score -= 16;
    reasons.push("仅获得搜索摘要，未读取原文");
  } else if (quoteType === "metadata") {
    score -= 12;
    reasons.push("只有书目信息，未取得摘要或正文");
  } else if (quoteType === "abstract") {
    score -= 3;
    reasons.push("已取得论文摘要，尚未核对全文方法与结果");
  } else {
    reasons.push("已读取来源页面片段");
  }

  const bounded = Math.max(10, Math.min(98, score));
  return {
    score: bounded,
    label: bounded >= 76 ? "较高" : bounded >= 50 ? "一般" : "较低",
    reasons,
    sourceKind,
    sourceCategory,
  };
}

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.test(text);
}

export function inferRelation(claim: string, passage: string, relevance: number): EvidenceRelation {
  if (relevance < 0.22) return "related";
  const claimIsNegative = STRONG_NEGATIONS.test(claim);
  const relevantFragments = passage
    .split(/[。！？!?；;]/)
    .filter((fragment) => relevanceScore(claim, fragment) >= 0.32);
  const passageIsNegative = relevantFragments.some((fragment) => STRONG_NEGATIONS.test(fragment));
  if (relevance >= 0.42 && claimIsNegative !== passageIsNegative) return "counter_signal";
  return relevance >= 0.38 ? "supporting_context" : "related";
}

export function inferVerdict(evidence: EvidenceItem[]): {
  verdict: Verdict;
  label: string;
  confidence: number;
  unknowns: string[];
} {
  const readable = evidence.filter((item) => item.quoteType === "page" && item.relevance >= 0.28);
  const supporting = readable.filter((item) => item.relation === "supporting_context" && item.quality.score >= 64);
  const counter = readable.filter((item) => item.relation === "counter_signal");
  const supportDomains = new Set(supporting.map((item) => domainGroup(item.domain)));
  const counterDomains = new Set(counter.map((item) => domainGroup(item.domain)));

  if (!evidence.length) {
    return {
      verdict: "unknown",
      label: "未找到可用证据",
      confidence: 0.12,
      unknowns: ["公开搜索未返回可用结果；不能据此判断主张真假。"],
    };
  }

  if (counterDomains.size > 0 && supportDomains.size > 0) {
    return {
      verdict: "disputed",
      label: "发现相互冲突的线索",
      confidence: 0.48,
      unknowns: ["支持与反向线索并存，需要追溯各方的一手材料。"],
    };
  }

  if (supportDomains.size >= 2 && supporting.some((item) => item.quality.score >= 76)) {
    const average = supporting.reduce((sum, item) => sum + item.relevance, 0) / supporting.length;
    return {
      verdict: "supported",
      label: "初步有依据",
      confidence: Math.min(0.78, 0.58 + average * 0.2),
      unknowns: ["当前为单轮检索结果，仍需确认来源是否真正独立及是否存在遗漏上下文。"],
    };
  }

  return {
    verdict: "insufficient",
    label: "证据不足",
    confidence: Math.min(0.46, 0.2 + readable.length * 0.07),
    unknowns: [
      readable.length
        ? "已找到相关页面，但尚不足以形成两个独立、可靠来源的交叉验证。"
        : "结果仅含搜索摘要或低相关页面，尚未取得可核对的原文片段。",
    ],
  };
}

export function buildWarnings(claim: ClaimSeed, evidence: EvidenceItem[]): string[] {
  const warnings: string[] = [];
  const hasFreshnessLanguage = /(?:刚刚|今天|昨日|近日|最近|最新|突发|目前)/.test(claim.text);
  const dated = evidence
    .map((item) => item.publishedAt)
    .filter((date): date is string => Boolean(date))
    .map((date) => new Date(date))
    .filter((date) => !Number.isNaN(date.getTime()));

  if (hasFreshnessLanguage && dated.length) {
    const newest = Math.max(...dated.map((date) => date.getTime()));
    const ageDays = (Date.now() - newest) / 86_400_000;
    if (ageDays > 365) warnings.push("主张使用了近期措辞，但检索到的材料已超过一年，存在旧闻翻炒风险。");
  }

  if (evidence.some((item) => item.promptInjectionIgnored)) {
    warnings.push("来源页含疑似面向 Agent 的指令文本；系统已将其视为不可信内容并忽略。");
  }
  if (evidence.length > 1 && new Set(evidence.map((item) => domainGroup(item.domain))).size === 1) {
    warnings.push("多条结果来自同一站点，不能视作独立交叉验证。");
  }
  if (evidence.some((item) => item.quoteType === "search_snippet")) {
    warnings.push("部分来源未能读取原文，仅展示搜索摘要；摘要不能单独支撑重要结论。");
  }

  const claimDates = [...claim.text.matchAll(/(20\d{2})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日/g)]
    .map((match) => `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);
  if (claimDates.length) {
    const claimMonthDays = new Set(claimDates.map((date) => date.slice(5)));
    const conflictingDates = evidence
      .filter((item) => item.quoteType === "page" && item.relevance >= 0.35)
      .flatMap((item) => [...`${item.title} ${item.quote}`.matchAll(/(20\d{2})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日/g)])
      .map((match) => `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`)
      .filter((date) => claimMonthDays.has(date.slice(5)) && !claimDates.includes(date));
    if (conflictingDates.length) {
      warnings.push(`主张日期与来源片段出现直接冲突（来源出现 ${[...new Set(conflictingDates)].join("、")}），不能仅凭关键词重合判为支持。`);
    }
  }
  return warnings;
}
