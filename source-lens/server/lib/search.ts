import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { ClaimSeed, EvidenceItem } from "../../shared/types";
import { readCache, writeCache } from "./cache";
import {
  detectPromptInjection,
  inferRelation,
  relevanceScore,
  scoreSource,
} from "./evidence";

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

interface PageExtract {
  title: string;
  passages: string[];
  publishedAt: string | null;
  promptInjectionIgnored: boolean;
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string;
  publication_date?: string | null;
  type?: string;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: {
    landing_page_url?: string | null;
    source?: { display_name?: string | null } | null;
  } | null;
}

interface PubMedRecord {
  pmid: string;
  title: string;
  abstract: string;
  journal: string;
  publishedAt: string | null;
  publicationTypes: string[];
  doi: string | null;
}

const USER_AGENT = "Mozilla/5.0 (compatible; SourceLens-MVP/0.1; +local-research-tool)";
const MAX_RESPONSE_BYTES = 1_500_000;
const SEARCH_CACHE_TTL = 30 * 60 * 1_000;
const PAGE_CACHE_TTL = 6 * 60 * 60 * 1_000;
const ACADEMIC_CACHE_TTL = 24 * 60 * 60 * 1_000;

export function isEnglishAcademicQuery(query: string): boolean {
  const latinTerms = query.match(/[a-z][a-z0-9-]{2,}/gi) ?? [];
  const cjkCharacters = query.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const latinCharacters = latinTerms.join("").length;
  return cjkCharacters === 0 && latinTerms.length >= 2 && latinCharacters >= 8;
}

const SCIENTIFIC_SUBJECT_ANCHORS: Array<[RegExp, RegExp]> = [
  [/(?:\bDHA\b|二十二碳六烯酸)/i, /(?:\bDHA\b|docosahexaenoic)/i],
  [/(?:\bEPA\b|二十碳五烯酸)/i, /(?:\bEPA\b|eicosapentaenoic)/i],
  [/(?:维生素\s*D|vitamin\s*D)/i, /(?:vitamin\s*D|cholecalciferol|ergocalciferol)/i],
  [/(?:褪黑素|melatonin)/i, /melatonin/i],
  [/(?:咖啡因|caffeine)/i, /caffeine/i],
  [/(?:咖啡|coffee)/i, /coffee/i],
  [/(?:间歇性禁食|断食|intermittent fasting)/i, /(?:intermittent fasting|time-restricted (?:feeding|eating))/i],
  [/(?:鱼油|omega[- ]?3|欧米伽.?3)/i, /(?:fish oil|omega[- ]?3|n-3 fatty|eicosapentaenoic|docosahexaenoic)/i],
];

export function hasScientificSubjectAnchor(claimText: string, candidateText: string): boolean {
  const requirement = SCIENTIFIC_SUBJECT_ANCHORS.find(([sourcePattern]) => sourcePattern.test(claimText));
  return requirement ? requirement[1].test(candidateText) : true;
}

function decodeResultUrl(href: string): string | null {
  try {
    const absolute = new URL(href, "https://duckduckgo.com");
    const redirected = absolute.searchParams.get("uddg");
    const candidate = redirected ? decodeURIComponent(redirected) : absolute.href;
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function isSafePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    const ipVersion = isIP(host);
    if (ipVersion === 4) {
      const octets = host.split(".").map(Number);
      if (
        octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      ) return false;
    }
    if (ipVersion === 6 && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"))) return false;
    return true;
  } catch {
    return false;
  }
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const remaining = MAX_RESPONSE_BYTES - size;
      chunks.push(value.slice(0, remaining));
      size += Math.min(value.length, remaining);
    }
  }
  void reader.cancel().catch(() => undefined);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const charset = response.headers.get("content-type")?.match(/charset=["']?([^;"'\s]+)/i)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset || "utf-8").decode(merged);
  } catch {
    return new TextDecoder("utf-8").decode(merged);
  }
}

export async function searchWeb(query: string, limit = 5): Promise<SearchHit[]> {
  const cacheKey = `${query}\n${limit}`;
  const cached = await readCache<SearchHit[]>("search", cacheKey, SEARCH_CACHE_TTL);
  if (cached) return cached;
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const hits: SearchHit[] = [];
  $(".result").each((_, element) => {
    if (hits.length >= limit) return false;
    const anchor = $(element).find(".result__a").first();
    const url = decodeResultUrl(anchor.attr("href") ?? "");
    if (!url || !isSafePublicUrl(url)) return;
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title) hits.push({ title, url, snippet });
  });
  await writeCache("search", cacheKey, hits);
  return hits;
}

