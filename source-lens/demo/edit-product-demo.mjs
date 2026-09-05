import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = dirname(fileURLToPath(import.meta.url));
const recordingDir = join(demoDir, "product-recording");
const buildDir = join(recordingDir, "edit");
const rawVideo = join(recordingDir, "source-lens-product-raw.webm");
const timelineFile = join(recordingDir, "timeline.json");
const resultFile = join(recordingDir, "live-product-analysis.json");
const subtitleFile = join(demoDir, "product-demo-subtitles.ass");
const outputFile = join(demoDir, "source-lens-product-dha-demo.mp4");
const coverFile = join(demoDir, "source-lens-product-dha-demo-cover.png");
const ffmpeg = process.env.FFMPEG_PATH || "/home/chang/bin/ffmpeg";

mkdirSync(buildDir, { recursive: true });

const timeline = JSON.parse(readFileSync(timelineFile, "utf8"));
const result = JSON.parse(readFileSync(resultFile, "utf8"));

function eventTime(label) {
  const event = timeline.events.find((item) => item.label === label);
  if (!event) throw new Error(`录制时间轴缺少事件：${label}`);
  return event.time;
}

// Keep only interactions that materially explain the product. The long model wait is
// represented by short, truthful progress-state excerpts from the same browser run.
const clips = [
  { label: "输入并开始核查", start: 3.4, end: eventTime("正在一次完成消歧、拆题和检索规划") + 2.95 },
  { label: "科研检索", start: eventTime("核查点 2 · 第 1 轮检索") - 0.55, end: eventTime("核查点 3 · 第 1 轮检索") + 1.58 },
  { label: "独立核验", start: eventTime("两个独立核验正在交叉检查真实性") - 0.65, end: eventTime("两个独立核验正在交叉检查真实性") + 2.55 },
  { label: "综合判断", start: eventTime("正在综合证据并生成有边界的结论") - 0.62, end: eventTime("正在综合证据并生成有边界的结论") + 2.83 },
  { label: "结果与第一核查点", start: eventTime("核查结果总览") - 0.84, end: eventTime("核查点二：心血管硬结局") - 1.17 },
  { label: "第二与第三核查点", start: eventTime("核查点二：心血管硬结局") - 0.67, end: eventTime("查看多 Agent 技术执行记录") - 0.3 },
  { label: "Agent 记录与结论", start: eventTime("查看多 Agent 技术执行记录") - 0.3, end: eventTime("录制结束") - 1.36 },
];

let totalDuration = 0;
for (const clip of clips) {
  clip.outputStart = totalDuration;
  clip.duration = clip.end - clip.start;
  totalDuration += clip.duration;
}
totalDuration = Number(totalDuration.toFixed(3));

const trimFilters = clips.map((clip, index) =>
  `[0:v]trim=start=${clip.start.toFixed(3)}:end=${clip.end.toFixed(3)},setpts=PTS-STARTPTS,fps=30,format=yuv420p[v${index}]`,
);
const concatInputs = clips.map((_, index) => `[v${index}]`).join("");
const filterComplex = `${trimFilters.join(";")};${concatInputs}concat=n=${clips.length}:v=1:a=0[outv]`;

