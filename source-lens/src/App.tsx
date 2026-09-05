import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type {
  AnalysisProgress,
  AnalysisResult,
  ApiError,
  ClaimAnalysis,
  EvidenceItem,
  EvidenceRelation,
  EvidenceRoute,
  RuntimeConfig,
  Verdict,
} from "../shared/types";

type InputMode = "text" | "image";
type RunStage = "idle" | "ocr" | "claims" | "search" | "judge" | "report" | "error";

const SAMPLE_TEXT =
  "网传消息称：嫦娥六号于2024年6月25日返回地球，并带回了人类首份月球背面样品。请帮我核查这段话。";

const STAGES: Array<{ id: Exclude<RunStage, "idle" | "error">; label: string }> = [
  { id: "ocr", label: "读取内容" },
  { id: "claims", label: "明确问题" },
  { id: "search", label: "检索来源" },
  { id: "judge", label: "核验证据" },
  { id: "report", label: "输出结论" },
];

const VERDICT_META: Record<Verdict, { short: string; icon: string }> = {
  supported: { short: "证据支持", icon: "check" },
  refuted: { short: "证据反驳", icon: "close" },
  misleading: { short: "语境误导", icon: "alert" },
  disputed: { short: "存在冲突", icon: "alert" },
  insufficient: { short: "证据不足", icon: "minus" },
  unknown: { short: "未知", icon: "question" },
};

const RELATION_LABELS: Record<EvidenceRelation, string> = {
  supporting_context: "支持性上下文",
  counter_signal: "反向线索",
  related: "相关线索",
};

const ISSUE_TYPE_LABELS = {
  descriptive: "事实性议题",
  evaluative: "价值性议题",
  prescriptive: "行动性议题",
  mixed: "混合议题",
} as const;

const ARGUMENT_TYPE_LABELS = {
  factual: "事实论证",
  causal: "因果论证",
  generalization: "归纳概括",
  authority: "专家论证",
  analogy: "类比论证",
  deductive: "演绎论证",
  statistical: "统计论证",
  policy: "政策论证",
  other: "待识别论证",
} as const;

const AUDIT_STATUS_LABELS = {
  strong: "较强",
  mixed: "有保留",
  weak: "薄弱",
  unknown: "未知",
} as const;

const QUESTION_STATUS_LABELS = {
  answered: "已回答",
  partial: "部分回答",
  open: "仍待回答",
} as const;

const ALTERNATIVE_STATUS_LABELS = {
  plausible: "仍有可能",
  weakened: "已有削弱",
  unresolved: "尚未解决",
} as const;

const ROUTE_LABELS: Record<EvidenceRoute, string> = {
  scientific: "科学研究",
  event_fact: "事件事实",
  official_record: "官方记录",
  statistics: "原始统计",
  legal_policy: "法律政策",
  conceptual: "概念消歧",
  normative: "规范判断",
};

const EVIDENCE_ROLE_LABELS = {
  direct: "直接回答",
  indirect: "间接证据",
  background: "背景材料",
  irrelevant: "不回答命题",
} as const;

const CRITIC_LABELS = {
  scientific: "科学研究质量检查",
  news: "新闻与事件来源检查",
  statistics: "统计口径检查",
  policy: "政策与法律文本检查",
  conceptual: "概念边界检查",
  general: "通用证据检查",
} as const;

