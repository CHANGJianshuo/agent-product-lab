export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DeepSeekModelSelection {
  planning: string;
  judgment: string;
  vision: string | null;
  available: string[];
}

type TextContent = string;
type MultimodalContent = Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>;

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: TextContent | MultimodalContent;
}

interface CompletionOptions {
  model: string;
  messages: DeepSeekMessage[];
  thinking?: boolean;
  reasoningEffort?: "low" | "high" | "max";
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
  attempts?: number;
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const MODEL_PREFERENCES = {
  planning: ["deepseek-v4-flash", "deepseek-chat", "deepseek-v4-pro"],
  judgment: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-reasoner"],
  vision: ["deepseek-v4-flash-vision-exp"],
};

let modelSelectionPromise: Promise<DeepSeekModelSelection> | null = null;

function apiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error("DeepSeek API Key 未配置");
  return key;
}

function baseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function isDeepSeekConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3, timeoutMs = 90_000): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`DeepSeek API 暂时返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 600 * (2 ** attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error("DeepSeek API 请求失败");
}

function pickModel(available: string[], envName: string, preferences: string[]): string {
  const override = process.env[envName]?.trim();
  if (override && available.includes(override)) return override;
  return preferences.find((model) => available.includes(model)) ?? override ?? preferences[0];
}

export async function resolveDeepSeekModels(force = false): Promise<DeepSeekModelSelection> {
  if (!isDeepSeekConfigured()) {
    return { planning: MODEL_PREFERENCES.planning[0], judgment: MODEL_PREFERENCES.judgment[0], vision: null, available: [] };
  }
  if (force) modelSelectionPromise = null;
  if (!modelSelectionPromise) {
    modelSelectionPromise = (async () => {
      const response = await fetchWithRetry(`${baseUrl()}/models`, {
        headers: { authorization: `Bearer ${apiKey()}`, accept: "application/json" },
      }, 2);
      const body = await response.json() as { data?: Array<{ id?: string }>; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || `DeepSeek 模型列表返回 ${response.status}`);
      const available = (body.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
      if (!available.length) throw new Error("DeepSeek API 未返回可用模型");
      return {
        planning: pickModel(available, "DEEPSEEK_PLANNING_MODEL", MODEL_PREFERENCES.planning),
        judgment: pickModel(available, "DEEPSEEK_JUDGMENT_MODEL", MODEL_PREFERENCES.judgment),
        vision: MODEL_PREFERENCES.vision.find((model) => available.includes(model)) ?? null,
        available,
      };
    })().catch((error) => {
      modelSelectionPromise = null;
      throw error;
    });
  }
  return modelSelectionPromise;
}

export async function createCompletion(options: CompletionOptions): Promise<{
  content: string;
  usage: TokenUsage;
}> {
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    max_tokens: options.maxTokens ?? 4_096,
    stream: false,
    thinking: { type: options.thinking === false ? "disabled" : "enabled" },
  };
  if (options.thinking !== false) payload.reasoning_effort = options.reasoningEffort ?? "high";
  if (options.json) payload.response_format = { type: "json_object" };
  if (options.thinking === false) payload.temperature = 0.1;

  const response = await fetchWithRetry(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  }, options.attempts ?? 3, options.timeoutMs ?? 90_000);
  const body = await response.json() as CompletionResponse;
  if (!response.ok) {
    const message = body.error?.message || `DeepSeek API 返回 ${response.status}`;
    if (/insufficient\s+balance|balance\s+insufficient/i.test(message)) {
      throw new Error("DeepSeek API 余额不足，请充值或更换密钥");
    }
    throw new Error(message);
  }
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("DeepSeek API 返回了空内容");
  return {
    content,
    usage: {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      totalTokens: body.usage?.total_tokens ?? 0,
    },
  };
}

export function parseJsonContent<T>(content: string): T {
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1)) as T;
    throw new Error("模型没有返回有效 JSON");
  }
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
