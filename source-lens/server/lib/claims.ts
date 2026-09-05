import type { ClaimSeed } from "../../shared/types";
import { buildFallbackAdversarialPlan, buildFallbackArgumentMap } from "./logic";

const LEADING_NOISE = [
  /^\s*(网传(?:消息)?(?:称)?|消息称|据悉|据说|听说|转发|速看|重磅|突发|刚刚|最新消息)[：:，,\s]*/i,
  /^\s*[【\[].{0,24}?[】\]]\s*/,
];

const NON_CLAIM_PATTERNS = [
  /^(请|欢迎|点击|扫码|关注|转发|收藏|点赞|评论|告诉).{0,20}$/,
  /^(真的吗|真的假的|有人知道吗|求证|谁知道)[？?]?$/,
  /^(http|www\.)/i,
];

const ASSERTION_MARKERS = /(?:是|为|有|将|已|于|在|达|超过|发布|宣布|发生|导致|发现|完成|取消|禁止|恢复|上涨|下降|增长|减少|获得|成为|推出|实施|回应|证实|否认|显示|称|表示|成功|首次|停止|开始|来自|造成|带回|携带)/;
const DATE_OR_NUMBER = /(?:\d|[一二三四五六七八九十百千万亿两]+(?:年|月|日|人|例|个|次|%|成|元|吨|公里))/;

const SEARCH_FILLERS = [
  "网传",
  "据说",
  "据悉",
  "消息称",
  "有人说",
  "真的假的",
  "请大家转发",
  "紧急通知",
];

export function normalizeInputText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff0-9])/g, "$1")
    .replace(/([0-9])[ \t]+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanSegment(segment: string): string {
  let cleaned = segment
    .replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, "")
    .replace(/^[“\"']|[”\"']$/g, "")
    .trim();

  for (const pattern of LEADING_NOISE) cleaned = cleaned.replace(pattern, "");
  return cleaned.replace(/[，,：:]$/, "").trim();
}

function looksVerifiable(text: string): boolean {
  if (text.length < 7 || text.length > 220) return false;
  if (NON_CLAIM_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (/[？?]$/.test(text) && !ASSERTION_MARKERS.test(text)) return false;
  return ASSERTION_MARKERS.test(text) || DATE_OR_NUMBER.test(text) || text.length >= 16;
}

function splitLongSegment(segment: string): string[] {
  const clauses = segment
    .split(/(?<=.{7})(?:，|,)(?=(?:同时|此外|并且|并|而且|但|但是|不过|另有|其后))/)
    .map(cleanSegment)
    .filter(Boolean);
  if (clauses.length <= 1) return [segment];

  const subject = clauses[0].match(/^(.{2,20}?)(?=(?:于|在|是|为|有|将|已|发布|宣布|发生|发现|完成|取消|否认|显示|称|表示|成功|首次|停止|开始|带回|携带))/)?.[1]?.trim();
  return clauses.map((clause, index) => {
    if (index === 0) return clause;
    const withoutConnector = clause.replace(/^(?:同时|此外|并且|并|而且|但|但是|不过|另有|其后)[，,\s]*/, "");
    if (subject && /^(?:于|在|是|为|有|将|已|发布|宣布|发生|发现|完成|取消|否认|显示|称|表示|成功|首次|停止|开始|带回|携带)/.test(withoutConnector)) {
      return `${subject}${withoutConnector}`;
    }
    return withoutConnector;
  });
}

export function buildSearchQuery(claim: string): string {
  let query = claim;
  for (const filler of SEARCH_FILLERS) query = query.replaceAll(filler, "");
  query = query
    .replace(/[“”"']/g, "")
    .replace(/[！!？?。；;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return query.length > 72 ? query.slice(0, 72) : query;
}

export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const match of text.matchAll(/[《“「『](.{2,24}?)[》”」』]/g)) {
    entities.add(match[1]);
  }
  for (const match of text.matchAll(/(?:[A-Z][A-Za-z0-9-]{1,20}|[\u4e00-\u9fff]{2,12}(?:公司|大学|医院|研究院|委员会|政府|部门|中心|集团|卫健委|警方|法院|博物馆|空间站))/g)) {
    entities.add(match[0]);
  }
  return [...entities].slice(0, 6);
}

export function extractAtomicClaims(input: string, limit = 5): ClaimSeed[] {
  const normalized = normalizeInputText(input);
  if (!normalized) return [];

  const roughSegments = normalized
    .split(/(?:\n+|(?<=[。！？!?；;]))/)
    .flatMap((segment) => segment.split(/(?=\s*(?:[-*•·]|\d+[.)、])\s+)/))
    .map(cleanSegment)
    .filter(Boolean)
    .flatMap(splitLongSegment)
    .map((segment) => segment.replace(/[。！!；;]+$/, "").trim())
    .filter(looksVerifiable);

  const deduped: string[] = [];
  for (const segment of roughSegments) {
    const fingerprint = segment.replace(/[\s，,。！？!?；;：“”"']/g, "").toLowerCase();
    if (!deduped.some((item) => item.replace(/[\s，,。！？!?；;：“”"']/g, "").toLowerCase() === fingerprint)) {
      deduped.push(segment);
    }
  }

  if (!deduped.length && normalized.length >= 7) deduped.push(normalized.slice(0, 220));

  return deduped.slice(0, limit).map((text, index) => {
    const argumentMap = buildFallbackArgumentMap(text, "other");
    return {
      id: `claim-${index + 1}`,
      text,
      query: buildSearchQuery(text),
      queries: [buildSearchQuery(text)],
      entities: extractEntities(text),
      claimType: "other",
      timeScope: null,
      verificationPoints: ["确认主张中的主体、时间和事件是否与原始来源一致"],
      extractionMethod: "rules",
      argumentMap,
      adversarialPlan: buildFallbackAdversarialPlan(argumentMap),
    };
  });
}
