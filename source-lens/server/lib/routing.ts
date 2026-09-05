import type {
  ArgumentType,
  ClaimRoutePlan,
  ClaimSeed,
  ClaimType,
  EvidenceRoute,
  QuestionProfile,
} from "../../shared/types";

const SCIENCE = /(?:研究|论文|科学|临床|随机|队列|实验|样本|因果|相关性|导致|影响|效果|有效|无效|机制|疾病|健康|药物|治疗|风险因素|死亡率|患病率|摄入|饮用|营养|营养素|补充剂|脂肪酸|鱼油|DHA|EPA|omega[- ]?3|流行病学|study|research|trial|effect|caus|mortality|epidemiolog)/i;
const STATISTICS = /(?:数据|统计|比例|比率|概率|增长率|下降率|平均|中位数|样本|调查|趋势|人均|百分之|%|dataset|statistics|rate|survey)/i;
const LEGAL_POLICY = /(?:法律|法规|法案|条例|判决|法院|监管|行政命令|政策|合法|违法|生效|law|court|regulation|policy)/i;
const OFFICIAL_RECORD = /(?:官方|政府|公告|公报|通报|文件|讲话|原文|会议记录|财报|监管披露|official|filing|transcript|statement)/i;
const EVENT_FACT = /(?:今天|昨日|近日|发生|宣布|发布|回应|证实|否认|逮捕|去世|上任|下台|事故|战争|新闻|消息|报道|announc|report|happen)/i;
const CONCEPTUAL = /(?:所谓|概念|定义|术语|是否存在|存在吗|意味着什么|本质上|斩杀线|definition|concept|really exist)/i;
const NORMATIVE = /(?:应该|不应该|值得|更好|更坏|公平|正义|道德|必须|建议|应当|should|ought|fair)/i;

const PRIORITIES: Record<EvidenceRoute, string[]> = {
  scientific: ["系统综述或荟萃分析", "直接回答命题的同行评议研究", "研究注册与原始数据"],
  event_fact: ["同一事件的一手记录", "独立原创的权威媒体报道", "可核验的现场或当事方材料"],
  official_record: ["主管机构或当事方原始文件", "法规、公告、讲话或记录原文", "独立媒体交叉确认"],
  statistics: ["原始统计机构或数据集", "指标口径与方法说明", "独立复算或同行评议分析"],
  legal_policy: ["现行法条、判决或监管文件", "生效日期与适用辖区", "专业解释与新闻背景"],
  conceptual: ["术语原始语境与可操作定义", "能够检验底层现象的数据", "代表性研究与案例边界"],
  normative: ["可核验的事实前提", "明确表达的价值标准", "替代方案、代价和受影响群体"],
};

export function inferEvidenceRoutes(
  text: string,
  claimType: ClaimType = "other",
  argumentType: ArgumentType = "other",
): EvidenceRoute[] {
  const routes = new Set<EvidenceRoute>();
  if (CONCEPTUAL.test(text)) routes.add("conceptual");
  if (LEGAL_POLICY.test(text) || claimType === "policy" || argumentType === "policy") routes.add("legal_policy");
  if (STATISTICS.test(text) || claimType === "number" || argumentType === "statistical") routes.add("statistics");
  if (SCIENCE.test(text) || claimType === "causal" || argumentType === "causal") routes.add("scientific");
  if (OFFICIAL_RECORD.test(text) || claimType === "quote" || claimType === "identity") routes.add("official_record");
  if (EVENT_FACT.test(text) || claimType === "event" || claimType === "image_context") routes.add("event_fact");
  if (NORMATIVE.test(text)) routes.add("normative");

  if (!routes.size) routes.add("event_fact");
  if (routes.has("conceptual") && /(?:风险|贫困|破产|失业|住房|医疗|债务|阶层|社会)/i.test(text)) {
    routes.add("statistics");
    routes.add("scientific");
  }
  return [...routes];
}

function selectPrimaryRoute(routes: EvidenceRoute[], text: string): EvidenceRoute {
  if (routes.includes("conceptual") && CONCEPTUAL.test(text)) return "conceptual";
  if (routes.includes("legal_policy")) return "legal_policy";
  if (routes.includes("statistics")) return "statistics";
  if (routes.includes("scientific")) return "scientific";
  if (routes.includes("official_record")) return "official_record";
  if (routes.includes("event_fact")) return "event_fact";
  return routes[0] ?? "event_fact";
}

