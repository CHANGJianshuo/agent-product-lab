import { describe, expect, it } from "vitest";
import { buildSearchQuery, extractAtomicClaims, normalizeInputText } from "./claims";

describe("claim extraction", () => {
  it("normalizes copied text", () => {
    expect(normalizeInputText("  第一行\r\n\r\n\r\n第二行  ")).toBe("第一行\n\n第二行");
  });

  it("removes OCR spacing between Chinese characters and dates", () => {
    expect(normalizeInputText("嫦娥 六 号 于 2024 年 返回 地 球")).toBe("嫦娥六号于2024年返回地球");
  });

  it("extracts multiple verifiable claims and drops calls to action", () => {
    const claims = extractAtomicClaims(
      "网传：嫦娥六号于2024年6月25日返回地球。它带回了月球背面样品！请大家转发。",
      5,
    );
    expect(claims).toHaveLength(2);
    expect(claims[0].text).toContain("嫦娥六号");
    expect(claims[1].text).toContain("月球背面样品");
  });

  it("removes rumor framing from queries", () => {
    expect(buildSearchQuery("网传某地将取消地铁服务。" )).toBe("某地将取消地铁服务");
  });

  it("splits coordinated assertions and carries their subject", () => {
    const claims = extractAtomicClaims(
      "网传消息称：嫦娥六号于2024年6月25日返回地球，并带回了人类首份月球背面样品。",
      5,
    );
    expect(claims).toHaveLength(2);
    expect(claims[1].text).toBe("嫦娥六号带回了人类首份月球背面样品");
  });
});