function parseDate(value: string): string | null {
  const match = value.match(/\b(20\d{2})[年\-/.](0?[1-9]|1[0-2])[月\-/.](0?[1-9]|[12]\d|3[01])日?\b/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function normalizePassage(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^(?:分享|打印|关闭)\s*/g, "").trim();
}

async function fetchPage(url: string): Promise<PageExtract | null> {
  if (!isSafePublicUrl(url)) return null;
  const cached = await readCache<PageExtract>("pages", url, PAGE_CACHE_TTL);
  if (cached) return cached;
  try {
    let currentUrl = url;
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 4; redirect += 1) {
      if (!isSafePublicUrl(currentUrl)) return null;
      response = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) return null;
      currentUrl = new URL(location, currentUrl).href;
      response = null;
    }
    if (!response) return null;
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) return null;
    const html = await readLimitedText(response);
    const $ = cheerio.load(html);
    $("script,style,noscript,svg,nav,footer,aside,form,iframe").remove();
    const title = $("title").first().text().replace(/\s+/g, " ").trim();
    const metaDate =
      $('meta[property="article:published_time"]').attr("content") ??
      $('meta[name="publishdate"]').attr("content") ??
      $('meta[name="date"]').attr("content") ??
      "";
    const visibleDate = [
      $("time").first().attr("datetime") ?? "",
      $("time").first().text(),
      $('[class*="publish"], [class*="time"], [class*="date"], [id*="publish"], [id*="time"], [id*="date"]')
        .slice(0, 8)
        .map((_, node) => $(node).text())
        .get()
        .join(" "),
    ].join(" ");
    const candidates: string[] = [];
    $("article p, main p, [class*=content] p, [class*=article] p, p").each((_, node) => {
      const passage = normalizePassage($(node).text());
      if (passage.length >= 45 && passage.length <= 900 && !candidates.includes(passage)) candidates.push(passage);
    });
    const joined = candidates.slice(0, 80).join(" ");
    const extracted = {
      title,
      passages: candidates.slice(0, 80),
      publishedAt: parseDate(metaDate) ?? parseDate(visibleDate),
      promptInjectionIgnored: detectPromptInjection(joined),
    };
    await writeCache("pages", url, extracted);
    return extracted;
  } catch {
    return null;
  }
}

function trimQuote(value: string): string {
  const clean = normalizePassage(value);
  return clean.length > 320 ? `${clean.slice(0, 318)}…` : clean;
}

function rebuildAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  let maxPosition = -1;
  for (const positions of Object.values(index)) {
    for (const position of positions) maxPosition = Math.max(maxPosition, position);
  }
  if (maxPosition < 0 || maxPosition > 8_000) return "";
  const words = new Array<string>(maxPosition + 1);
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function normalizeDoi(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim().toLowerCase() || null;
}

function safeAcademicUrl(work: OpenAlexWork): string {
  const candidates = [work.primary_location?.landing_page_url, work.doi, work.id];
  return candidates.find((candidate): candidate is string => Boolean(candidate && isSafePublicUrl(candidate)))
    ?? "https://openalex.org";
}

