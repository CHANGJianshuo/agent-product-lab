import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const demoDir = dirname(fileURLToPath(import.meta.url));
const buildDir = join(demoDir, "build");
const scenesDir = join(buildDir, "scenes");
const segmentsDir = join(buildDir, "segments");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const liveMode = process.argv.includes("--live");
const liveAnalysis = liveMode
  ? JSON.parse(readFileSync(join(demoDir, "live-analysis.json"), "utf8"))
  : null;

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(scenesDir, { recursive: true });
mkdirSync(segmentsDir, { recursive: true });

const C = {
  bg: "#F3F1EA",
  paper: "#FFFDF8",
  ink: "#15231B",
  muted: "#637168",
  green: "#42644D",
  green2: "#DDE9DF",
  red: "#9C443B",
  red2: "#F2DFDB",
  amber: "#A97228",
  amber2: "#F2E7D4",
  blue: "#4C667A",
  blue2: "#DEE7EC",
  line: "#D3DAD2",
};

const verdictLabels = {
  supported: "证据支持",
  refuted: "证据反驳",
  misleading: "语境误导",
  disputed: "可靠冲突",
  insufficient: "证据不足",
  unknown: "仍然未知",
};
const liveClaims = liveAnalysis?.claims ?? [];
const liveRuns = liveAnalysis?.methodology?.agentRuns ?? [];
const liveRunId = liveAnalysis?.id?.slice(0, 8) ?? "DEMO";
const liveTokens = liveAnalysis?.methodology?.tokenUsage?.totalTokens ?? 0;
const liveTokenText = Number(liveTokens).toLocaleString("en-US");
const liveVerdictLabel = verdictLabels[liveAnalysis?.summary?.verdict] ?? "有边界结论";
const allDecisionEvidence = liveClaims.flatMap((claim) => claim.evidence ?? [])
  .filter((item) => ["direct", "indirect"].includes(item.evidenceRole));
const uniqueDecisionEvidence = [...new Map(allDecisionEvidence.map((item) => [item.doi || item.url || item.id, item])).values()];
const featuredEvidence = liveClaims.map((claim) => (claim.evidence ?? [])
  .filter((item) => ["direct", "indirect"].includes(item.evidenceRole))
  .sort((left, right) => ((right.directness ?? 0) + (right.trust?.overall ?? 0)) - ((left.directness ?? 0) + (left.trust?.overall ?? 0)))[0])
  .filter(Boolean)
  .slice(0, 3);
const fallbackEvidence = [
  { title: "Cochrane 2020 · cardiovascular outcomes", provider: "cochrane", relation: "supporting_context", directness: 0.58, trust: { overall: 0.9 }, quality: { score: 90 } },
  { title: "RCT 34113957 · cognition in healthy adults", provider: "pubmed", relation: "supporting_context", directness: 0.82, trust: { overall: 0.87 }, quality: { score: 87 } },
  { title: "Meta-analysis 21975919 · DHA and blood lipids", provider: "pubmed", relation: "counter_signal", directness: 0.84, trust: { overall: 0.89 }, quality: { score: 90 } },
];
const falsifierRun = liveRuns.find((run) => run.id === "adaptive-falsifier");
const falsificationQueries = liveClaims.flatMap((claim) => claim.searchPlan ?? [])
  .filter((item) => item.includes("反证检索"))
  .map((item) => item.match(/“(.+?)”/)?.[1] ?? item)
  .slice(0, 3);
const falsifierCompleted = falsifierRun?.status === "completed";

function truncate(value, maximum) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean;
}

function wrapWords(value, maximum = 43) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maximum) return [clean, ""];
  const boundary = clean.lastIndexOf(" ", maximum);
  const splitAt = boundary >= Math.floor(maximum * 0.6) ? boundary : maximum;
  return [clean.slice(0, splitAt).trim(), truncate(clean.slice(splitAt).trim(), maximum)];
}

function claimText(index, fallback) {
  return truncate(liveClaims[index]?.text ?? fallback, 47);
}

function claimVerdict(index, fallback) {
  const claim = liveClaims[index];
  if (!claim) return fallback;
  return `${verdictLabels[claim.verdict] ?? claim.verdict} · ${Math.round((claim.confidence ?? 0) * 100)}%`;
}

