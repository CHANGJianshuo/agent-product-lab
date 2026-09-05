import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeText } from "./lib/analyze";
import { isDeepSeekConfigured, resolveDeepSeekModels } from "./lib/deepseek";
import { extractTextFromImage } from "./lib/ocr";
import type { RuntimeConfig } from "../shared/types";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");

dotenv.config({ path: [path.join(root, ".env.local"), path.join(root, ".env")], quiet: true });

const app = express();
const port = Number(process.env.PORT) || 8787;
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function analysisRateLimit(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const key = request.ip || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60 * 60 * 1_000;
  const limit = Number(process.env.ANALYSIS_RATE_LIMIT) || 30;
  const existing = rateLimits.get(key);
  const record = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing;
  record.count += 1;
  rateLimits.set(key, record);
  response.setHeader("X-RateLimit-Limit", String(limit));
  response.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - record.count)));
  if (record.count > limit) {
    response.status(429).json({ error: "请求过于频繁，请稍后再试" });
    return;
  }
  next();
}

function parseAnalysisBody(body: unknown): {
  text: string;
  inputKind: "text" | "image";
  ocrApplied: boolean;
  imageDataUrl?: string;
  forceRules: boolean;
} {
  const value = body as Record<string, unknown> | null;
  const text = value?.text;
  if (typeof text !== "string" || text.trim().length < 7) throw new Error("请输入至少 7 个字符的待核查内容");
  if (text.length > 8_000) throw new Error("MVP 单次最多处理 8,000 个字符");
  const imageDataUrl = typeof value?.imageDataUrl === "string" && value.imageDataUrl.startsWith("data:image/")
    ? value.imageDataUrl
    : undefined;
  return {
    text,
    inputKind: value?.inputKind === "image" ? "image" : "text",
    ocrApplied: Boolean(value?.ocrApplied),
    imageDataUrl,
    forceRules: Boolean(value?.forceRules),
  };
}

async function runtimeConfig(): Promise<RuntimeConfig> {
  const configured = isDeepSeekConfigured();
  if (!configured) {
    return {
      llmConfigured: false,
      provider: "Rules only",
      planningModel: null,
      judgmentModel: null,
      visionModel: null,
      searchProvider: "DuckDuckGo HTML + PubMed + OpenAlex",
      version: "2.2.0",
      agentArchitecture: "single-api adaptive-verification-multi-agent",
    };
  }
  try {
    const models = await resolveDeepSeekModels();
    return {
      llmConfigured: true,
      provider: "DeepSeek",
      planningModel: models.planning,
      judgmentModel: models.judgment,
      visionModel: models.vision,
      searchProvider: "DuckDuckGo HTML + PubMed + OpenAlex",
      version: "2.2.0",
      agentArchitecture: "single-api adaptive-verification-multi-agent",
    };
  } catch {
    return {
      llmConfigured: true,
      provider: "DeepSeek",
      planningModel: process.env.DEEPSEEK_PLANNING_MODEL || "deepseek-v4-flash",
      judgmentModel: process.env.DEEPSEEK_JUDGMENT_MODEL || "deepseek-v4-pro",
      visionModel: null,
      searchProvider: "DuckDuckGo HTML + PubMed + OpenAlex",
      version: "2.2.0",
      agentArchitecture: "single-api adaptive-verification-multi-agent",
    };
  }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "12mb" }));
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.get("/api/health", async (_request, response) => {
  const config = await runtimeConfig();
  response.json({ ok: true, ...config });
});

app.get("/api/config", async (_request, response) => response.json(await runtimeConfig()));

app.post("/api/ocr", async (request, response) => {
  try {
    const imageDataUrl = request.body?.imageDataUrl;
    if (typeof imageDataUrl !== "string") {
      response.status(400).json({ error: "缺少图片数据" });
      return;
    }
    const text = await extractTextFromImage(imageDataUrl);
    if (!text) {
      response.status(422).json({ error: "未识别到文字，请换一张更清晰的截图" });
      return;
    }
    response.json({ text });
  } catch (error) {
    response.status(422).json({
      error: "OCR 处理失败",
      detail: error instanceof Error ? error.message : "未知错误",
    });
  }
});

app.post("/api/analyze", analysisRateLimit, async (request, response) => {
  try {
    const input = parseAnalysisBody(request.body);
    response.json(await analyzeText(input.text, input.inputKind, input.ocrApplied, {
      imageDataUrl: input.imageDataUrl,
      forceRules: input.forceRules,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知错误";
    const isInputError = detail.startsWith("请输入") || detail.startsWith("MVP 单次");
    response.status(isInputError ? 400 : 500).json({ error: isInputError ? detail : "分析未完成", ...(!isInputError && { detail }) });
  }
});

app.post("/api/analyze/stream", analysisRateLimit, async (request, response) => {
  try {
    const input = parseAnalysisBody(request.body);
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    let closed = false;
    request.on("aborted", () => { closed = true; });
    response.on("close", () => { if (!response.writableEnded) closed = true; });
    const send = (event: string, data: unknown) => {
      if (!closed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const result = await analyzeText(input.text, input.inputKind, input.ocrApplied, {
      imageDataUrl: input.imageDataUrl,
      forceRules: input.forceRules,
      onProgress: (progress) => send("progress", progress),
    });
    send("result", result);
    response.end();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知错误";
    if (!response.headersSent) {
      response.status(400).json({ error: "分析未完成", detail });
      return;
    }
    response.write(`event: error\ndata: ${JSON.stringify({ error: "分析未完成", detail })}\n\n`);
    response.end();
  }
});

if (process.env.NODE_ENV === "production") {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.get("/{*splat}", (_request, response) => response.sendFile(path.join(dist, "index.html")));
}

app.use((_request, response) => response.status(404).json({ error: "接口不存在" }));

app.listen(port, "0.0.0.0", () => {
  process.stdout.write(`SourceLens API listening on http://localhost:${port}\n`);
});
