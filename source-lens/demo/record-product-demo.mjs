import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const demoDir = dirname(fileURLToPath(import.meta.url));
const recordingDir = join(demoDir, "product-recording");
const rawVideo = join(recordingDir, "source-lens-product-raw.webm");
const timelineFile = join(recordingDir, "timeline.json");
const resultFile = join(recordingDir, "live-product-analysis.json");
const productUrl = process.env.SOURCE_LENS_APP_URL || "http://localhost:8787";
const claim = process.env.DEMO_CLAIM || "鱼油中的 DHA 成分对成年人无效";

rmSync(recordingDir, { recursive: true, force: true });
mkdirSync(recordingDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  recordVideo: { dir: recordingDir, size: { width: 1920, height: 1080 } },
});
const startedAt = Date.now();
const events = [];
const mark = (type, label, extra = {}) => {
  const event = { type, label, time: Number(((Date.now() - startedAt) / 1000).toFixed(3)), ...extra };
  events.push(event);
  process.stdout.write(`${event.time.toFixed(3)}s ${type}: ${label}\n`);
  return event;
};

const page = await context.newPage();
const video = page.video();

async function installVisibleCursor() {
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-visible-cursor {
        position: fixed; left: -40px; top: -40px; width: 22px; height: 22px;
        z-index: 2147483647; pointer-events: none; border-radius: 50%;
        background: rgba(16, 94, 73, .18); border: 3px solid #0f684f;
        box-shadow: 0 2px 9px rgba(17, 47, 35, .28);
        transform: translate(-50%, -50%); transition: left .5s cubic-bezier(.2,.8,.2,1), top .5s cubic-bezier(.2,.8,.2,1), transform .16s ease;
      }
      #demo-visible-cursor.demo-click { transform: translate(-50%, -50%) scale(1.75); background: rgba(16, 94, 73, .3); }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-visible-cursor";
    document.body.appendChild(cursor);
  });
}

async function pointTo(locator) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("无法定位演示控件");
  const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    const cursor = document.querySelector("#demo-visible-cursor");
    if (cursor instanceof HTMLElement) {
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    }
  }, position);
  await page.mouse.move(position.x, position.y, { steps: 12 });
  await page.waitForTimeout(620);
}

async function clickWithCursor(locator) {
  await pointTo(locator);
  await page.evaluate(() => document.querySelector("#demo-visible-cursor")?.classList.add("demo-click"));
  await locator.click();
  await page.waitForTimeout(180);
  await page.evaluate(() => document.querySelector("#demo-visible-cursor")?.classList.remove("demo-click"));
}

async function scrollTo(locator, label, pause = 2400) {
  await locator.waitFor({ state: "attached", timeout: 15_000 });
  mark("view", label);
  await locator.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(900 + pause);
}

try {
  await page.goto(productUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await installVisibleCursor();
  mark("view", "产品首页");
  await page.waitForTimeout(1600);

  const textarea = page.locator("textarea");
  await pointTo(textarea);
  await textarea.click();
  mark("action", "输入待核查命题");
  for (let index = 1; index <= claim.length; index += 1) {
    await textarea.fill(claim.slice(0, index));
    await page.waitForTimeout(82);
  }
  await page.waitForTimeout(900);

  const analyzeButton = page.getByRole("button", { name: "开始核查" });
  await clickWithCursor(analyzeButton);
  mark("action", "点击开始核查");
  await page.locator(".running-panel").waitFor({ state: "visible", timeout: 10_000 });

  let monitoring = true;
  let lastProgress = "";
  const monitor = (async () => {
    while (monitoring) {
      const message = await page.locator(".running-copy strong").textContent().catch(() => null);
      const detail = await page.locator(".running-copy span").textContent().catch(() => null);
      const clean = message?.replace(/\s+/g, " ").trim() ?? "";
      if (clean && clean !== lastProgress) {
        lastProgress = clean;
        mark("progress", clean, { detail: detail?.replace(/\s+/g, " ").trim() ?? "" });
      }
      await page.waitForTimeout(260);
    }
  })();

  await page.locator(".report-shell").waitFor({ state: "visible", timeout: 300_000 });
  monitoring = false;
  await monitor;
  mark("view", "核查结果总览");
  await page.waitForTimeout(3200);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sourcelens-history-v1") || "[]"));
  const analysis = stored[0];
  if (!analysis?.methodology?.llmUsed) throw new Error("页面结果没有使用 LLM");
  const required = ["verification-planner", "evidence-matcher", "source-quality-auditor", "final-judge"];
  const runs = new Map((analysis.methodology.agentRuns || []).map((run) => [run.id, run]));
  const incomplete = required.filter((id) => runs.get(id)?.status !== "completed");
  if (incomplete.length) throw new Error(`页面结果中的关键 Agent 未完成：${incomplete.join(", ")}`);
  writeFileSync(resultFile, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  mark("result", analysis.summary.headline, {
    id: analysis.id,
    verdict: analysis.summary.verdict,
    tokens: analysis.methodology.tokenUsage?.totalTokens ?? 0,
  });

  await scrollTo(page.locator(".question-profile"), "问题范围与三个核查分支", 2600);
  const claims = page.locator(".claim-card");
  await scrollTo(claims.nth(0).locator(".claim-assessment"), "核查点一的有边界结论", 2800);
  const specialist = claims.nth(0).locator(".specialist-review");
  await scrollTo(specialist, "独立来源质量核验", 1500);
  const specialistDetails = specialist.locator(".specialist-detail summary");
  await clickWithCursor(specialistDetails);
  mark("action", "展开研究质量五维检查");
  await page.waitForTimeout(2800);
  await scrollTo(claims.nth(0).locator(".evidence-list").first(), "查看可追溯科研证据", 3000);

  await clickWithCursor(claims.nth(0).locator(".claim-heading"));
  const secondHeading = claims.nth(1).locator(".claim-heading");
  await scrollTo(secondHeading, "核查点二：心血管硬结局", 500);
  await clickWithCursor(secondHeading);
  mark("action", "展开核查点二");
  await page.waitForTimeout(3000);

  await clickWithCursor(secondHeading);
  const thirdHeading = claims.nth(2).locator(".claim-heading");
  await scrollTo(thirdHeading, "核查点三：指标与安全性", 500);
  await clickWithCursor(thirdHeading);
  mark("action", "展开核查点三");
  await page.waitForTimeout(3000);

  const method = page.locator(".method-details");
  await scrollTo(method.locator("summary"), "查看多 Agent 技术执行记录", 500);
  await clickWithCursor(method.locator("summary"));
  mark("action", "展开多 Agent 执行记录");
  await page.waitForTimeout(2300);
  await scrollTo(method.locator(".agent-run-list"), "核对各 Agent 状态与上下文策略", 3600);

  mark("view", "返回最终结论");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(1500);
  await page.waitForTimeout(2600);
} finally {
  mark("end", "录制结束");
  writeFileSync(timelineFile, `${JSON.stringify({ claim, productUrl, events }, null, 2)}\n`, "utf8");
  await context.close();
  if (video) await video.saveAs(rawVideo);
  await browser.close();
}

const result = JSON.parse(readFileSync(resultFile, "utf8"));
process.stdout.write(JSON.stringify({
  rawVideo,
  timelineFile,
  resultFile,
  id: result.id,
  verdict: result.summary.verdict,
  tokens: result.methodology.tokenUsage?.totalTokens,
}, null, 2));
process.stdout.write("\n");