export function buildFallbackRoutePlan(seed: ClaimSeed): ClaimRoutePlan {
  const argumentType = seed.argumentMap?.argumentType ?? "other";
  const routes = inferEvidenceRoutes(seed.text, seed.claimType, argumentType);
  const primaryRoute = selectPrimaryRoute(routes, seed.text);
  return {
    primaryRoute,
    routes,
    rationale: `规则根据主张类型、论证形式和关键词将该主张分配到${routes.join("、")}证据路线。`,
    sourcePriorities: PRIORITIES[primaryRoute],
    freshnessRequired: routes.some((route) => ["event_fact", "official_record", "legal_policy"].includes(route))
      && /(?:今天|昨日|近日|最新|目前|现行|刚刚|突发|将于|本周|本月|今年)/.test(seed.text),
  };
}

export function guardRoutePlan(seed: ClaimSeed, proposed: ClaimRoutePlan): ClaimRoutePlan {
  const fallback = buildFallbackRoutePlan(seed);
  const scientificStatisticsPair = ["scientific", "statistics"].includes(proposed.primaryRoute)
    && ["scientific", "statistics"].includes(fallback.primaryRoute);
  const primaryRoute = fallback.routes.includes(proposed.primaryRoute) || scientificStatisticsPair
    ? proposed.primaryRoute
    : fallback.primaryRoute;
  const routes = [...new Set<EvidenceRoute>([
    primaryRoute,
    ...proposed.routes,
    ...fallback.routes,
  ])];
  return {
    ...proposed,
    primaryRoute,
    routes,
    sourcePriorities: [...new Set([...proposed.sourcePriorities, ...fallback.sourcePriorities])].slice(0, 6),
    freshnessRequired: proposed.freshnessRequired || fallback.freshnessRequired,
  };
}

