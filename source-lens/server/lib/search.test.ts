import { describe, expect, it } from "vitest";
import { hasScientificSubjectAnchor, isEnglishAcademicQuery, parsePubMedXml } from "./search";

describe("academic retrieval", () => {
  it("only routes sufficiently English queries to academic indexes", () => {
    expect(isEnglishAcademicQuery("docosahexaenoic acid adults cognition randomized trial")).toBe(true);
    expect(isEnglishAcademicQuery("成年人 DHA 是否有用 systematic review")).toBe(false);
    expect(isEnglishAcademicQuery("成年人补充DHA是否有用")).toBe(false);
  });

  it("rejects academic hits that omit the requested scientific subject", () => {
    const claim = "鱼油中的 DHA 成分对成年人无效";
    expect(hasScientificSubjectAnchor(claim, "DHA supplementation and cognition in adults")).toBe(true);
    expect(hasScientificSubjectAnchor(claim, "Pharmacological treatment of opioid-induced constipation")).toBe(false);
  });

  it("extracts auditable fields from PubMed XML", () => {
    const records = parsePubMedXml(`<?xml version="1.0"?>
      <PubmedArticleSet><PubmedArticle><MedlineCitation>
        <PMID>123456</PMID><Article>
          <Journal><JournalIssue><PubDate><Year>2024</Year><Month>Mar</Month></PubDate></JournalIssue><Title>Example Journal</Title></Journal>
          <ArticleTitle>DHA supplementation and cognition in adults</ArticleTitle>
          <Abstract><AbstractText Label="RESULTS">No invented result.</AbstractText></Abstract>
          <PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>
        </Article>
      </MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/example</ArticleId></ArticleIdList></PubmedData>
      </PubmedArticle></PubmedArticleSet>`);
    expect(records).toEqual([expect.objectContaining({
      pmid: "123456",
      title: "DHA supplementation and cognition in adults",
      abstract: "RESULTS: No invented result.",
      journal: "Example Journal",
      publishedAt: "2024-03-01",
      doi: "10.1000/example",
      publicationTypes: ["Randomized Controlled Trial"],
    })]);
  });
});
