import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = dirname(fileURLToPath(import.meta.url));
const endpoint = process.env.SOURCE_LENS_URL || "http://localhost:8787/api/analyze";
const claim = process.env.DEMO_CLAIM || "鱼油中的 DHA 成分对成年人无效";

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: claim, inputKind: "text" }),
});
const analysis = await response.json();
if (!response.ok) {
  throw new Error(`真实核查失败（HTTP ${response.status}）：${analysis.detail || analysis.error || "未知错误"}`);
}
if (!analysis.methodology?.llmUsed) {
  throw new Error("本次核查没有使用 LLM，拒绝把它标记为真实 DeepSeek 演示");
}

const requiredAgents = [
  "verification-planner",
  "evidence-matcher",
  "source-quality-auditor",
  "final-judge",
];
const runs = new Map((analysis.methodology.agentRuns || []).map((run) => [run.id, run]));
const incomplete = requiredAgents.filter((id) => runs.get(id)?.status !== "completed");
if (incomplete.length) {
  throw new Error(`关键 Agent 未完整执行：${incomplete.join(", ")}`);
}
const falsifier = runs.get("adaptive-falsifier");
if (falsifier?.status === "fallback") {
  throw new Error("Falsification Agent 触发后发生降级，拒绝生成真实演示");
}

const scopeDrift = (analysis.claims || []).filter((item) => /(?:儿童|婴幼儿|婴儿|青少年|孕妇|妊娠)/.test(item.text));
if (scopeDrift.length) {
  throw new Error(`真实结果出现未请求的人群扩展：${scopeDrift.map((item) => item.text).join("；")}`);
}

const output = join(demoDir, "live-analysis.json");
writeFileSync(output, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify({
  output,
  id: analysis.id,
  verdict: analysis.summary?.verdict,
  claims: analysis.summary?.claimCount,
  evidence: analysis.summary?.evidenceCount,
  tokens: analysis.methodology.tokenUsage?.totalTokens,
  agents: requiredAgents.map((id) => ({ id, status: runs.get(id)?.status })),
}, null, 2));
process.stdout.write("\n");