export async function collectAcademicEvidence(
  claim: ClaimSeed,
  query: string,
  round = 1,
  limit = 5,
): Promise<EvidenceItem[]> {
  const academicQuery = query
    .replace(/\b(?:systematic review|meta[- ]analysis|research evidence|study evidence)\b/gi, " ")
    .replace(/(?:系统综述|荟萃分析|研究证据)/g, " ")
    .replace(/\s+/g, " ")
    .trim() || query;
  const cacheKey = `${academicQuery}\n${limit}`;
  let works = await readCache<OpenAlexWork[]>("openalex", cacheKey, ACADEMIC_CACHE_TTL);
  if (!works) {
    const endpoint = new URL("https://api.openalex.org/works");
    endpoint.searchParams.set("search", academicQuery);
    endpoint.searchParams.set("per-page", String(Math.max(1, Math.min(10, limit))));
    endpoint.searchParams.set(
      "select",
      "id,doi,display_name,publication_date,type,cited_by_count,abstract_inverted_index,primary_location",
    );
    const response = await fetch(endpoint, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenAlex 返回 ${response.status}`);
    const body = await response.json() as { results?: OpenAlexWork[] };
    works = body.results ?? [];
    await writeCache("openalex", cacheKey, works);
  }

  const accessedAt = new Date().toISOString();
  return works
    .map((work): EvidenceItem | null => {
      const title = work.display_name?.replace(/\s+/g, " ").trim();
      if (!title) return null;
      const abstract = rebuildAbstract(work.abstract_inverted_index);
      if (!hasScientificSubjectAnchor(claim.text, `${title} ${abstract}`)) return null;
      const journal = work.primary_location?.source?.display_name?.trim();
      const isSystematicReview = /(?:systematic review|meta-analysis|系统综述|荟萃分析)/i.test(`${title} ${abstract}`);
      const isReview = work.type === "review";
      const quoteType = abstract ? "abstract" as const : "metadata" as const;
      const quote = abstract
        ? (abstract.length > 700 ? `${abstract.slice(0, 698)}…` : abstract)
        : `${journal ? `收录于 ${journal}。` : "OpenAlex 收录的研究记录。"}${work.type ? `文献类型：${work.type}。` : ""}未取得摘要，不能仅凭标题支持结论。`;
      const url = safeAcademicUrl(work);
      const domain = new URL(url).hostname.replace(/^www\./, "");
      const relevance = Math.max(
        relevanceScore(claim.text, `${title} ${abstract}`),
        relevanceScore(academicQuery, `${title} ${abstract}`),
      );
      const score = Math.max(45, Math.min(90, (isSystematicReview ? 86 : isReview ? 79 : 76) - (abstract ? 0 : 16)));
      return {
        id: `${claim.id}-oa-${createHash("sha1").update(work.id ?? `${title}${work.publication_date}`).digest("hex").slice(0, 10)}`,
        title,
        url,
        domain,
        publishedAt: work.publication_date ?? null,
        accessedAt,
        quote,
        quoteType,
        relation: inferRelation(claim.text, quote, relevance),
        relevance,
        sourceKind: isSystematicReview
          ? "系统综述（OpenAlex 索引）"
          : isReview
            ? "综述论文（OpenAlex 索引）"
            : "学术研究（OpenAlex 索引）",
        sourceCategory: isSystematicReview ? "systematic_review" : abstract ? "academic_paper" : "academic_index",
        provider: "openalex",
        doi: normalizeDoi(work.doi),
        quality: {
          score,
          label: score >= 76 ? "较高" : score >= 50 ? "一般" : "较低",
          reasons: [
            "由 OpenAlex 学术索引发现",
            isSystematicReview
              ? "标题或摘要明确标识为系统综述/Meta 分析；仍需检查综述方法"
              : isReview
                ? "OpenAlex 标记为综述论文，但不能据此假定为系统综述"
                : "单篇研究不能自动代表领域共识",
            abstract ? "已取得摘要，方法和结果仍需全文复核" : "未取得摘要，标题不能作为直接证据",
          ],
        },
        promptInjectionIgnored: false,
        searchQuery: query,
        searchRound: round,
      };
    })
    .filter((item): item is EvidenceItem => Boolean(item))
    .sort((left, right) => (right.relevance + right.quality.score / 300) - (left.relevance + left.quality.score / 300));
}

function pubMedDate(article: cheerio.Cheerio<any>): string | null {
  const yearText = article.find("JournalIssue PubDate Year").first().text()
    || article.find("ArticleDate Year").first().text()
    || article.find("JournalIssue PubDate MedlineDate").first().text();
  const year = yearText.match(/(?:19|20)\d{2}/)?.[0];
  if (!year) return null;
  const monthText = article.find("JournalIssue PubDate Month").first().text()
    || article.find("ArticleDate Month").first().text();
  const dayText = article.find("JournalIssue PubDate Day").first().text()
    || article.find("ArticleDate Day").first().text();
  const monthNames: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const parsedMonth = /^\d{1,2}$/.test(monthText)
    ? Number(monthText)
    : monthNames[monthText.slice(0, 3).toLowerCase()] ?? 1;
  const parsedDay = /^\d{1,2}$/.test(dayText) ? Number(dayText) : 1;
  return `${year}-${String(Math.max(1, Math.min(12, parsedMonth))).padStart(2, "0")}-${String(Math.max(1, Math.min(31, parsedDay))).padStart(2, "0")}`;
}

export function parsePubMedXml(xml: string): PubMedRecord[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("PubmedArticle").map((_, node) => {
    const article = $(node);
    const pmid = article.find("MedlineCitation > PMID").first().text().trim();
    const title = article.find("Article > ArticleTitle").first().text().replace(/\s+/g, " ").trim();
    const abstract = article.find("Article > Abstract > AbstractText").map((__, abstractNode) => {
      const section = $(abstractNode);
      const label = section.attr("Label")?.trim();
      const body = section.text().replace(/\s+/g, " ").trim();
      return label && body ? `${label}: ${body}` : body;
    }).get().filter(Boolean).join(" ");
    const journal = article.find("Article > Journal > Title").first().text().replace(/\s+/g, " ").trim();
    const publicationTypes = article.find("Article > PublicationTypeList > PublicationType")
      .map((__, typeNode) => $(typeNode).text().trim())
      .get()
      .filter(Boolean);
    const doi = normalizeDoi(article.find('PubmedData ArticleId[IdType="doi"]').first().text());
    if (!pmid || !title) return null;
    return { pmid, title, abstract, journal, publishedAt: pubMedDate(article), publicationTypes, doi };
  }).get().filter((record): record is PubMedRecord => Boolean(record));
}

export async function collectPubMedEvidence(
  claim: ClaimSeed,
  query: string,
  round = 1,
  limit = 5,
): Promise<EvidenceItem[]> {
  if (!isEnglishAcademicQuery(query)) return [];
  const cacheKey = `${query}\n${limit}`;
  let records = await readCache<PubMedRecord[]>("pubmed", cacheKey, ACADEMIC_CACHE_TTL);
  if (!records) {
    const searchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    searchUrl.searchParams.set("db", "pubmed");
    searchUrl.searchParams.set("term", query);
    searchUrl.searchParams.set("retmode", "json");
    searchUrl.searchParams.set("retmax", String(Math.max(1, Math.min(10, limit))));
    searchUrl.searchParams.set("sort", "relevance");
    const searchResponse = await fetch(searchUrl, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!searchResponse.ok) throw new Error(`PubMed 检索返回 ${searchResponse.status}`);
    const searchBody = await searchResponse.json() as { esearchresult?: { idlist?: string[] } };
    const ids = searchBody.esearchresult?.idlist ?? [];
    if (!ids.length) return [];

    const fetchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
    fetchUrl.searchParams.set("db", "pubmed");
    fetchUrl.searchParams.set("id", ids.join(","));
    fetchUrl.searchParams.set("retmode", "xml");
    const fetchResponse = await fetch(fetchUrl, {
      headers: { "user-agent": USER_AGENT, accept: "application/xml,text/xml" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!fetchResponse.ok) throw new Error(`PubMed 详情返回 ${fetchResponse.status}`);
    records = parsePubMedXml(await readLimitedText(fetchResponse));
    await writeCache("pubmed", cacheKey, records);
  }

  const accessedAt = new Date().toISOString();
  return records
    .filter((record) => hasScientificSubjectAnchor(claim.text, `${record.title} ${record.abstract}`))
    .map((record): EvidenceItem => {
    const types = record.publicationTypes.join(" ");
    const isSystematicReview = /systematic review|meta-analysis/i.test(`${record.title} ${types}`);
    const isRandomizedTrial = /randomized controlled trial|controlled clinical trial/i.test(types);
    const quoteType = record.abstract ? "abstract" as const : "metadata" as const;
    const quote = record.abstract
      ? (record.abstract.length > 1_100 ? `${record.abstract.slice(0, 1_098)}…` : record.abstract)
      : `${record.journal ? `收录于 ${record.journal}。` : "PubMed 收录记录。"}未取得摘要，不能仅凭标题支持结论。`;
    const relevance = Math.max(
      relevanceScore(query, `${record.title} ${record.abstract}`),
      relevanceScore(claim.text, `${record.title} ${record.abstract}`),
    );
    const baseScore = isSystematicReview ? 90 : isRandomizedTrial ? 87 : 82;
    const score = Math.max(55, baseScore - (record.abstract ? 0 : 16));
    return {
      id: `${claim.id}-pm-${record.pmid}`,
      title: record.title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`,
      domain: "pubmed.ncbi.nlm.nih.gov",
      publishedAt: record.publishedAt,
      accessedAt,
      quote,
      quoteType,
      relation: inferRelation(claim.text, quote, relevance),
      relevance,
      sourceKind: isSystematicReview
        ? "系统综述（PubMed）"
        : isRandomizedTrial
          ? "随机对照试验（PubMed）"
          : "学术研究（PubMed）",
      sourceCategory: isSystematicReview ? "systematic_review" : "academic_paper",
      provider: "pubmed",
      doi: record.doi,
      quality: {
        score,
        label: score >= 76 ? "较高" : score >= 50 ? "一般" : "较低",
        reasons: [
          "由 PubMed 生物医学文献索引发现",
          isSystematicReview ? "文献类型标识为系统综述或 Meta 分析" : isRandomizedTrial ? "文献类型标识为随机对照试验" : "研究设计仍需从摘要或全文核查",
          record.abstract ? "已取得摘要；方法、偏倚和结果仍应复核全文" : "未取得摘要，不能仅凭标题判断",
        ],
      },
      promptInjectionIgnored: false,
      searchQuery: query,
      searchRound: round,
    };
    }).sort((left, right) => (right.relevance + right.quality.score / 300) - (left.relevance + left.quality.score / 300));
}