function isDecisionEvidence(evidence: EvidenceItem): boolean {
  if (["background", "irrelevant"].includes(evidence.evidenceRole ?? "")) return false;
  if (["direct", "indirect"].includes(evidence.evidenceRole ?? "")) {
    return (evidence.directness ?? evidence.relevance) >= 0.18;
  }
  return evidence.relevance >= 0.28;
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    lens: <><circle cx="10.7" cy="10.7" r="6.4"/><path d="m15.4 15.4 4.1 4.1"/><path d="M8.2 10.7h5M10.7 8.2v5"/></>,
    text: <><path d="M4 5h16M4 10h12M4 15h16M4 20h9"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 4.8-4.8a1.7 1.7 0 0 1 2.4 0L14 15l1.3-1.3a1.7 1.7 0 0 1 2.4 0L21 17"/></>,
    upload: <><path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></>,
    spark: <><path d="m12 3 .9 3.1A6.7 6.7 0 0 0 17.6 11l2.9 1-2.9 1a6.7 6.7 0 0 0-4.7 4.9L12 21l-.9-3.1A6.7 6.7 0 0 0 6.4 13l-2.9-1 2.9-1a6.7 6.7 0 0 0 4.7-4.9L12 3Z"/></>,
    shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8.2 7 10 4.2-1.8 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></>,
    link: <><path d="m10 13.5 4-4"/><path d="M8.5 16.5 7 18a3.5 3.5 0 1 1-5-5l3-3a3.5 3.5 0 0 1 5 0" transform="translate(3)"/><path d="m15.5 7.5 1.5-1.5a3.5 3.5 0 1 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" transform="translate(-3)"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><path d="M12 4 3.5 19h17L12 4Z"/><path d="M12 9v4M12 16.5v.1"/></>,
    minus: <path d="M5 12h14"/>,
    question: <><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.3 2.3 0 1 1 3 2.2c-.8.3-.8 1-.8 1.8M12 16.5v.1"/></>,
    arrow: <path d="m8 5 7 7-7 7"/>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></>,
    copy: <><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></>,
    chevron: <path d="m6 9 6 6 6-6"/>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/></>,
    reset: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4M12 7v5l3 2"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>,
    brain: <><path d="M9.5 4.5A3 3 0 0 0 5 7a3 3 0 0 0-1 5.5A3 3 0 0 0 7 17h1M14.5 4.5A3 3 0 0 1 19 7a3 3 0 0 1 1 5.5A3 3 0 0 1 17 17h-1M9 4v16M15 4v16M9 9H7M15 9h2M9 15H7M15 15h2"/></>,
  };
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.info}
    </svg>
  );
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = await response.json() as ApiError;
    return body.detail ? `${body.error}：${body.detail}` : body.error;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function readAnalysisStream(
  response: Response,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<AnalysisResult> {
  if (!response.body) throw new Error("浏览器不支持流式报告");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalysisResult | null = null;

  const consumeBlock = (block: string) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "message";
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    const parsed = JSON.parse(data) as AnalysisProgress | AnalysisResult | ApiError;
    if (event === "progress") onProgress(parsed as AnalysisProgress);
    if (event === "result") result = parsed as AnalysisResult;
    if (event === "error") {
      const failure = parsed as ApiError;
      throw new Error(failure.detail ? `${failure.error}：${failure.detail}` : failure.error);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (block) consumeBlock(block);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer.trim());
  if (!result) throw new Error("服务端未返回完整报告");
  return result;
}

function saveHistory(items: AnalysisResult[]): void {
  try {
    window.localStorage.setItem("sourcelens-history-v1", JSON.stringify(items.slice(0, 8)));
  } catch {
    // History is a convenience; storage limits must not break analysis.
  }
}

function HistoryPanel({
  items,
  onClose,
  onSelect,
  onClear,
}: {
  items: AnalysisResult[];
  onClose: () => void;
  onSelect: (item: AnalysisResult) => void;
  onClear: () => void;
}) {
  return (
    <div className="history-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="history-panel" role="dialog" aria-modal="true" aria-label="历史报告">
        <div className="history-heading">
          <div><span className="eyebrow">LOCAL HISTORY</span><h2>最近核查</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭历史报告"><Icon name="close" size={19} /></button>
        </div>
        <p className="history-privacy">报告只保存在当前浏览器，不会形成服务器端用户档案。</p>
        <div className="history-list">
          {items.map((item) => (
            <button type="button" key={item.id} onClick={() => onSelect(item)}>
              <span className={`history-verdict ${item.summary.verdict}`}><Icon name={VERDICT_META[item.summary.verdict].icon} size={15} /></span>
              <span className="history-copy">
                <strong>{item.summary.headline}</strong>
                <small>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })} · {item.summary.claimCount} 条主张</small>
              </span>
              <Icon name="arrow" size={16} />
            </button>
          ))}
          {!items.length && <div className="history-empty"><Icon name="history" size={26} /><span>还没有历史报告</span></div>}
        </div>
        {items.length > 0 && <button className="history-clear" type="button" onClick={onClear}><Icon name="trash" size={15} />清空本地历史</button>}
      </aside>
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function StageRail({ stage }: { stage: RunStage }) {
  const activeIndex = STAGES.findIndex((item) => item.id === stage);
  return (
    <div className="stage-rail" aria-label="分析进度">
      {STAGES.map((item, index) => {
        const done = stage === "report" || index < activeIndex;
        const active = item.id === stage;
        return (
          <div className={`stage ${done ? "done" : ""} ${active ? "active" : ""}`} key={item.id}>
            <span className="stage-dot">{done ? <Icon name="check" size={13} /> : index + 1}</span>
            <span>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function ConfidenceRing({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <div className="confidence-ring" style={{ "--confidence": `${percent * 3.6}deg` } as React.CSSProperties}>
      <div>
        <strong>{percent}</strong>
        <span>%</span>
      </div>
    </div>
  );
}

function EvidenceCard({ evidence, index }: { evidence: EvidenceItem; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const trustScore = evidence.trust ? Math.round(evidence.trust.overall * 100) : evidence.quality.score;
  const quoteLabel = evidence.quoteType === "abstract"
    ? "论文摘要"
    : evidence.quoteType === "metadata"
      ? "仅书目信息"
      : evidence.quoteType === "search_snippet"
        ? "仅搜索摘要"
        : "已读网页原文";
  return (
    <article className="evidence-card">
      <div className="evidence-index">{String(index + 1).padStart(2, "0")}</div>
      <div className="evidence-body">
        <div className="evidence-topline">
          <span className={`relation-badge ${evidence.relation}`}>{RELATION_LABELS[evidence.relation]}</span>
          {evidence.evidenceRole && (
            <span className={`evidence-role role-${evidence.evidenceRole}`}>{EVIDENCE_ROLE_LABELS[evidence.evidenceRole]}</span>
          )}
          <span className={`quality quality-${evidence.trust?.label ?? evidence.quality.label}`}>
            证据信任 {trustScore}
          </span>
          {evidence.quoteType !== "page" && <span className="snippet-label">{quoteLabel}</span>}
        </div>
        <a className="evidence-title" href={evidence.url} target="_blank" rel="noreferrer">
          {evidence.title}
          <Icon name="external" size={15} />
        </a>
        <div className="source-meta">
          <span>{evidence.domain}</span>
          <span className="meta-separator" />
          <span><Icon name="clock" size={14} />{formatDate(evidence.publishedAt)}</span>
          <span className="meta-separator" />
          <span>{evidence.sourceKind}</span>
          {evidence.provider && evidence.provider !== "web" && (
            <><span className="meta-separator" /><span>{evidence.provider === "pubmed" ? "PubMed" : "OpenAlex"}</span></>
          )}
        </div>
        <blockquote>{evidence.quote}</blockquote>
        {evidence.relationExplanation && (
          <div className="relation-explanation">
            <Icon name="brain" size={14} />
            <span>{evidence.relationExplanation}</span>
          </div>
        )}
        {evidence.rankerExplanation && (
          <div className="ranker-explanation">
            <Icon name="lens" size={14} />
            <span><strong>命题匹配核验：</strong>{evidence.rankerExplanation}</span>
          </div>
        )}
        <button className="why-button" type="button" onClick={() => setExpanded((value) => !value)}>
          为什么这样评分
          <Icon name="chevron" size={15} />
        </button>
        {expanded && (
          <div className="quality-reasons">
            {evidence.quality.reasons.map((reason) => <span key={reason}>{reason}</span>)}
            {evidence.trust?.reasons.map((reason) => <span key={reason}>{reason}</span>)}
            <span>文本相关度 {Math.round(evidence.relevance * 100)}%</span>
            {typeof evidence.directness === "number" && <span>命题直接性 {Math.round(evidence.directness * 100)}%</span>}
            {typeof evidence.routeFit === "number" && <span>路线适配度 {Math.round(evidence.routeFit * 100)}%</span>}
            {evidence.provenanceGroup && <span>来源依赖组 {evidence.provenanceGroup}</span>}
            {evidence.searchRound && <span>第 {evidence.searchRound} 轮检索</span>}
          </div>
        )}
      </div>
    </article>
  );
}

function EvidenceGraph({ claim }: { claim: ClaimAnalysis }) {
  const sources = claim.evidence.slice(0, 6);
  if (!sources.length) return null;
  return (
    <div className="evidence-graph" aria-label="主张与来源关系图">
      <div className="graph-claim">
        <span><Icon name="lens" size={15} />待核查主张</span>
        <strong>{claim.text}</strong>
      </div>
      <div className="graph-connector"><span /></div>
      <div className="graph-sources">
        {sources.map((source) => (
          <a className={`graph-source ${source.relation}`} href={source.url} target="_blank" rel="noreferrer" key={source.id}>
            <span>{source.domain}</span>
            <strong>{RELATION_LABELS[source.relation]}</strong>
            <small>
              {source.quoteType === "page" ? "网页原文" : source.quoteType === "abstract" ? "论文摘要" : source.quoteType === "metadata" ? "书目信息" : "搜索摘要"}
              {source.evidenceRole ? ` · ${EVIDENCE_ROLE_LABELS[source.evidenceRole]}` : ""}
              {` · 信任 ${Math.round((source.trust?.overall ?? source.quality.score / 100) * 100)}`}
            </small>
          </a>
        ))}
      </div>
    </div>
  );
}

function ReasoningAudit({ claim }: { claim: ClaimAnalysis }) {
  const argumentMap = claim.argumentMap;
  const scorecard = claim.reasoningScorecard;
  if (!argumentMap || !scorecard) return null;

  const dimensions = [
    ["前提可靠性", scorecard.premiseReliability, "前提是真的吗"],
    ["证据相关性", scorecard.evidenceRelevance, "证据说的是同一件事吗"],
    ["推理充分性", scorecard.inferenceStrength, "前提足以推出结论吗"],
    ["证据覆盖度", scorecard.evidenceCoverage, "关键环节和反证找全了吗"],
    ["来源独立性", scorecard.sourceIndependence, "是否只是同源转载"],
  ] as const;
  const findings = claim.fallacyFindings ?? [];
  const alternatives = claim.alternativeExplanations ?? [];
  const questions = claim.criticalQuestions ?? [];
  const changeMind = claim.whatWouldChangeMind ?? [];

  return (
    <div className="reasoning-audit">
      <div className="section-label-row audit-title-row">
        <div>
          <h3>论证地图</h3>
          <p>把“说了什么”与“为什么能得出结论”分开检查</p>
        </div>
        <div className="argument-tags">
          <span>{ISSUE_TYPE_LABELS[argumentMap.issueType]}</span>
          <span>{ARGUMENT_TYPE_LABELS[argumentMap.argumentType]}</span>
        </div>
      </div>

      <div className="argument-map-card">
        <div className="argument-issue">
          <span>待回答的问题</span>
          <strong>{argumentMap.issue}</strong>
        </div>
        <div className="argument-flow">
          <div className="argument-node premise-node">
            <span>明示理由 / 前提</span>
            {argumentMap.statedPremises.length > 0 ? (
              <ol>{argumentMap.statedPremises.map((premise) => <li key={premise}>{premise}</li>)}</ol>
            ) : <p>原材料没有给出明示理由，需要直接核查结论。</p>}
          </div>
          <div className="argument-arrow"><Icon name="arrow" size={18} /><small>能否推出？</small></div>
          <div className="argument-node conclusion-node">
            <span>核心结论</span>
            <strong>{argumentMap.conclusion}</strong>
          </div>
        </div>
        {(argumentMap.implicitAssumptions.length > 0 || argumentMap.ambiguousTerms.length > 0 || argumentMap.qualifiers.length > 0) && (
          <div className="argument-details">
            {argumentMap.implicitAssumptions.length > 0 && (
              <div><span>隐含假设</span><ul>{argumentMap.implicitAssumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div>
            )}
            {argumentMap.ambiguousTerms.length > 0 && (
              <div><span>歧义词</span><ul>{argumentMap.ambiguousTerms.map((item) => <li key={item.term}><b>{item.term}</b>：{item.risk}</li>)}</ul></div>
            )}
            {argumentMap.qualifiers.length > 0 && (
              <div><span>范围限定</span><p className="qualifier-list">{argumentMap.qualifiers.map((item) => <b key={item}>{item}</b>)}</p></div>
            )}
          </div>
        )}
      </div>

      <div className="audit-scorecard">
        <div className="audit-scorecard-heading">
          <div><h3>五维审计</h3><p>分数是本轮材料的覆盖程度，不是真实概率</p></div>
          <span><Icon name="shield" size={15} />LLM 分析 + 规则限幅</span>
        </div>
        <div className="audit-dimensions">
          {dimensions.map(([label, value, question]) => {
            const percent = Math.round(value.score * 100);
            const unavailable = value.status === "unknown";
            return (
              <div className={`audit-dimension ${value.status}`} key={label}>
                <div className="dimension-topline">
                  <strong>{label}</strong>
                  <small>{question}</small>
                  <b>{unavailable ? "无法评估" : `${AUDIT_STATUS_LABELS[value.status]} · ${percent}`}</b>
                </div>
                <div className="dimension-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={unavailable ? undefined : percent}>
                  <span style={{ width: unavailable ? "0" : `${percent}%` }} />
                </div>
                <p>{value.explanation}</p>
              </div>
            );
          })}
        </div>
      </div>

      {findings.length > 0 && (
        <div className="fallacy-section">
          <div className="audit-subheading">
            <div><Icon name="alert" size={18} /><h3>疑似推理风险</h3></div>
            <span>不是对作者动机或人格的判断</span>
          </div>
          <div className="fallacy-grid">
            {findings.map((finding, index) => (
              <article className={`fallacy-card severity-${finding.severity}`} key={`${finding.code}-${index}`}>
                <div className="fallacy-topline">
                  <strong>{finding.label}</strong>
                  <span>把握 {Math.round(finding.confidence * 100)}%</span>
                </div>
                <blockquote>“{finding.scope}”</blockquote>
                <dl>
                  <div><dt>为何可疑</dt><dd>{finding.explanation}</dd></div>
                  <div><dt>影响</dt><dd>{finding.impact}</dd></div>
                  <div><dt>如何补强</dt><dd>{finding.repair}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </div>
      )}

      <div className="critical-review-grid">
        <section className="counter-review-card">
          <div className="audit-subheading"><div><Icon name="brain" size={18} /><h3>最强反方检验</h3></div></div>
          <p className="counterargument">{claim.strongestCounterargument || "尚未形成可检验的反方路径。"}</p>
          {alternatives.length > 0 && (
            <div className="alternative-list">
              <span>竞争性解释</span>
              {alternatives.map((alternative, index) => (
                <div key={`${alternative.text}-${index}`}>
                  <b className={alternative.status}>{ALTERNATIVE_STATUS_LABELS[alternative.status]}</b>
                  <p><strong>{alternative.text}</strong>{alternative.assessment}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="critical-questions-card">
          <div className="audit-subheading"><div><Icon name="question" size={18} /><h3>关键质询</h3></div></div>
          <div className="question-list">
            {questions.map((question, index) => (
              <div key={`${question.question}-${index}`}>
                <span className={question.status}>{QUESTION_STATUS_LABELS[question.status]}</span>
                <p><strong>{question.question}</strong>{question.answer}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {changeMind.length > 0 && (
        <div className="change-mind-card">
          <span><Icon name="spark" size={17} />什么证据会改变当前判断？</span>
          <ul>{changeMind.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function SpecialistReviewCard({ claim }: { claim: ClaimAnalysis }) {
  const review = claim.specialistReview;
  if (!review) return null;
  const dimensions = [
    ["设计质量", review.designQuality],
    ["偏倚控制", review.biasControl],
    ["命题直接性", review.directness],
    ["样本与精度", review.precision],
    ["来源完整性", review.sourceIntegrity],
  ] as const;
  return (
    <section className="specialist-review">
      <div className="specialist-heading">
        <div>
          <span className="eyebrow">独立来源质量核验</span>
          <h3>{CRITIC_LABELS[review.criticType]}</h3>
        </div>
        <span className={`review-mode ${review.reviewedBy}`}>{review.reviewedBy === "llm" ? "隔离上下文" : "保守规则"}</span>
      </div>
      <p className="specialist-summary">{review.overallAssessment}</p>
      <details className="specialist-detail">
        <summary>查看各项检查依据</summary>
        <div className="specialist-dimensions">
          {dimensions.map(([label, item]) => (
            <div className={`specialist-dimension ${item.status}`} key={label}>
              <span>{label}</span>
              <strong>{item.status === "unknown" ? "—" : Math.round(item.score * 100)}</strong>
              <small>{item.status === "unknown" ? "无法评估" : AUDIT_STATUS_LABELS[item.status]}</small>
              <p>{item.explanation}</p>
            </div>
          ))}
        </div>
        {review.limitations.length > 0 && (
          <ul className="specialist-limitations">{review.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        )}
      </details>
    </section>
  );
}

function ClaimCard({ claim, number }: { claim: ClaimAnalysis; number: number }) {
  const [open, setOpen] = useState(number === 1);
  const [planOpen, setPlanOpen] = useState(false);
  const meta = VERDICT_META[claim.verdict];
  const warnings = claim.warnings ?? [];
  const unknowns = claim.unknowns ?? [];
  const contextChecks = claim.contextChecks ?? [];
  const decisionEvidence = claim.evidence.filter(isDecisionEvidence);
  const excludedEvidence = claim.evidence.filter((item) => !isDecisionEvidence(item));

  return (
    <section className={`claim-card verdict-${claim.verdict}`}>
      <button className="claim-heading" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="claim-number">核查点 {String(number).padStart(2, "0")}</span>
        <span className="claim-text">{claim.text}</span>
        <span className={`verdict-chip ${claim.verdict}`}>
          <Icon name={meta.icon} size={15} />
          {meta.short}
        </span>
        <Icon name="chevron" size={18} />
      </button>

      {open && (
        <div className="claim-content">
          {claim.routePlan && (
            <div className="claim-route-bar">
              <span>需要查什么</span>
              <div>{claim.routePlan.routes.map((route) => <b className={`route-chip route-${route}`} key={route}>{ROUTE_LABELS[route]}</b>)}</div>
              <p>{claim.routePlan.rationale}</p>
            </div>
          )}
          <div className="claim-assessment">
            <ConfidenceRing value={claim.confidence} />
            <div className="assessment-copy">
              <span className="eyebrow">
                证据充分度
                {claim.judgedByLlm && <b className="llm-mini-badge"><Icon name="brain" size={12} />LLM 裁决 + 规则护栏</b>}
              </span>
              <h3>{claim.conclusion || claim.verdictLabel}</h3>
              <p>{claim.reasoningSummary || "这是当前证据覆盖程度，不是主张为真的概率。"}</p>
            </div>
            <dl className="claim-stats">
              <div><dt>{decisionEvidence.length}</dt><dd>用于判断</dd></div>
              <div><dt>{claim.independentSourceCount}</dt><dd>独立来源组</dd></div>
              <div><dt>{decisionEvidence.filter((item) => ["page", "abstract"].includes(item.quoteType)).length}</dt><dd>可读原文/摘要</dd></div>
            </dl>
          </div>

          <SpecialistReviewCard claim={claim} />

          <details className="advanced-review">
            <summary><Icon name="brain" size={16} />展开逻辑与论证检查</summary>
            <ReasoningAudit claim={claim} />
          </details>

          {contextChecks.length > 0 && (
            <div className="context-checks">
              <div className="section-label-row compact"><h3>来源语境核对</h3><span>新闻时间、人物或机构、上下文与截图一致性</span></div>
              <div className="context-grid">
                {contextChecks.map((check) => (
                  <div className={`context-item ${check.status}`} key={check.type}>
                    <span className="context-status"><Icon name={check.status === "risk" ? "alert" : check.status === "clear" ? "check" : "question"} size={15} /></span>
                    <div><strong>{check.label}</strong><p>{check.explanation}</p></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(warnings.length > 0 || unknowns.length > 0) && (
            <div className="notice-grid">
              {warnings.length > 0 && (
                <div className="notice warning-notice">
                  <Icon name="alert" size={18} />
                  <div><strong>需要注意</strong>{warnings.map((item) => <p key={item}>{item}</p>)}</div>
                </div>
              )}
              {unknowns.length > 0 && (
                <div className="notice unknown-notice">
                  <Icon name="question" size={18} />
                  <div><strong>结论边界</strong>{unknowns.map((item) => <p key={item}>{item}</p>)}</div>
                </div>
              )}
            </div>
          )}

          <div className="section-label-row">
            <h3>用于本次结论的证据</h3>
            <span>{decisionEvidence.length ? "只显示真正涉及核查点的材料" : "没有材料通过相关性门槛"}</span>
          </div>
          <div className="evidence-list">
            {decisionEvidence.map((item, index) => <EvidenceCard evidence={item} index={index} key={item.id} />)}
            {!decisionEvidence.length && (
              <div className="empty-evidence">
                <Icon name="search" size={25} />
                <p>搜到了一些线索，但没有一项能直接回答这个核查点。</p>
              </div>
            )}
          </div>

          {excludedEvidence.length > 0 && (
            <details className="excluded-evidence">
              <summary>查看未采用的低相关线索（{excludedEvidence.length}）</summary>
              <p>这些结果仅有关键词重合或属于背景材料，不参与结论和研究质量评分。</p>
              <div className="evidence-list">
                {excludedEvidence.map((item, index) => <EvidenceCard evidence={item} index={index} key={item.id} />)}
              </div>
            </details>
          )}

          <button className="plan-toggle" type="button" onClick={() => setPlanOpen((value) => !value)}>
            <Icon name="search" size={16} />
            查看本轮检索计划
            <Icon name="chevron" size={15} />
          </button>
          {planOpen && (
            <div className="search-plan-wrap">
              <ol className="search-plan">
                {(claim.searchPlan ?? []).map((item) => <li key={item}>{item}</li>)}
              </ol>
              {(claim.followUpQueries ?? []).length > 0 && (
                <div className="follow-up"><strong>继续核查建议</strong>{claim.followUpQueries.map((query) => <span key={query}>{query}</span>)}</div>
              )}
              {(claim.retrievalNotes ?? []).length > 0 && (
                <div className="retrieval-notes"><strong>检索运行记录</strong>{claim.retrievalNotes!.map((note) => <p key={note}>{note}</p>)}</div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function QuestionProfileCard({ result }: { result: AnalysisResult }) {
  const profile = result.questionProfile;
  if (!profile) return null;
  return (
    <section className={`question-profile ambiguity-${profile.ambiguityLevel}`}>
      <div className="profile-heading">
        <div>
          <span className="eyebrow">本次核查范围</span>
          <h2>{profile.ambiguityLevel === "material" ? "这个问题可能有几种不同含义" : "我们核查的是这个问题"}</h2>
        </div>
        <span className="strategy-chip">{profile.strategy === "branched" ? "分别核查" : "含义明确"}</span>
      </div>
      <p className="profile-question">{profile.summary}</p>
      <p className="profile-summary">{profile.rationale}</p>
      <div className="profile-routes">
        <span>需要查阅：</span>
        {profile.routes.map((route) => <b className={`route-chip route-${route}`} key={route}>{ROUTE_LABELS[route]}</b>)}
      </div>
      {profile.interpretations.length > 0 && (
        <div className="interpretation-grid">
          {profile.interpretations.map((interpretation, index) => (
            <article key={interpretation.id}>
              <span>解释 {index + 1}</span>
              <strong>{interpretation.label}</strong>
              <p>{interpretation.description}</p>
            </article>
          ))}
        </div>
      )}
      {profile.operationalDefinitions.length > 0 && (
        <div className="definition-list">
          {profile.operationalDefinitions.map((definition) => (
            <div key={`${definition.term}-${definition.definition}`}>
              <strong>{definition.term}</strong>
              <p>{definition.definition}</p>
              <span>{definition.status === "user_supplied" ? "用户已定义" : definition.status === "assumed" ? "系统暂定定义" : "仍需用户澄清"}</span>
            </div>
          ))}
        </div>
      )}
      {profile.clarificationQuestion && <p className="clarification-question"><Icon name="question" size={17} />{profile.clarificationQuestion}</p>}
    </section>
  );
}

function Report({ result, onReset }: { result: AnalysisResult; onReset: () => void }) {
  const [copied, setCopied] = useState(false);
  const summaryMeta = VERDICT_META[result.summary.verdict];
  const usableEvidenceCount = result.claims.reduce(
    (sum, claim) => sum + claim.evidence.filter(isDecisionEvidence).length,
    0,
  );

  const copySummary = async () => {
    const lines = [
      `SourceLens 报告 · ${result.summary.headline}`,
      ...result.claims.map((claim, index) => {
        const scorecard = claim.reasoningScorecard;
        const audit = scorecard
          ? `前提 ${Math.round(scorecard.premiseReliability.score * 100)} / 相关性 ${Math.round(scorecard.evidenceRelevance.score * 100)} / 推理 ${Math.round(scorecard.inferenceStrength.score * 100)}`
          : "论证审计数据不可用";
        return `${index + 1}. ${claim.text}\n   ${claim.verdictLabel}（证据充分度 ${Math.round(claim.confidence * 100)}%）\n   ${audit}\n   ${claim.conclusion || ""}`;
      }),
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `sourcelens-${result.id.slice(0, 8)}.json`;
    link.click();
    URL.revokeObjectURL(href);
  };

  return (
    <main className="report-shell">
      <div className="report-toolbar">
        <button className="text-button" type="button" onClick={onReset}><Icon name="reset" size={17} />新建核查</button>
        <div>
          <button className="text-button" type="button" onClick={copySummary}><Icon name="copy" size={17} />{copied ? "已复制" : "复制摘要"}</button>
          <button className="text-button" type="button" onClick={downloadJson}><Icon name="download" size={17} />导出 JSON</button>
        </div>
      </div>

      <section className={`report-overview overview-${result.summary.verdict}`}>
        <div className="overview-status"><Icon name={summaryMeta.icon} size={24} /></div>
        <div className="overview-copy">
          <span className="eyebrow">
            核查结果
          </span>
          <h1>{result.summary.headline}</h1>
          <p>命题匹配与来源质量由两个隔离上下文独立核验，再由裁决器综合；“证据不足”不代表主张已被证明错误。</p>
        </div>
        <div className="overview-metrics">
          <div><strong>{result.summary.claimCount}</strong><span>核查点</span></div>
          <div><strong>{usableEvidenceCount}<small> / {result.summary.evidenceCount}</small></strong><span>采用 / 搜到</span></div>
          <div><strong>{result.summary.unknownCount}</strong><span>尚无定论</span></div>
          <div><strong>{result.summary.riskCount ?? 0}</strong><span>语境风险</span></div>
        </div>
      </section>

      <div className="report-source">
        <span>原始输入</span>
        <p>{result.sourceText}</p>
      </div>

      <QuestionProfileCard result={result} />

      <div className="report-title-row">
        <div><span className="eyebrow">逐项核查</span><h2>结论与依据</h2></div>
        <span className="report-time">生成于 {new Date(result.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
      </div>

      <div className="claims-list">
        {result.claims.map((claim, index) => <ClaimCard claim={claim} number={index + 1} key={claim.id} />)}
      </div>

      <details className="method-card method-details">
        <summary>
          <span className="method-icon"><Icon name="shield" size={22} /></span>
          <span><strong>本次核查是怎样完成的？</strong><small>查看检索渠道、处理步骤与能力边界</small></span>
          <Icon name="chevron" size={17} />
        </summary>
        <div className="method-content">
          <div className="human-pipeline" aria-label="核查流程">
            <span><b>1</b>明确问题</span>
            <span><b>2</b>定向检索</span>
            <span><b>3</b>双重独立核验</span>
            <span><b>4</b>综合裁决</span>
          </div>
          <h3>技术执行记录</h3>
          <p>
            {result.methodology.planningModel && `规划 ${result.methodology.planningModel} · `}
            {result.methodology.judgmentModel && `裁决 ${result.methodology.judgmentModel} · `}
            {result.methodology.searchProvider}
          </p>
          {result.methodology.tokenUsage && (
            <div className="token-usage">
              <span>输入 {result.methodology.tokenUsage.promptTokens.toLocaleString()} tokens</span>
              <span>输出 {result.methodology.tokenUsage.completionTokens.toLocaleString()} tokens</span>
              <span>共 {result.methodology.tokenUsage.totalTokens.toLocaleString()} tokens</span>
            </div>
          )}
          {(result.methodology.agentRuns ?? []).length > 0 && (
            <div className="agent-run-list">
              {(result.methodology.agentRuns ?? []).map((run) => (
                <div className={`agent-run run-${run.status}`} key={run.id}>
                  <span className="agent-run-status"><Icon name={run.status === "completed" ? "check" : run.status === "skipped" ? "minus" : "alert"} size={14} /></span>
                  <div>
                    <strong>{run.label}</strong>
                    <p>{run.role} · {run.detail}</p>
                  </div>
                  <small>{run.model}<br />{run.contextPolicy === "independent_request" ? "独立上下文" : run.contextPolicy === "structured_handoff" ? "结构化交接" : "确定性代码"}</small>
                </div>
              ))}
            </div>
          )}
          {result.methodology.trustModel && <p className="trust-model-note"><strong>Trust Model：</strong>{result.methodology.trustModel}</p>}
          <ul>{result.methodology.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </details>
    </main>
  );
}

export default function App() {
  const [mode, setMode] = useState<InputMode>("text");
  const [text, setText] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<RunStage>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = !["idle", "report", "error"].includes(stage);
  const inputLength = useMemo(() => text.trim().length, [text]);

  useEffect(() => {
    void fetch("/api/config")
      .then((response) => response.ok ? response.json() as Promise<RuntimeConfig> : Promise.reject(new Error("配置读取失败")))
      .then(setRuntime)
      .catch(() => setRuntime(null));
    try {
      const stored = JSON.parse(window.localStorage.getItem("sourcelens-history-v1") ?? "[]") as AnalysisResult[];
      setHistory(stored.filter((item) => item?.id && item?.summary && Array.isArray(item.claims)).slice(0, 8));
    } catch {
      setHistory([]);
    }
    return () => abortRef.current?.abort();
  }, []);

  const recordHistory = (analysis: AnalysisResult) => {
    setHistory((current) => {
      const next = [analysis, ...current.filter((item) => item.id !== analysis.id)].slice(0, 8);
      saveHistory(next);
      return next;
    });
  };

  const acceptFile = async (file?: File) => {
    if (!file) return;
    setError("");
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError("请上传 PNG、JPEG 或 WebP 图片。");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("图片需小于 8 MB。");
      return;
    }
    try {
      setImageDataUrl(await fileToDataUrl(file));
      setFileName(file.name);
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片读取失败");
    }
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => void acceptFile(event.target.files?.[0]);
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void acceptFile(event.dataTransfer.files?.[0]);
  };

  const analyze = async () => {
    if (busy) return;
    if (mode === "text" && text.trim().length < 7) {
      setError("请先输入至少 7 个字符的待核查内容。示例：某地明天起将暂停地铁运营。");
      textareaRef.current?.focus();
      return;
    }
    if (mode === "image" && !imageDataUrl) {
      setError("请先选择一张包含待核查内容的截图。");
      fileInputRef.current?.click();
      return;
    }
    setError("");
    setResult(null);
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let analysisText = text.trim();
      let ocrApplied = false;
      if (mode === "image") {
        setStage("ocr");
        setProgress({ stage: "planning", message: "正在识别截图中的文字", percent: 3 });
        const ocrResponse = await fetch("/api/ocr", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imageDataUrl }),
          signal: controller.signal,
        });
        if (!ocrResponse.ok) throw new Error(await readApiError(ocrResponse));
        const body = await ocrResponse.json() as { text: string };
        analysisText = body.text;
        setText(body.text);
        ocrApplied = true;
      } else {
        setStage("claims");
      }

      setStage("claims");
      const response = await fetch("/api/analyze/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: analysisText,
          inputKind: mode,
          ocrApplied,
          ...(mode === "image" && { imageDataUrl }),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const analysis = await readAnalysisStream(response, (update) => {
        setProgress(update);
        const stageMap: Record<AnalysisProgress["stage"], RunStage> = {
          planning: "claims",
          routing: "claims",
          searching: "search",
          reviewing: "judge",
          judging: "judge",
          complete: "report",
        };
        setStage(stageMap[update.stage]);
      });
      setResult(analysis);
      recordHistory(analysis);
      setStage("report");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "分析未完成，请稍后重试");
      setStage("error");
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setStage("idle");
    setResult(null);
    setProgress(null);
    setError("");
    setText("");
    setImageDataUrl("");
    setFileName("");
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); if (!busy) reset(); }}>
          <span className="brand-mark"><Icon name="lens" size={20} /></span>
          <span>SourceLens</span>
        </a>
        <div className="topbar-actions">
          <div className="topbar-meta">
            <span className={`live-dot ${runtime?.llmConfigured ? "agent-live" : ""}`} />
            <span>{runtime?.llmConfigured ? "证据核查已启用" : "基础核查模式"}</span>
            <span className="topbar-divider" />
            <span>{runtime?.judgmentModel ?? "正在检查模型"}</span>
          </div>
          <button className="history-button" type="button" onClick={() => setHistoryOpen(true)}>
            <Icon name="history" size={17} />
            历史
            {history.length > 0 && <b>{history.length}</b>}
          </button>
        </div>
      </header>

      {historyOpen && (
        <HistoryPanel
          items={history}
          onClose={() => setHistoryOpen(false)}
          onSelect={(item) => { setResult(item); setStage("report"); setHistoryOpen(false); window.scrollTo({ top: 0 }); }}
          onClear={() => { setHistory([]); saveHistory([]); }}
        />
      )}

      {result && stage === "report" ? <Report result={result} onReset={reset} /> : (
        <main className="workspace">
          <section className="hero">
            <div className="hero-kicker"><span />可信信息溯源工作台</div>
            <h1>别急着相信，<br /><em>先看证据，也检查推理。</em></h1>
            <p>粘贴群聊转发或上传截图。SourceLens 会先明确问题，再让两个隔离上下文的核验者分别检查“是否回答”和“来源是否可靠”，必要时才追加反证检索。</p>
          </section>

          <section className="input-card">
            <div className="mode-tabs" role="tablist" aria-label="输入方式">
              <button
                className={mode === "text" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={mode === "text"}
                onClick={() => { setMode("text"); setError(""); }}
                disabled={busy}
              >
                <Icon name="text" size={18} />粘贴文本
              </button>
              <button
                className={mode === "image" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={mode === "image"}
                onClick={() => { setMode("image"); setError(""); }}
                disabled={busy}
              >
                <Icon name="image" size={18} />上传截图
              </button>
              <span className={`tab-indicator ${mode}`} />
            </div>

            <div className="agent-strip">
              <span><Icon name="brain" size={15} />明确核查点</span>
              <Icon name="arrow" size={13} />
              <span>定向找来源</span>
              <Icon name="arrow" size={13} />
              <span>双重独立核验</span>
              <Icon name="arrow" size={13} />
              <span>给出有边界的结论</span>
            </div>

            <div className="input-body">
              {mode === "text" ? (
                <div className="text-input-wrap">
                  <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={(event) => { setText(event.target.value); if (error) setError(""); }}
                    placeholder="粘贴需要溯源的转发文本…&#10;&#10;例如：网传某地明天起将暂停地铁运营，这是真的吗？"
                    maxLength={8_000}
                    disabled={busy}
                    autoFocus
                  />
                  <div className="input-actions">
                    <button
                      className="sample-button"
                      type="button"
                      onClick={() => { setText(SAMPLE_TEXT); setError(""); }}
                      disabled={busy}
                    >
                      <Icon name="spark" size={15} />填入示例
                    </button>
                    <span className={inputLength > 0 && inputLength < 7 ? "input-count-warning" : ""}>
                      {inputLength > 0 && inputLength < 7 ? `还需 ${7 - inputLength} 字 · ` : ""}{inputLength.toLocaleString()} / 8,000
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className={`dropzone ${dragging ? "dragging" : ""} ${imageDataUrl ? "has-image" : ""}`}
                  onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                >
                  <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFile} hidden />
                  {imageDataUrl ? (
                    <>
                      <img src={imageDataUrl} alt="待识别截图预览" />
                      <div className="image-overlay">
                        <span>{fileName}</span>
                        <button type="button" onClick={() => { setImageDataUrl(""); setFileName(""); }} disabled={busy} aria-label="移除图片">
                          <Icon name="close" size={18} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="dropzone-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                      <span className="upload-icon"><Icon name="upload" size={26} /></span>
                      <strong>拖入截图，或点击选择</strong>
                      <span>支持 PNG / JPEG / WebP，最大 8 MB</span>
                      <small>中英文 OCR + 多模态图文检查 · 图片仅用于本次分析</small>
                    </button>
                  )}
                </div>
              )}

              {error && <div className="form-error"><Icon name="alert" size={17} />{error}</div>}

              {busy ? (
                <div className="running-panel">
                  <div className="running-copy">
                    <Spinner />
                    <div>
                      <strong>{progress?.message ?? (stage === "ocr" ? "正在识别截图文字" : "正在开始核查")}</strong>
                      <span>{progress?.detail ?? (stage === "judge" ? "只使用本轮找到且能够追溯的证据…" : "完整核查通常需要 30–90 秒…")}</span>
                    </div>
                  </div>
                  <div className="progress-track"><span style={{ width: `${progress?.percent ?? 3}%` }} /></div>
                  <StageRail stage={stage} />
                  <button className="cancel-button" type="button" onClick={() => { abortRef.current?.abort(); setStage("idle"); }}>取消</button>
                </div>
              ) : (
                <button className="analyze-button" type="button" onClick={() => void analyze()}>
                  <Icon name="brain" size={20} />
                  开始核查
                  <span><Icon name="arrow" size={17} /></span>
                </button>
              )}
            </div>
          </section>

          <section className="principles" aria-label="产品原则">
            <div><span className="principle-icon"><Icon name="link" size={19} /></span><p><strong>重建论证</strong><small>区分结论、理由与隐含假设</small></p></div>
            <div><span className="principle-icon"><Icon name="shield" size={19} /></span><p><strong>三道逻辑护栏</strong><small>前提可靠、证据相关、推理充分</small></p></div>
            <div><span className="principle-icon"><Icon name="question" size={19} /></span><p><strong>主动挑战结论</strong><small>寻找反例、替代解释与证伪条件</small></p></div>
          </section>

          <aside className="baseline-note">
            <span>怎样阅读结果</span>
            <p>先看系统实际核查了什么，再看结论与采用的证据。没有通过相关性筛选的搜索结果会单独折叠，不会混进主要依据。</p>
          </aside>
        </main>
      )}

      <footer>
        <span>SourceLens / 可复核的信息溯源</span>
        <span>模型记忆不作为证据 · 网页内容始终按不可信数据处理</span>
      </footer>
    </div>
  );
}