function academicQuery(index, fallback) {
  const claim = liveClaims[index];
  const query = claim?.evidence?.map((item) => item.searchQuery)
    .find((item) => item && !/[\u4e00-\u9fff]/.test(item));
  return query ?? fallback;
}

function agentRun(id) {
  return liveRuns.find((run) => run.id === id);
}

function evidenceDirection(item) {
  if (item?.relation === "counter_signal") return { label: "反驳“完全无效”", color: C.green, fill: C.green2 };
  if (item?.relation === "supporting_context") return { label: "支持局部无显著效果", color: C.red, fill: C.red2 };
  return { label: "相关背景", color: C.amber, fill: C.amber2 };
}

function evidenceAt(index) {
  return featuredEvidence[index] ?? fallbackEvidence[index];
}

function evidenceSourceLabel(item) {
  const pmid = item?.id?.match(/pm-(\d+)/)?.[1];
  if (pmid) return `PUBMED · ${pmid}`;
  if (item?.doi) return `DOI · ${truncate(item.doi, 24)}`;
  return String(item?.provider ?? "RESEARCH").toUpperCase();
}

function evidenceStats(item) {
  return [
    `直接性 ${Math.round((item?.directness ?? 0) * 100)}%`,
    `来源信任 ${Math.round((item?.trust?.overall ?? 0) * 100)}%`,
    `质量先验 ${item?.quality?.score ?? 0}/100`,
  ];
}

function falsificationQuery(index, fallback) {
  if (liveAnalysis && !falsifierCompleted) {
    return index === 0 ? "本次未达到触发阈值，没有追加反证检索" : "—";
  }
  if (liveAnalysis && !falsificationQueries[index]) {
    return "— 本次没有更多反证查询 —";
  }
  return truncate(falsificationQueries[index] ?? fallback, 76);
}

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

function text(x, y, value, size = 30, weight = 400, fill = C.ink, anchor = "start", extra = "") {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ${extra}>${esc(value)}</text>`;
}

function lines(x, y, values, size = 28, gap = 42, weight = 400, fill = C.ink, anchor = "start") {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${values.map((value, index) => `<tspan x="${x}" dy="${index ? gap : 0}">${esc(value)}</tspan>`).join("")}</text>`;
}

function card(x, y, w, h, fill = C.paper, stroke = C.line, radius = 24, extra = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2" ${extra}/>`;
}

function pill(x, y, w, label, fill = C.green2, color = C.green, stroke = "none") {
  return `${card(x, y, w, 42, fill, stroke, 21)}${text(x + w / 2, y + 29, label, 19, 700, color, "middle", 'letter-spacing="1"')}`;
}