export async function collectEvidenceForQuery(
  claim: ClaimSeed,
  query: string,
  round = 1,
  limit = 5,
): Promise<EvidenceItem[]> {
  const hits = await searchWeb(query, limit);
  const pageExtracts = await Promise.all(hits.map((hit) => fetchPage(hit.url)));
  const accessedAt = new Date().toISOString();

  return hits
    .map((hit, index): EvidenceItem | null => {
      const page = pageExtracts[index];
      const candidates = page?.passages ?? [];
      const ranked = candidates
        .map((passage) => ({ passage, relevance: relevanceScore(claim.text, `${hit.title} ${passage}`) }))
        .sort((a, b) => b.relevance - a.relevance);
      const best = ranked[0];
      const quoteType = best ? "page" as const : "search_snippet" as const;
      const quote = trimQuote(best?.passage ?? hit.snippet);
      if (!quote) return null;
      const domain = new URL(hit.url).hostname.replace(/^www\./, "");
      const relevance = best?.relevance ?? relevanceScore(claim.text, `${hit.title} ${hit.snippet}`);
      const scored = scoreSource(domain, quoteType);
      return {
        id: `${claim.id}-src-${createHash("sha1").update(hit.url).digest("hex").slice(0, 10)}`,
        title: page?.title || hit.title,
        url: hit.url,
        domain,
        publishedAt: page?.publishedAt ?? parseDate(`${hit.title} ${hit.snippet}`),
        accessedAt,
        quote,
        quoteType,
        relation: inferRelation(claim.text, quote, relevance),
        relevance,
        sourceKind: scored.sourceKind,
        sourceCategory: scored.sourceCategory,
        provider: "web",
        doi: null,
        quality: { score: scored.score, label: scored.label, reasons: scored.reasons },
        promptInjectionIgnored: page?.promptInjectionIgnored ?? false,
        searchQuery: query,
        searchRound: round,
      };
    })
    .filter((item): item is EvidenceItem => Boolean(item))
    .sort((a, b) => {
      const readableBoostA = a.quoteType === "page" ? 0.18 : 0;
      const readableBoostB = b.quoteType === "page" ? 0.18 : 0;
      return (b.relevance + readableBoostB + b.quality.score / 400) - (a.relevance + readableBoostA + a.quality.score / 400);
    });
}

export async function collectEvidenceForRoute(
  claim: ClaimSeed,
  query: string,
  round = 1,
  limit = 5,
): Promise<EvidenceItem[]> {
  const shouldSearchAcademic = Boolean(claim.routePlan?.routes.includes("scientific")) && isEnglishAcademicQuery(query);
  const tasks: Array<Promise<EvidenceItem[]>> = [collectEvidenceForQuery(claim, query, round, limit)];
  if (shouldSearchAcademic) {
    tasks.push(collectPubMedEvidence(claim, query, round, limit));
    tasks.push(collectAcademicEvidence(claim, query, round, limit));
  }
  const results = await Promise.allSettled(tasks);
  const evidence = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!evidence.length && results.every((result) => result.status === "rejected")) {
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    throw firstFailure?.reason instanceof Error ? firstFailure.reason : new Error("检索服务暂不可用");
  }
  return evidence;
}

export async function collectEvidence(claim: ClaimSeed, limit = 5): Promise<EvidenceItem[]> {
  return collectEvidenceForQuery(claim, claim.query, 1, limit);
}
