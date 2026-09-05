export type Verdict = "supported" | "refuted" | "misleading" | "disputed" | "insufficient" | "unknown";
export type EvidenceRelation = "supporting_context" | "counter_signal" | "related";
export type ClaimType = "event" | "number" | "quote" | "causal" | "policy" | "identity" | "image_context" | "other";
export type ContextCheckType = "old_news" | "out_of_context" | "subject_confusion" | "image_text_mismatch";
export type ContextCheckStatus = "risk" | "clear" | "unknown";
export type IssueType = "descriptive" | "evaluative" | "prescriptive" | "mixed";
export type ArgumentType = "factual" | "causal" | "generalization" | "authority" | "analogy" | "deductive" | "statistical" | "policy" | "other";
export type AuditStatus = "strong" | "mixed" | "weak" | "unknown";
export type CriticalQuestionStatus = "answered" | "partial" | "open";
export type AlternativeStatus = "plausible" | "weakened" | "unresolved";
export type EvidenceRoute =
  | "scientific"
  | "event_fact"
  | "official_record"
  | "statistics"
  | "legal_policy"
  | "conceptual"
  | "normative";
export type SourceCategory =
  | "systematic_review"
  | "academic_paper"
  | "academic_index"
  | "official_record"
  | "official_statistics"
  | "authoritative_news"
  | "news"
  | "aggregator"
  | "social"
  | "general_web";
export type EvidenceRole = "direct" | "indirect" | "background" | "irrelevant";
export type CriticType = "scientific" | "news" | "statistics" | "policy" | "conceptual" | "general";
export type FallacyCode =
  | "causal_oversimplification"
  | "correlation_causation"
  | "hasty_generalization"
  | "base_rate_neglect"
  | "survivorship_bias"
  | "equivocation"
  | "false_dilemma"
  | "circular_reasoning"
  | "argument_from_ignorance"
  | "appeal_to_authority"
  | "cherry_picking"
  | "misleading_statistics"
  | "straw_man"
  | "other";

export interface AmbiguousTerm {
  term: string;
  interpretations: string[];
  risk: string;
}

export interface QuestionInterpretation {
  id: string;
  label: string;
  description: string;
  routes: EvidenceRoute[];
}

export interface OperationalDefinition {
  term: string;
  definition: string;
  status: "user_supplied" | "assumed" | "needs_clarification";
}

export interface QuestionProfile {
  summary: string;
  ambiguityLevel: "low" | "material";
  interpretations: QuestionInterpretation[];
  operationalDefinitions: OperationalDefinition[];
  strategy: "direct" | "branched";
  clarificationQuestion: string | null;
  routes: EvidenceRoute[];
  rationale: string;
  profiledBy: "llm" | "rules";
}

export interface ClaimRoutePlan {
  primaryRoute: EvidenceRoute;
  routes: EvidenceRoute[];
  rationale: string;
  sourcePriorities: string[];
  freshnessRequired: boolean;
}

export interface ArgumentMap {
  issue: string;
  issueType: IssueType;
  conclusion: string;
  argumentType: ArgumentType;
  statedPremises: string[];
  implicitAssumptions: string[];
  ambiguousTerms: AmbiguousTerm[];
  qualifiers: string[];
}

export interface AdversarialPlan {
  strongestCounterargument: string;
  alternativeExplanations: string[];
  missingInformation: string[];
  falsificationQueries: string[];
}

export interface AuditDimension {
  score: number;
  status: AuditStatus;
  explanation: string;
}

export interface ReasoningScorecard {
  premiseReliability: AuditDimension;
  evidenceRelevance: AuditDimension;
  inferenceStrength: AuditDimension;
  evidenceCoverage: AuditDimension;
  sourceIndependence: AuditDimension;
}

export interface FallacyFinding {
  code: FallacyCode;
  label: string;
  confidence: number;
  severity: "low" | "medium" | "high";
  scope: string;
  explanation: string;
  impact: string;
  repair: string;
  evidenceIds: string[];
}

export interface AlternativeExplanation {
  text: string;
  status: AlternativeStatus;
  assessment: string;
  evidenceIds: string[];
}

export interface CriticalQuestion {
  question: string;
  status: CriticalQuestionStatus;
  answer: string;
  evidenceIds: string[];
}

export interface ClaimSeed {
  id: string;
  text: string;
  query: string;
  queries: string[];
  entities: string[];
  claimType: ClaimType;
  timeScope: string | null;
  verificationPoints: string[];
  extractionMethod: "llm" | "rules";
  interpretationId?: string | null;
  routePlan?: ClaimRoutePlan;
  argumentMap?: ArgumentMap;
  adversarialPlan?: AdversarialPlan;
}