function ambiguousTerm(text: string): string | null {
  const quoted = text.match(/[“「『"]([^”」』"]{2,18})[”」』"]/u)?.[1]?.trim();
  if (quoted) return quoted;
  if (text.includes("斩杀线")) return "斩杀线";
  const existence = text.match(/(?:所谓)?([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9_-]{1,11})(?:真的)?(?:是否)?存在吗/u)?.[1];
  return existence?.replace(/^(?:美国|中国|社会|网络|网上)/, "") ?? null;
}

function isVagueScientificOutcome(text: string): boolean {
  return SCIENCE.test(text)
    && /(?:有用吗|是否有用|有什么(?:用|作用|好处)|健康(?:效果|作用|益处)|对健康(?:有用|好吗)|(?:有|无|没有)(?:明显)?效(?:果)?|有效吗)/i.test(text)
    && !/(?:认知|记忆|心血管|死亡|中风|血压|血脂|胆固醇|甘油三酯|睡眠|抑郁|焦虑|体重|肥胖|安全性|不良反应)/i.test(text);
}

function scientificOutcomeInterpretations(): QuestionProfile["interpretations"] {
  return [
    {
      id: "interpretation-1",
      label: "功能性结局",
      description: "核查认知、记忆等能够直接测量的功能结局。",
      routes: ["scientific"],
    },
    {
      id: "interpretation-2",
      label: "临床结局",
      description: "核查发病、死亡或心血管事件等临床结局。",
      routes: ["scientific", "statistics"],
    },
    {
      id: "interpretation-3",
      label: "指标与安全性",
      description: "核查血脂等生物指标和不良反应；指标变化不自动等于净健康获益。",
      routes: ["scientific"],
    },
  ];
}

export function buildFallbackQuestionProfile(sourceText: string): QuestionProfile {
  const routes = inferEvidenceRoutes(sourceText);
  const term = ambiguousTerm(sourceText);
  const vagueScientificOutcome = isVagueScientificOutcome(sourceText);
  const material = vagueScientificOutcome
    || Boolean(term)
    || (CONCEPTUAL.test(sourceText) && /[？?]|(?:是否|真的吗|存在吗)/.test(sourceText));
  return {
    summary: sourceText.length > 120 ? `${sourceText.slice(0, 118)}…` : sourceText,
    ambiguityLevel: material ? "material" : "low",
    interpretations: vagueScientificOutcome ? scientificOutcomeInterpretations() : material ? [
      {
        id: "interpretation-1",
        label: "字面或制度含义",
        description: `核查“${term ?? "该说法"}”是否是正式制度、定义或明确记录。`,
        routes: ["conceptual", "official_record"],
      },
      {
        id: "interpretation-2",
        label: "可测量的经验现象",
        description: `把“${term ?? "该说法"}”转化为可观察指标，核查其规模、阈值和适用人群。`,
        routes: ["statistics", "scientific"],
      },
      {
        id: "interpretation-3",
        label: "传播说法的代表性",
        description: "区分个案、新闻叙事与能够代表总体的证据。",
        routes: ["event_fact", "conceptual"],
      },
    ] : [],
    operationalDefinitions: term ? [{
      term,
      definition: `该词尚无用户给出的操作性定义；系统将分别核查其正式含义与可测量的底层现象。`,
      status: "needs_clarification",
    }] : [],
    strategy: material ? "branched" : "direct",
    clarificationQuestion: vagueScientificOutcome
      ? "你关心哪一种具体健康结局？系统将先按功能、临床结局和指标/安全性分别核查。"
      : material ? `你所说的“${term ?? "该概念"}”更接近正式制度，还是一种可测量的社会现象？` : null,
    routes: vagueScientificOutcome
      ? ["scientific", "statistics"]
      : material
      ? [...new Set<EvidenceRoute>([...routes, "conceptual", "statistics", "scientific", "official_record", "event_fact"])]
      : routes,
    rationale: vagueScientificOutcome
      ? "“有效/无效”没有指定结局；功能、临床结局和生物指标可能得到不同答案，因此必须分支核查。"
      : material
      ? "不同解释会改变证据来源和结论，因此自动采用分支核查，不把模糊问题强行压成一个是非题。"
      : "问题含义相对明确，可以直接拆分为可验证主张。",
    profiledBy: "rules",
  };
}

export function guardQuestionProfile(profile: QuestionProfile, sourceText: string): QuestionProfile {
  const fallback = buildFallbackQuestionProfile(sourceText);
  const vagueScientificOutcome = isVagueScientificOutcome(sourceText);
  if (vagueScientificOutcome) {
    return {
      ...profile,
      ambiguityLevel: "material",
      strategy: "branched",
      routes: ["scientific", "statistics"],
      interpretations: scientificOutcomeInterpretations(),
      clarificationQuestion: profile.clarificationQuestion
        ?? "你关心哪一种具体健康结局？系统将先按功能、临床结局和指标/安全性分别核查。",
      rationale: `${profile.rationale} 确定性范围护栏将未定义的“有效/无效”拆成不同结局，且不扩展人群。`,
    };
  }
  if (fallback.ambiguityLevel === "material") {
    return {
      ...profile,
      routes: [...new Set([...profile.routes, ...fallback.routes])],
      strategy: "branched",
      ambiguityLevel: "material",
    };
  }

  const allowed = new Set<EvidenceRoute>(fallback.routes);
  if (allowed.has("scientific")) allowed.add("statistics");
  if (allowed.has("statistics") && SCIENCE.test(sourceText)) allowed.add("scientific");
  if (allowed.has("event_fact") || allowed.has("legal_policy")) allowed.add("official_record");
  const routes = profile.routes.filter((route) => allowed.has(route));
  return {
    ...profile,
    ambiguityLevel: "low",
    strategy: "direct",
    interpretations: [],
    clarificationQuestion: null,
    routes: routes.length ? routes : [...allowed],
    rationale: profile.ambiguityLevel === "material"
      ? `${profile.rationale} 确定性范围护栏判定原问题已明确指定核查关系，因此不扩展为无关解释分支。`
      : profile.rationale,
  };
}

export function buildFallbackAcademicQueries(seed: ClaimSeed): string[] {
  const text = `${seed.text} ${seed.verificationPoints.join(" ")}`;
  const translatedTerms: Array<[RegExp, string]> = [
    [/(?:DHA|二十二碳六烯酸)/i, "DHA supplementation"],
    [/(?:EPA|二十碳五烯酸)/i, "EPA supplementation"],
    [/(?:鱼油|omega[- ]?3|欧米伽.?3)/i, "omega-3 supplementation"],
    [/(?:咖啡|咖啡因)/i, "coffee caffeine consumption"],
    [/(?:维生素\s*D)/i, "vitamin D supplementation"],
    [/(?:褪黑素)/i, "melatonin supplementation"],
    [/(?:间歇性禁食|断食)/i, "intermittent fasting"],
  ];
  const concepts = translatedTerms.filter(([pattern]) => pattern.test(text)).map(([, value]) => value);
  const latinTerms = (text.match(/\b[A-Za-z][A-Za-z0-9-]{1,24}\b/g) ?? [])
    .filter((term) => !/^(?:the|and|for|with|study|research|effect|health|useful)$/i.test(term))
    .filter((term) => !concepts.some((concept) => concept.toLowerCase().includes(term.toLowerCase())));
  const exposure = concepts[0] ?? [...new Set(latinTerms)].slice(0, 2).join(" ");
  if (!exposure) return [];

  const population = /(?:儿童|孩子|未成年|青少年)/.test(text)
    ? "children adolescents"
    : /(?:孕妇|妊娠|怀孕)/.test(text)
      ? "pregnant women"
      : /(?:老年|老人|高龄)/.test(text)
        ? "older adults"
        : /(?:成人|成年人)/.test(text)
          ? "adults"
          : "humans";
  const outcomes: string[] = [];
  if (/(?:认知|记忆|注意力|智力|大脑)/.test(text)) outcomes.push("cognitive function memory");
  if (/(?:心血管|心脏|中风|血压|血脂|胆固醇)/.test(text)) outcomes.push("cardiovascular outcomes");
  if (/(?:死亡|寿命|全因死亡)/.test(text)) outcomes.push("all-cause mortality");
  if (/(?:睡眠|失眠)/.test(text)) outcomes.push("sleep quality insomnia");
  if (/(?:抑郁|焦虑|情绪)/.test(text)) outcomes.push("depression anxiety symptoms");
  if (/(?:减肥|体重|肥胖)/.test(text)) outcomes.push("body weight obesity");
  if (!outcomes.length || /(?:有用吗|是否有用|健康(?:效果|作用|益处)?|对健康|好处)/.test(text)) {
    outcomes.push("cognitive function", "cardiovascular outcomes", "adverse effects safety");
  }
  return [...new Set(outcomes)].slice(0, 3).map((outcome, index) =>
    `${population} ${exposure} ${outcome} ${index === 1 ? "randomized controlled trial" : "systematic review"}`,
  );
}

const POPULATION_SCOPES: Array<[string, RegExp]> = [
  ["children", /(?:儿童|孩子|未成年|青少年|婴幼儿|婴儿|新生儿|儿科|child(?:ren)?|adolescen\w*|infant\w*|neonat\w*|pediatr\w*)/i],
  ["pregnancy", /(?:孕妇|妊娠|怀孕|孕期|产妇|pregnan\w*|maternal)/i],
  ["older_adults", /(?:老年人?|老人|高龄|中老年|older adults?|elderly|geriatric)/i],
  ["adults", /(?:成年人?|成人|adults?)/i],
];

function populationScopes(text: string): Set<string> {
  return new Set(POPULATION_SCOPES.filter(([, pattern]) => pattern.test(text)).map(([scope]) => scope));
}

export function claimStaysWithinPopulationScope(sourceText: string, claimText: string): boolean {
  const sourceScopes = populationScopes(sourceText);
  if (!sourceScopes.size) return true;
  const claimScopes = populationScopes(claimText);
  return [...claimScopes].every((scope) => sourceScopes.has(scope));
}

export function augmentQueriesForRoute(seed: ClaimSeed): string[] {
  const plan = seed.routePlan ?? buildFallbackRoutePlan(seed);
  const base = seed.query;
  const englishAcademicQuery = seed.queries.find((query) => {
    const latinTerms = query.match(/[a-z][a-z0-9-]{2,}/gi) ?? [];
    const cjkCharacters = query.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    return cjkCharacters === 0 && latinTerms.length >= 2 && latinTerms.join("").length >= 8;
  });
  const additions: string[] = [];
  switch (plan.primaryRoute) {
    case "scientific":
      if (englishAcademicQuery) {
        additions.push(`${englishAcademicQuery} systematic review`, `${englishAcademicQuery} randomized controlled trial`);
      } else {
        additions.push(...buildFallbackAcademicQueries(seed));
      }
      break;
    case "statistics":
      additions.push(`${base} 官方统计 数据 口径`, `${base} dataset methodology`);
      break;
    case "official_record":
      additions.push(`${base} 官方 原文`, `${base} official statement transcript`);
      break;
    case "legal_policy":
      additions.push(`${base} 法律 条文 判决 官方`, `${base} official law court ruling`);
      break;
    case "conceptual":
      additions.push(`${base} 定义 来源`, `${base} 数据 研究 代表性`);
      break;
    case "normative":
      additions.push(`${base} evidence costs alternatives`);
      break;
    default:
      additions.push(`${base} 官方 通报`, `${base} 权威媒体 原创报道`);
  }
  return [...new Set([...seed.queries, ...additions])]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query) => query.length >= 2 && query.length <= 140)
    .slice(0, 4);
}

export function sourcePriorities(route: EvidenceRoute): string[] {
  return [...PRIORITIES[route]];
}
