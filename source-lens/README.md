# SourceLens

SourceLens 将截图、群聊转发或视频字幕拆成可验证主张，由 LLM 规划检索，读取真实网页，再依据可追溯证据生成保守结论。模型记忆不作为证据。

## 工作流

```text
文本 / 截图 / 字幕
  → OCR 与多模态图文检查
  → Verification Planner 一次完成消歧、最少必要核查点、证据路线与查询
  → 科学路线使用英文 PICO/PECO 查询 PubMed + OpenAlex；事实路线追踪官方原文与报道
  → 确定性预筛、去重与 Trust & Provenance 识别来源类型、时效、转载和共同稿源
  → Evidence Matching Agent ┐
                              ├→ 两个隔离上下文并行核验同一批原始材料
  → Source Quality Agent ────┘
  → 高风险、证据单边或核验分歧时，按需启动 Falsification Agent 和额外反证检索
  → Final Judge 按证据强度综合结构化交接，不进行 Agent 多数投票
  → 确定性证据及逻辑限幅护栏
  → 消歧分支、审稿结果、论证地图与可点击证据报告
```

模型分工：

- `deepseek-v4-flash`：统一核查规划、Evidence Matching，以及满足触发条件时的 Falsification。
- `deepseek-v4-pro`：Source Quality 与最终裁决；若最终裁决未在延迟预算内完成，Flash 按同一协议接续。
- `deepseek-v4-flash-vision-exp`：截图画面、OCR 文字和来源标识的一致性检查。
- 全部角色使用同一个 DeepSeek API，但每个真实性核验 Agent 都是单独请求和单独 `messages`，不会自动共享上下文；只有明确标记的结构化结果会交给最终裁决器。
- 普通短问题通常是 4 次 LLM 请求、3 个延迟阶段：规划 1 次；Matching 与 Quality 并行 2 次；Judge 1 次。长材料可能分批；Falsification 仅按需增加请求。
- LLM 不可用或单个 Agent 输出结构无效时，该角色自动降级为确定性规则，不会中断整份报告。

## 主要能力

- 自由文本、PNG / JPEG / WebP 截图和已有视频字幕输入。
- 中英文 OCR 与视觉语境分析。
- 原子主张、实体、时间范围、验证点和多查询检索计划。
- 模糊问题的多解释分支、操作性定义和澄清问题；不会强行压成一个是非题。
- 科学、事件事实、官方记录、统计、法律政策、概念和规范问题的多标签路由。
- PubMed 与 OpenAlex 学术检索，明确区分论文摘要、书目信息、网页原文和搜索摘要；中文网页查询不会直接作为学术索引查询。
- Evidence Matching 与 Source Quality 使用不同 Prompt 和隔离上下文：前者只判命题匹配与支持/反驳关系，后者只审查来源生产方法、偏倚、精度和完整性。
- 科学、新闻、统计、政策与概念材料采用不同的匹配和质量标准；普通搜索结果不会因为关键词相同就进入结论。
- 可解释 Trust & Provenance rules-v1：分开展示来源先验、路线适配、一手性、时效与独立性，并识别同站、近重复和通讯社转载。
- 事实/价值/行动议题分类，结论、明示前提、隐含假设、歧义词和范围限定重建。
- 因果、统计、概括、专家、类比、演绎和政策论证的类型化质询。
- 前提可靠性、证据相关性、推理充分性、证据覆盖度和来源独立性五维审计。
- 带原文范围、影响和修复条件的谨慎谬误提示；无依据时不贴标签。
- 按需反证检索、竞争性解释，以及“什么证据会改变判断”；未触发时不会增加一个只为展示流程的 Agent 请求。
- 带边际收益停止条件的两轮检索，并缓存结果以便复查。
- 来源页正文抽取；明确区分已读原文与搜索摘要。
- 支持、反驳、语境误导、冲突、证据不足和未知六类结论。
- 旧闻翻炒、断章取义、主体混淆、图文不一致检查。
- LLM 引用只能使用实际证据 ID；确定性护栏校验来源独立性和质量。
- Server-Sent Events 实时进度、浏览器本地历史、摘要复制与 JSON 导出。
- 网页 Prompt Injection 检测、服务端密钥、输入限制和基础频率限制。

## 本地运行

要求 Node.js 20+。

```bash
npm install
cp .env.example .env.local
```

在 `.env.local` 中填写 `DEEPSEEK_API_KEY`。该文件已被 `.gitignore` 排除；不要使用 `VITE_` 前缀，否则密钥会进入浏览器构建产物。

开发模式：

```bash
npm run dev
```

访问 `http://localhost:5173`。

生产模式：

```bash
npm run build
npm start
```

访问 `http://localhost:8787`。

## API

- `GET /api/health`：服务和模型配置状态，不返回密钥。
- `GET /api/config`：前端所需的非敏感运行配置。
- `POST /api/ocr`：截图 OCR。
- `POST /api/analyze/stream`：流式 Agent 核查。
- `POST /api/analyze`：非流式核查，便于自动化调用。

## 验证

```bash
npm test
npm run build
curl http://localhost:8787/api/health
```

## 边界

搜索可能遗漏付费、动态或尚未索引的页面与论文全文；OpenAlex 摘要不能替代完整方法审查。Trust Model 当前是透明规则先验，尚未使用历史正确率标签训练。报告中的置信度表示证据对当前结论的充分程度，不是“主张为真概率”。医疗、法律和投资内容不能替代专业判断。

谬误卡表示可复核的疑似推理风险，不是对作者动机或人格的判断。自然语言论证重建可能遗漏隐含前提，用户应结合原文与引用进行复核。