function run(args, label) {
  process.stdout.write(`${label}…\n`);
  const completed = spawnSync(ffmpeg, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (completed.status !== 0) {
    process.stderr.write(completed.stderr || completed.stdout || "");
    throw new Error(`${label}失败（退出码 ${completed.status}）`);
  }
}

const silentVideo = join(buildDir, "product-cut-silent.mp4");
run([
  "-y", "-i", rawVideo,
  "-filter_complex", filterComplex,
  "-map", "[outv]", "-an",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", silentVideo,
], "剪辑真实产品操作");

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function assText(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("{", "（").replaceAll("}", "）").replaceAll("\n", "\\N");
}

const runId = result.id.slice(0, 8);
const totalTokens = Number(result.methodology.tokenUsage?.totalTokens ?? 0).toLocaleString("en-US");
const evidenceCount = result.summary.evidenceCount;
const readableCount = result.summary.readableEvidenceCount;

const captions = [
  [0, 4.2, "这是 SourceLens 的真实网页。输入待核查命题：\n“鱼油中的 DHA 成分对成年人无效”。"],
  [4.2, 8.2, "点击“开始核查”，触发真实 DeepSeek 多 Agent 分析。"],
  [8.2, clips[0].duration, "Planner 先处理歧义，把笼统的“无效”拆成可检验问题。"],
  [clips[1].outputStart, clips[1].outputStart + clips[1].duration, "系统按科研路线检索 PubMed、OpenAlex 等来源。"],
  [clips[2].outputStart, clips[2].outputStart + clips[2].duration, "Matching 与 Quality 两个 Agent 使用隔离上下文独立核验。"],
  [clips[3].outputStart, clips[3].outputStart + clips[3].duration, "Final Judge 接收结构化证据；结论不是 Agent 多数投票。"],
  [clips[4].outputStart, clips[4].outputStart + 4.15, `等待过程已剪辑。以下是同一次真实运行：${runId}… · ${totalTokens} tokens。`],
  [clips[4].outputStart + 4.15, clips[4].outputStart + 7.65, `总体结论：已找到相关材料，但证据仍不足。\n共 ${evidenceCount} 项证据，其中 ${readableCount} 项可读。`],
  [clips[4].outputStart + 7.65, clips[4].outputStart + 11.35, "先界定成年人、DHA 和“有效”的含义，再展示三个核查分支。"],
  [clips[4].outputStart + 11.35, clips[4].outputStart + 15.25, "核查点一：现有证据不足以断言 DHA 对成人认知功能无显著作用。"],
  [clips[4].outputStart + 15.25, clips[4].outputStart + 18.95, "来源质量 Agent 独立检查设计、偏倚、直接性、精度与完整性。"],
  [clips[4].outputStart + 18.95, clips[5].outputStart, "展开五维检查，并查看能够追溯到原始页面的科研证据。"],
  [clips[5].outputStart, clips[5].outputStart + 5.0, "核查点二：心血管硬结局单独判断，避免用一个结局替代全部健康效果。"],
  [clips[5].outputStart + 5.0, clips[5].outputStart + 10.35, "再进入指标与安全性分支；指标变化不自动等于净健康获益。"],
  [clips[5].outputStart + 10.35, clips[6].outputStart, "三个分支分别给出证据、未知项和有边界结论。"],
  [clips[6].outputStart, clips[6].outputStart + 4.0, "方法区公开每个 Agent 的职责、模型、状态和上下文策略。"],
  [clips[6].outputStart + 4.0, clips[6].outputStart + 9.15, "同一个 API 可以发起多个隔离请求；\n多 Agent 的价值在于独立交叉核验，而不是共享一个答案。"],
  [clips[6].outputStart + 9.15, totalDuration, "结论：不能据现有材料接受“对成年人无效”的全称判断；\n但这也不等于 DHA 对所有健康结局都有效。"],
];

const subtitleEvents = captions.map(([start, end, value]) =>
  `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${assText(value)}`,
).join("\n");
const metaText = "真实产品录屏  ·  等待过程已剪辑";
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei UI,31,&H00FFFFFF,&H000000FF,&H00122118,&H40122118,0,0,0,0,100,100,0,0,3,10,0,2,150,150,30,1
Style: Meta,Microsoft YaHei UI,20,&H002A5542,&H000000FF,&H00FFFFFF,&H22F7F4EC,0,0,0,0,100,100,0.3,0,3,7,0,7,94,40,92,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,${assTime(0)},${assTime(totalDuration)},Meta,,0,0,0,,${assText(metaText)}
${subtitleEvents}
`;
writeFileSync(subtitleFile, ass, "utf8");

const musicFile = join(buildDir, "calm-ambient.wav");
const musicExpression = [
  "0.018*(sin(2*PI*130.81*t)+0.72*sin(2*PI*196.00*t)+0.48*sin(2*PI*246.94*t)+0.32*sin(2*PI*329.63*t))*(0.82+0.16*sin(2*PI*0.055*t))",
  "0.018*(sin(2*PI*130.81*t+0.17)+0.72*sin(2*PI*196.00*t+0.09)+0.48*sin(2*PI*246.94*t+0.21)+0.32*sin(2*PI*329.63*t+0.13))*(0.82+0.16*sin(2*PI*0.047*t))",
].join("|");
run([
  "-y", "-f", "lavfi", "-i", `aevalsrc=${musicExpression}:s=48000:d=${totalDuration}`,
  "-af", `lowpass=f=1750,aecho=0.8:0.55:650|1100:0.14|0.09,afade=t=in:st=0:d=2.2,afade=t=out:st=${Math.max(0, totalDuration - 3.2)}:d=3.2,volume=5.0`,
  "-c:a", "pcm_s16le", musicFile,
], "生成舒缓无歌词音乐");

run([
  "-y", "-i", silentVideo, "-i", musicFile,
  "-vf", `ass=${subtitleFile}`,
  "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  "-t", String(totalDuration), "-movflags", "+faststart", outputFile,
], "烧录解释字幕并输出 MP4");

run([
  "-y", "-ss", "6.6", "-i", outputFile, "-frames:v", "1", "-update", "1", coverFile,
], "生成产品实录封面");

writeFileSync(join(buildDir, "edit-plan.json"), `${JSON.stringify({
  source: rawVideo,
  output: outputFile,
  claim: timeline.claim,
  runId: result.id,
  llmUsed: result.methodology.llmUsed,
  tokenUsage: result.methodology.tokenUsage,
  clips,
  removedSeconds: Number((eventTime("录制结束") - totalDuration).toFixed(3)),
  totalDuration,
}, null, 2)}\n`, "utf8");

if (process.env.DEMO_DESKTOP_OUTPUT) {
  copyFileSync(outputFile, process.env.DEMO_DESKTOP_OUTPUT);
}

process.stdout.write(JSON.stringify({
  outputFile,
  coverFile,
  subtitleFile,
  duration: totalDuration,
  removedSeconds: Number((eventTime("录制结束") - totalDuration).toFixed(3)),
  runId: result.id,
  tokens: result.methodology.tokenUsage?.totalTokens,
}, null, 2));
process.stdout.write("\n");