function arrow(x1, y1, x2, y2, color = C.green) {
  return `<path d="M ${x1} ${y1} L ${x2 - 14} ${y2}" stroke="${color}" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M ${x2 - 18} ${y2 - 10} L ${x2} ${y2} L ${x2 - 18} ${y2 + 10}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function check(x, y, color = C.green) {
  return `<circle cx="${x}" cy="${y}" r="17" fill="${color}"/><path d="M ${x - 8} ${y} l6 6 11 -13" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function shell(number, kicker, title, subtitle, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#D8DDD6" stroke-width="1" opacity="0.28"/>
    </pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#1A2B20" flood-opacity="0.10"/>
    </filter>
  </defs>
  <rect width="1920" height="1080" fill="${C.bg}"/>
  <rect width="1920" height="1080" fill="url(#grid)"/>
  <g font-family="Microsoft YaHei UI, Noto Sans CJK SC, Droid Sans Fallback, sans-serif">
    <g transform="translate(78 50)">
      <circle cx="24" cy="24" r="21" fill="none" stroke="${C.green}" stroke-width="5"/>
      <line x1="40" y1="40" x2="56" y2="56" stroke="${C.green}" stroke-width="6" stroke-linecap="round"/>
      ${text(72, 34, "SourceLens", 29, 800, C.ink)}
      ${pill(255, 4, 88, "2.2", C.green2, C.green)}
    </g>
    ${pill(1574, 54, 264, liveAnalysis ? "真实运行 · DEEPSEEK" : "演示回放 · DEMO", liveAnalysis ? C.green2 : C.red2, liveAnalysis ? C.green : C.red)}
    ${text(86, 139, `${String(number).padStart(2, "0")} / 08   ${kicker}`, 21, 800, C.green, "start", 'letter-spacing="2"')}
    ${text(86, 206, title, 52, 800, C.ink)}
    ${text(88, 253, subtitle, 25, 400, C.muted)}
    ${body}
    ${text(88, 915, "模型记忆不作证据  ·  引用必须可追溯  ·  结论保留边界", 19, 600, C.muted)}
    ${text(1832, 915, liveAnalysis ? `RUN ${liveRunId} / DHA` : "SOURCE-LENS / DHA", 18, 800, C.green, "end", 'letter-spacing="2"')}
  </g>
</svg>`;
}

const scenes = [
  {
    duration: 5,
    svg: shell(1, "CLAIM INTAKE", "一句很确定的话，真的经得起核查吗？", "用一个绝对化健康说法，演示完整的证据审查链路。", `
      <g filter="url(#shadow)">
        ${card(86, 322, 1050, 248, C.paper, C.line, 30)}
        ${pill(126, 354, 156, "待核查说法", C.red2, C.red)}
        ${text(126, 446, "“鱼油中的 DHA 成分对成年人无效”", 45, 800, C.ink)}
        ${text(126, 512, "先不相信，也不急着反驳。", 27, 500, C.muted)}
      </g>
      <g filter="url(#shadow)">
        ${card(1200, 305, 630, 470, "#17261D", "#17261D", 30)}
        ${text(1248, 361, "SOURCE VERIFICATION", 17, 800, "#9EC3A6", "start", 'letter-spacing="2"')}
        ${text(1248, 421, "Evidence Review", 38, 800, "#FFFFFF")}
        ${text(1248, 461, "不是聊天回答，而是证据流程", 22, 400, "#C5D3C8")}
        ${check(1264, 526, "#5E8669")}${text(1300, 535, "明确问题", 23, 700, "#FFFFFF")}
        ${check(1264, 588, "#5E8669")}${text(1300, 597, "定向检索", 23, 700, "#FFFFFF")}
        ${check(1264, 650, "#5E8669")}${text(1300, 659, "双重独立核验", 23, 700, "#FFFFFF")}
        ${check(1264, 712, "#5E8669")}${text(1300, 721, "有边界结论", 23, 700, "#FFFFFF")}
      </g>
      ${pill(86, 625, 240, liveAnalysis ? `${liveTokenText} tokens` : "56 秒精剪", C.blue2, C.blue)}
      ${pill(344, 625, 252, liveAnalysis ? `${uniqueDecisionEvidence.length} 项结论证据` : "权威科研来源", C.green2, C.green)}
      ${pill(614, 625, 280, liveAnalysis ? "DeepSeek Multi-Agent" : "独立 Multi-Agent", C.amber2, C.amber)}
    `),
  },
  {
    duration: 6.5,
    svg: shell(2, "SCOPE", "第一步：把“无效”拆成能检验的问题", "全称判断会把不同人群、配方和结局压成一个答案。", `
      ${card(86, 316, 548, 472, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${pill(122, 350, 148, "问题 01", C.green2, C.green)}
      ${text(122, 430, "成年人是谁？", 36, 800)}
      ${lines(122, 483, ["健康成年人", "中老年人", "高甘油三酯或认知障碍患者"], 24, 46, 500, C.muted)}
      ${card(686, 316, 548, 472, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${pill(722, 350, 148, "问题 02", C.blue2, C.blue)}
      ${text(722, 430, "补充的是什么？", 36, 800)}
      ${lines(722, 483, ["DHA 单体", "DHA-rich oil", "EPA + DHA 鱼油配方"], 24, 46, 500, C.muted)}
      ${card(1286, 316, 548, 472, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${pill(1322, 350, 148, "问题 03", C.amber2, C.amber)}
      ${text(1322, 430, "怎样才算有效？", 36, 800)}
      ${lines(1322, 483, ["认知功能", "心血管事件", "血脂指标与不良反应"], 24, 46, 500, C.muted)}
      ${card(86, 815, 1748, 62, C.red2, C.red, 16)}
      ${text(960, 856, "如果不先定义这些变量，“无效”既无法证实，也无法证伪。", 24, 700, C.red, "middle")}
    `),
  },
  {
    duration: 7,
    svg: shell(3, "VERIFICATION PLAN", "统一规划器只生成三个必要核查点", "它负责拆题与检索，不在看到证据前预判答案。", `
      ${card(86, 308, 1748, 158, C.paper, C.line, 26, 'filter="url(#shadow)"')}
      ${pill(120, 340, 86, "01", C.green2, C.green)}
      ${text(240, 378, claimText(0, "健康成年人补充 DHA-rich oil，是否改善总体认知功能？"), 29, 750)}
      ${pill(1430, 340, 334, claimVerdict(0, "人群 · 干预 · 认知结局"), C.green2, C.green)}
      ${card(86, 492, 1748, 158, C.paper, C.line, 26, 'filter="url(#shadow)"')}
      ${pill(120, 524, 86, "02", C.blue2, C.blue)}
      ${text(240, 562, claimText(1, "增加 EPA + DHA，是否降低死亡或心血管事件？"), 29, 750)}
      ${pill(1430, 524, 334, claimVerdict(1, "组合暴露 · 临床终点"), C.blue2, C.blue)}
      ${card(86, 676, 1748, 158, C.paper, C.line, 26, 'filter="url(#shadow)"')}
      ${pill(120, 708, 86, "03", C.amber2, C.amber)}
      ${text(240, 746, claimText(2, "DHA 是否改变甘油三酯、LDL，并带来安全性代价？"), 29, 750)}
      ${pill(1430, 708, 334, claimVerdict(2, "DHA 单体 · 指标与风险"), C.amber2, C.amber)}
      ${text(960, 872, "三个核查点分别裁决；一篇论文不能自动跨题复用。", 23, 700, C.muted, "middle")}
    `),
  },
  {
    duration: 8,
    svg: shell(4, "RETRIEVAL", "科学问题，优先找科学证据", "查询被送往 PubMed、OpenAlex 与 Cochrane，而不是让普通网页主导结论。", `
      ${card(86, 310, 800, 530, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${text(126, 368, "检索式", 25, 800, C.green)}
      ${card(124, 402, 724, 92, "#F6F8F4", C.line, 16)}
      ${lines(150, 438, wrapWords(academicQuery(0, "adults DHA-rich oil placebo global cognition randomized trial")), 22, 31, 600, C.ink)}
      ${card(124, 512, 724, 92, "#F6F8F4", C.line, 16)}
      ${lines(150, 548, wrapWords(academicQuery(1, "EPA DHA cardiovascular events systematic review mortality")), 22, 31, 600, C.ink)}
      ${card(124, 622, 724, 92, "#F6F8F4", C.line, 16)}
      ${lines(150, 658, wrapWords(academicQuery(2, "DHA monotherapy triglycerides LDL meta-analysis adverse effects")), 22, 31, 600, C.ink)}
      ${pill(124, 751, 316, "反向词：null · no effect", C.red2, C.red)}
      ${pill(458, 751, 274, "retraction · bias", C.amber2, C.amber)}
      ${card(934, 310, 900, 530, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${text(974, 368, "来源优先级", 25, 800, C.green)}
      ${pill(974, 404, 176, "COCHRANE", C.green2, C.green)}
      ${text(1176, 433, liveAnalysis ? `系统综述优先 · 实际 ${liveAnalysis.summary?.evidenceCount ?? 0} 项候选` : "系统综述 · 86 trials · 162,796 adults", 23, 650)}
      ${pill(974, 482, 176, "PUBMED", C.blue2, C.blue)}
      ${text(1176, 511, liveAnalysis ? `可读材料 ${liveAnalysis.summary?.readableEvidenceCount ?? 0} 项 · 摘要可核查` : "随机试验与同行评议论文摘要", 23, 650)}
      ${pill(974, 560, 176, "OPENALEX", C.amber2, C.amber)}
      ${text(1176, 589, liveAnalysis ? `实际检索 ${liveAnalysis.methodology?.searchRounds ?? 0} 轮 · DOI 可追溯` : "补充发现、DOI 与引用元数据", 23, 650)}
      <line x1="974" y1="646" x2="1788" y2="646" stroke="${C.line}" stroke-width="2"/>
      ${text(974, 699, "普通网页 / 新闻转述", 24, 700, C.red)}
      ${text(974, 739, "只作背景线索，不能替代论文或原始记录。", 22, 500, C.muted)}
      ${pill(974, 774, 378, "去重 · 同源识别 · 可追溯", "#EDF1EC", C.muted)}
    `),
  },
  {
    duration: 8.5,
    svg: shell(5, "INDEPENDENT VERIFICATION", "Multi-Agent 用在最关键的位置：确认真实性", "两个 Agent 收到同一批原始证据，但使用隔离上下文，互相看不到评分。", `
      ${card(92, 322, 712, 500, C.paper, C.green, 30, 'filter="url(#shadow)"')}
      ${pill(132, 356, 286, liveAnalysis ? "AGENT A · MATCHING ✓" : "AGENT A · MATCHING", C.green2, C.green)}
      ${text(132, 430, "这篇论文真的回答了命题吗？", 31, 800)}
      ${lines(132, 488, [liveAnalysis ? `模型：${agentRun("evidence-matcher")?.model ?? "DeepSeek"}` : "✓ 人群是否相同", "✓ DHA 单体还是 EPA + DHA", "✓ 结局、剂量、时间是否相同", "✓ 支持 / 反驳 / 仅背景"], 24, 52, 600, C.muted)}
      ${card(1116, 322, 712, 500, C.paper, C.blue, 30, 'filter="url(#shadow)"')}
      ${pill(1156, 356, 302, liveAnalysis ? "AGENT B · QUALITY ✓" : "AGENT B · QUALITY", C.blue2, C.blue)}
      ${text(1156, 430, "产生证据的方法可靠吗？", 31, 800)}
      ${lines(1156, 488, [liveAnalysis ? `模型：${agentRun("source-quality-auditor")?.model ?? "DeepSeek"}` : "✓ 随机化与对照", "✓ 偏倚、混杂和失访", "✓ 样本量与置信区间", "✓ 注册、撤稿与来源完整性"], 24, 52, 600, C.muted)}
      ${card(834, 442, 252, 232, "#17261D", "#17261D", 28, 'filter="url(#shadow)"')}
      ${text(960, 490, "RAW", 20, 800, "#9EC3A6", "middle", 'letter-spacing="2"')}
      ${text(960, 546, liveAnalysis ? `${uniqueDecisionEvidence.length} 项证据` : "同一证据包", 28, 800, "#FFFFFF", "middle")}
      ${text(960, 590, "标题 · 摘要", 20, 500, "#C5D3C8", "middle")}
      ${text(960, 623, "来源 · 日期", 20, 500, "#C5D3C8", "middle")}
      ${arrow(830, 558, 804, 558, C.green)}
      ${arrow(1086, 558, 1116, 558, C.blue)}
      ${pill(746, 850, 428, "不共享隐藏上下文 · 不多数投票", C.red2, C.red)}
    `),
  },
  {
    duration: 7,
    svg: shell(6, "EVIDENCE MATRIX", "看似冲突的结果，可以同时成立", "关键不是数论文，而是判断每项证据能支持多大范围的结论。", `
      ${card(86, 316, 550, 510, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${pill(122, 350, 280, evidenceSourceLabel(evidenceAt(0)), C.green2, C.green)}
      ${lines(122, 418, wrapWords(evidenceAt(0).title, 41), 22, 32, 800, C.ink)}
      ${pill(122, 506, 304, evidenceDirection(evidenceAt(0)).label, evidenceDirection(evidenceAt(0)).fill, evidenceDirection(evidenceAt(0)).color)}
      ${lines(122, 590, evidenceStats(evidenceAt(0)), 22, 43, 600, C.muted)}
      ${pill(122, 736, 280, "双 Agent 已独立核验", C.amber2, C.amber)}
      ${card(686, 316, 550, 510, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${pill(722, 350, 280, evidenceSourceLabel(evidenceAt(1)), C.blue2, C.blue)}
      ${lines(722, 418, wrapWords(evidenceAt(1).title, 41), 22, 32, 800, C.ink)}
      ${pill(722, 506, 304, evidenceDirection(evidenceAt(1)).label, evidenceDirection(evidenceAt(1)).fill, evidenceDirection(evidenceAt(1)).color)}
      ${lines(722, 590, evidenceStats(evidenceAt(1)), 22, 43, 600, C.muted)}
      ${pill(722, 736, 280, "双 Agent 已独立核验", C.blue2, C.blue)}
      ${card(1286, 316, 548, 510, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${pill(1322, 350, 280, evidenceSourceLabel(evidenceAt(2)), C.amber2, C.amber)}
      ${lines(1322, 418, wrapWords(evidenceAt(2).title, 41), 22, 32, 800, C.ink)}
      ${pill(1322, 506, 304, evidenceDirection(evidenceAt(2)).label, evidenceDirection(evidenceAt(2)).fill, evidenceDirection(evidenceAt(2)).color)}
      ${lines(1322, 590, evidenceStats(evidenceAt(2)), 22, 43, 600, C.muted)}
      ${pill(1322, 736, 280, "双 Agent 已独立核验", C.green2, C.green)}
    `),
  },
  {
    duration: 8,
    svg: shell(7, "ADAPTIVE FALSIFICATION", liveAnalysis ? `反证 Agent：本次${falsifierCompleted ? "已按条件触发" : "按规则跳过"}` : "只有触发条件成立，才增加反证 Agent", "它的任务是推翻当前印象，而不是再找一遍支持材料。", `
      ${card(86, 316, 500, 510, "#17261D", "#17261D", 28, 'filter="url(#shadow)"')}
      ${text(126, 370, "触发器", 23, 800, "#9EC3A6", "start", 'letter-spacing="2"')}
      ${check(142, 439, C.red)}${text(180, 448, "健康信息：高风险", 25, 700, "#FFFFFF")}
      ${check(142, 507, C.amber)}${text(180, 516, "证据方向不一致", 25, 700, "#FFFFFF")}
      ${check(142, 575, C.blue)}${text(180, 584, "原句使用全称量词", 25, 700, "#FFFFFF")}
      ${lines(126, 670, ["满足任一关键条件", "才额外付出模型与检索成本。"], 21, 36, 500, "#C5D3C8")}
      ${arrow(618, 566, 754, 566, C.green)}
      ${card(760, 316, 1074, 510, C.paper, C.line, 28, 'filter="url(#shadow)"')}
      ${pill(800, 350, 388, liveAnalysis ? `FALSIFICATION · ${falsifierCompleted ? "COMPLETED" : "SKIPPED"}` : "FALSIFICATION AGENT", C.red2, C.red)}
      ${text(800, 424, "主动提出能够改变判断的检索", 31, 800)}
      ${card(800, 466, 974, 88, "#F8F5F1", C.line, 15)}
      ${text(830, 520, falsificationQuery(0, "DHA-rich oil healthy adults null cognitive outcome RCT"), 21, 600)}
      ${card(800, 574, 974, 88, "#F8F5F1", C.line, 15)}
      ${text(830, 628, falsificationQuery(1, "DHA monotherapy adverse effects LDL systematic review"), 21, 600)}
      ${card(800, 682, 974, 88, "#F8F5F1", C.line, 15)}
      ${text(830, 736, falsificationQuery(2, "EPA DHA cardiovascular events no effect retraction bias"), 21, 600)}
      ${pill(800, 786, 520, liveAnalysis ? truncate(falsifierRun?.detail ?? "自适应反证状态已记录", 31) : "新证据返回后，两位核验者重新复核", C.green2, C.green)}
    `),
  },
  {
    duration: 6,
    svg: shell(8, "BOUNDED CONCLUSION", liveAnalysis ? `真实裁决：${liveVerdictLabel}，但必须保留边界` : "最终结论：不能接受这个绝对说法", "裁决依据是证据强度与适用范围，不是哪个 Agent 票数更多。", `
      ${card(86, 312, 1748, 286, C.paper, C.green, 32, 'filter="url(#shadow)"')}
      ${pill(126, 350, 286, liveAnalysis ? `实际结果 · ${liveVerdictLabel}` : "表述具有误导性", C.red2, C.red)}
      ${text(126, 432, "“DHA 对成年人无效”把多种配方、人群和结局混成一个全称判断。", 36, 800)}
      ${text(126, 494, "现有证据允许说“某些结局未显示明显获益”，不允许扩大成“没有任何作用”。", 28, 600, C.muted)}
      ${card(86, 632, 538, 178, C.green2, "#B9CDBD", 22)}
      ${text(122, 680, "可以说", 21, 800, C.green)}
      ${lines(122, 724, ["部分临床结局获益很小或没有", "具体结论依赖人群、剂量与配方"], 23, 38, 650, C.ink)}
      ${card(691, 632, 538, 178, C.red2, "#DEC0BB", 22)}
      ${text(727, 680, "不能说", 21, 800, C.red)}
      ${lines(727, 724, ["所有成年人、所有健康结局均无效", "EPA + DHA 的结果等于 DHA 单体"], 23, 38, 650, C.ink)}
      ${card(1296, 632, 538, 178, C.blue2, "#C2D0D8", 22)}
      ${text(1332, 680, "仍需说明", 21, 800, C.blue)}
      ${lines(1332, 724, ["指标变化不等于净健康获益", "这份演示不构成医疗建议"], 23, 38, 650, C.ink)}
      ${pill(610, 847, 700, liveAnalysis ? `RUN ${liveRunId} · ${liveTokenText} TOKENS · ${uniqueDecisionEvidence.length} EVIDENCE` : "SourceLens · 证据先于结论", "#17261D", "#FFFFFF", "#17261D")}
    `),
  },
];

const captions = [
  liveAnalysis
    ? `这是一次真实 DeepSeek 核查，运行编号 ${liveRunId}。\\N待核查说法是：鱼油中的 DHA 成分对成年人无效。`
    : "待核查说法是：鱼油中的 DHA 成分对成年人无效。\\N我们先不选边，先看这句话能否被准确检验。",
  "“无效”是一个全称判断，却没有限定人群、配方和健康结局。\\N这些边界不明确，任何简单的是或否都可能误导。",
  liveAnalysis
    ? `DeepSeek 规划器实际生成 ${liveClaims.length} 个核查点：功能、临床结局，以及指标和安全性。\\N每个核查点独立检索、独立裁决。`
    : "统一规划器把问题拆成认知、心血管临床结局，以及血脂和安全性三个核查点。\\N三个核查点分别检索、分别裁决。",
  liveAnalysis
    ? `真实检索取得 ${liveAnalysis.summary?.evidenceCount ?? 0} 项候选、${liveAnalysis.summary?.readableEvidenceCount ?? 0} 项可读材料。\\N科学路线优先 PubMed 与 OpenAlex，普通网页不主导结论。`
    : "科学路线优先系统综述和随机试验，并追踪 PubMed、OpenAlex 与 Cochrane。\\N普通网页只能作为线索，不能替代原始研究。",
  liveAnalysis
    ? `Matching Agent 使用 ${agentRun("evidence-matcher")?.model ?? "DeepSeek"}，Quality Agent 使用 ${agentRun("source-quality-auditor")?.model ?? "DeepSeek"}。\\N两次请求上下文隔离，真实状态均为完成。`
    : "两个 Agent 使用隔离上下文独立工作。\\N一个检查论文是否真的回答命题；另一个检查研究方法和来源是否可靠。",
  liveAnalysis
    ? `这里展示的是本次运行真正进入裁决的三项高排名证据。\\N方向不同并不自动冲突，必须同时检查人群、结局和直接性。`
    : "高质量证据可以显示某些临床结局没有获益，同时 DHA 又确实改变部分血脂指标。\\N这不是矛盾，而是结局和证据范围不同。",
  liveAnalysis
    ? `本次反证 Agent 状态为${falsifierCompleted ? "已触发" : "按规则跳过"}。\\N是否增加模型调用由证据风险决定，不为展示流程而强行执行。`
    : "健康主张、单边证据或核验分歧会触发反证 Agent。\\N新增证据还要重新经过两位核验者，而不是直接加入结论。",
  liveAnalysis
    ? `最终裁决为${liveVerdictLabel}，本次真实调用共使用 ${liveTokenText} tokens。\\N它反驳的是全称“无效”，并不等于 DHA 对所有结局都有效。`
    : "最终裁决不是 DHA 对所有结局都有效，而是原来的全称无效说法无法成立。\\N可靠结论必须同时写清适用范围和仍然未知的部分。",
];

function assTime(seconds) {
  const centiseconds = Math.round(seconds * 100);
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

let cursor = 0;
const events = scenes.map((scene, index) => {
  const start = cursor;
  cursor += scene.duration;
  return `Dialogue: 0,${assTime(start)},${assTime(cursor)},Default,,0,0,0,,${captions[index]}`;
}).join("\n");
const totalDuration = cursor;
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei UI,34,&H00FFFFFF,&H000000FF,&H00000000,&H980F1913,0,0,0,0,100,100,0,0,3,0,0,2,120,120,26,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;

const assFile = join(demoDir, "subtitles.ass");
writeFileSync(assFile, ass, "utf8");

function run(args, label) {
  const result = spawnSync(ffmpeg, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(`${label} 失败（退出码 ${result.status}）`);
  }
}

const segmentFiles = [];
for (let index = 0; index < scenes.length; index += 1) {
  const sceneFile = join(scenesDir, `${String(index + 1).padStart(2, "0")}.svg`);
  const scenePng = join(scenesDir, `${String(index + 1).padStart(2, "0")}.png`);
  const segmentFile = join(segmentsDir, `${String(index + 1).padStart(2, "0")}.mp4`);
  writeFileSync(sceneFile, scenes[index].svg, "utf8");
  const renderer = new Resvg(scenes[index].svg, {
    fitTo: { mode: "width", value: 1920 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "Microsoft YaHei UI",
    },
  });
  writeFileSync(scenePng, renderer.render().asPng());
  run([
    "-y", "-loop", "1", "-framerate", "30", "-i", scenePng,
    "-t", String(scenes[index].duration),
    "-vf", "scale=2000:1125,zoompan=z='min(zoom+0.00006,1.018)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,format=yuv420p",
    "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "30", segmentFile,
  ], `渲染镜头 ${index + 1}`);
  segmentFiles.push(segmentFile);
}

const concatFile = join(buildDir, "concat.txt");
writeFileSync(concatFile, segmentFiles.map((file) => `file '${file}'`).join("\n"), "utf8");
const silentVideo = join(buildDir, "silent.mp4");
run(["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", silentVideo], "合并精剪镜头");

const musicFile = join(buildDir, "ambient.wav");
const musicExpression = [
  "0.018*(sin(2*PI*130.81*t)+0.72*sin(2*PI*196.00*t)+0.48*sin(2*PI*246.94*t)+0.32*sin(2*PI*329.63*t))*(0.82+0.16*sin(2*PI*0.055*t))",
  "0.018*(sin(2*PI*130.81*t+0.17)+0.72*sin(2*PI*196.00*t+0.09)+0.48*sin(2*PI*246.94*t+0.21)+0.32*sin(2*PI*329.63*t+0.13))*(0.82+0.16*sin(2*PI*0.047*t))",
].join("|");
run([
  "-y", "-f", "lavfi", "-i", `aevalsrc=${musicExpression}:s=48000:d=${totalDuration}`,
  "-af", `lowpass=f=1800,aecho=0.8:0.55:650|1100:0.16|0.10,afade=t=in:st=0:d=2,afade=t=out:st=${totalDuration - 3}:d=3,volume=5.2`,
  "-c:a", "pcm_s16le", musicFile,
], "生成原创舒缓音乐");

const output = join(demoDir, "source-lens-dha-demo.mp4");
run([
  "-y", "-i", silentVideo, "-i", musicFile,
  "-vf", `ass=${assFile}`,
  "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  "-t", String(totalDuration), "-movflags", "+faststart", output,
], "烧录字幕并输出 MP4");

const cover = join(demoDir, "source-lens-dha-demo-cover.png");
copyFileSync(join(scenesDir, "01.png"), cover);

process.stdout.write(`Demo ready: ${output}\nDuration: ${totalDuration}s\n`);
