# SourceLens 真实产品演示

这不是 PPT 或页面仿制动画。演示脚本会打开正在运行的 SourceLens 网页，真实输入命题、点击“开始核查”、等待 DeepSeek 多 Agent 分析完成，再操作结果页中的证据、核查点和 Agent 执行记录。

演示命题：`鱼油中的 DHA 成分对成年人无效`

## 当前成片

- `source-lens-product-dha-demo.mp4`：1920 × 1080 产品实录，含解释字幕和舒缓无歌词音乐。
- `source-lens-product-dha-demo-cover.png`：从真实产品录屏中截取的封面。
- `product-demo-subtitles.ass`：可编辑字幕。
- `product-recording/live-product-analysis.json`：成片对应的完整 API 结果，不含 API Key。
- `product-recording/timeline.json`：实际页面事件时间轴。
- `product-recording/edit/edit-plan.json`：保留片段和裁剪秒数，便于审计。

当前成片对应的真实运行 ID 为 `1dc557eb-3a4f-406a-ab04-caa673c77603`，使用 DeepSeek 28,838 tokens，得到 3 个核查点、14 项证据，其中 11 项可读；总体结论为“已找到相关材料，但证据仍不足”。

## 重新录制

先启动本地产品服务，然后执行：

```bash
npm run demo:record-product
npm run demo:edit-product
```

也可连续执行：

```bash
npm run demo:product
```

录制阶段会发起一次真实 API 核查。编辑阶段只保留输入、点击、关键进度状态和结果页操作，将长时间等待剪掉，并在右上角持续标注“等待过程已剪辑”。音乐由本地基础波形与环境混响合成，不使用外部音乐素材。

`generate-demo.mjs` 与 `source-lens-dha-demo.mp4` 是早期信息图模板，保留仅供设计素材复用，不作为产品演示交付物。