export interface SourceQuality {
  score: number;
  label: "较高" | "一般" | "较低";
  reasons: string[];
}

export interface TrustProfile {
  overall: number;
  sourcePrior: number;
  routeFit: number;
  primaryness: number;
  freshness: number;
  independence: number;
  label: "较高" | "一般" | "较低";
  reasons: string[];
  model: "rules-v1";
}

export interface EvidenceItem {
  id: string;
  title: string;
  url: string;
  domain: string;
  publishedAt: string | null;
  accessedAt: string;
  quote: string;
  quoteType: "page" | "abstract" | "metadata" | "search_snippet";
  relation: EvidenceRelation;
  relationExplanation?: string;
  relevance: number;
  sourceKind: string;
  sourceCategory?: SourceCategory;
  provider?: "web" | "openalex" | "pubmed";
  doi?: string | null;
  quality: SourceQuality;
  evidenceRole?: EvidenceRole;
  directness?: number;
  routeFit?: number;
  rankerExplanation?: string;
  provenanceGroup?: string;
  trust?: TrustProfile;
  promptInjectionIgnored: boolean;
  searchQuery?: string;
  searchRound?: number;
}

export interface SpecialistReview {
  criticType: CriticType;
  overallAssessment: string;
  designQuality: AuditDimension;
  biasControl: AuditDimension;
  directness: AuditDimension;
  precision: AuditDimension;
  sourceIntegrity: AuditDimension;
  limitations: string[];
  evidenceIds: string[];
  reviewedBy: "llm" | "rules";
}

export interface AgentRun {
  id: string;
  label: string;
  role: string;
  model: string;
  status: "completed" | "fallback" | "skipped";
  contextPolicy: "independent_request" | "structured_handoff" | "deterministic";
  detail: string;
}

export interface ContextCheck {
  type: ContextCheckType;
  label: string;
  status: ContextCheckStatus;
  explanation: string;
  evidenceIds: string[];
}

export interface ClaimAnalysis {
  id: string;
  text: string;
  query: string;
  entities: string[];
  verdict: Verdict;
  verdictLabel: string;
  confidence: number;
  conclusion: string;
  reasoningSummary: string;
  evidence: EvidenceItem[];
  independentSourceCount: number;
  searchPlan: string[];
  searchRounds: number;
  extractionMethod: "llm" | "rules";
  judgedByLlm: boolean;
  contextChecks: ContextCheck[];
  counterEvidenceIds: string[];
  followUpQueries: string[];
  warnings: string[];
  retrievalNotes?: string[];
  unknowns: string[];
  argumentMap: ArgumentMap;
  reasoningScorecard: ReasoningScorecard;
  fallacyFindings: FallacyFinding[];
  alternativeExplanations: AlternativeExplanation[];
  criticalQuestions: CriticalQuestion[];
  whatWouldChangeMind: string[];
  strongestCounterargument: string;
  routePlan?: ClaimRoutePlan;
  specialistReview?: SpecialistReview;
}

export interface AnalysisResult {
  id: string;
  createdAt: string;
  input: {
    kind: "text" | "image";
    characterCount: number;
    ocrApplied: boolean;
  };
  sourceText: string;
  questionProfile?: QuestionProfile;
  summary: {
    headline: string;
    verdict: Verdict;
    claimCount: number;
    evidenceCount: number;
    readableEvidenceCount: number;
    unknownCount: number;
    riskCount: number;
  };
  claims: ClaimAnalysis[];
  methodology: {
    version: string;
    searchProvider: string;
    pipeline: "multi_agent" | "llm_agent" | "deterministic_fallback";
    llmUsed: boolean;
    planningModel: string | null;
    judgmentModel: string | null;
    visionModel: string | null;
    searchRounds: number;
    tokenUsage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    } | null;
    agentRuns?: AgentRun[];
    trustModel?: string;
    limitations: string[];
  };
}

export interface RuntimeConfig {
  llmConfigured: boolean;
  provider: "DeepSeek" | "Rules only";
  planningModel: string | null;
  judgmentModel: string | null;
  visionModel: string | null;
  searchProvider: string;
  version: string;
  agentArchitecture?: string;
}

export interface AnalysisProgress {
  stage: "planning" | "routing" | "searching" | "reviewing" | "judging" | "complete";
  message: string;
  detail?: string;
  percent: number;
}

export interface ApiError {
  error: string;
  detail?: string;
}
