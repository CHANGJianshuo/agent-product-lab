import { describe, expect, it } from "vitest";
import { addUsage, parseJsonContent } from "./deepseek";

describe("DeepSeek response handling", () => {
  it("parses plain and fenced JSON without evaluating text", () => {
    expect(parseJsonContent<{ ok: boolean }>(' {"ok":true} ')).toEqual({ ok: true });
    expect(parseJsonContent<{ ok: boolean }>('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("accumulates token usage across agent stages", () => {
    expect(addUsage(
      { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      { promptTokens: 20, completionTokens: 6, totalTokens: 26 },
    )).toEqual({ promptTokens: 30, completionTokens: 10, totalTokens: 40 });
  });
});
