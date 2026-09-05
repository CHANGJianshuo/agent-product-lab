from __future__ import annotations

import argparse
import json
import shutil
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright


WIDTH = 1600
HEIGHT = 900

TITLE_HTML = """
<!doctype html>
<html lang="zh-CN"><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; color: #eef8f1;
    background: radial-gradient(circle at 78% 20%, rgba(217,238,136,.24), transparent 30%), #17312d;
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
  main { width: 100%; height: 100%; padding: 84px 110px; display: grid; align-content: center; position: relative; }
  .mark { width: 76px; height: 76px; display: grid; place-items: center; border-radius: 24px;
    color: #17312d; background: #d9ee88; font: 700 35px/1 Georgia; transform: rotate(-3deg); }
  .eyebrow { margin: 34px 0 18px; color: #b9e5cc; font-size: 17px; font-weight: 800; letter-spacing: .2em; }
  h1 { max-width: 1120px; margin: 0; font: 500 78px/1.12 Georgia, "Noto Serif SC", serif; letter-spacing: -.045em; }
  h1 em { color: #d9ee88; font-style: normal; }
  p { max-width: 920px; margin: 26px 0 0; color: #b8cbc5; font-size: 25px; line-height: 1.7; }
  .chips { margin-top: 42px; display: flex; gap: 13px; }
  .chips span { padding: 12px 18px; border: 1px solid rgba(185,229,204,.22); border-radius: 999px;
    color: #d7e7dc; background: rgba(255,255,255,.045); font-size: 16px; }
  .line { position: absolute; right: 92px; bottom: 74px; color: #76938a; font-size: 14px; letter-spacing: .14em; }
  main > * { animation: rise .8s ease both; } h1 { animation-delay: .08s; } p { animation-delay: .15s; }
  .chips { animation-delay: .22s; }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
</style>
<body><main>
  <div class="mark">⌁</div>
  <div class="eyebrow">CONVERGE · 合流</div>
  <h1>从一场讨论，<br /><em>走到共同决定与行动。</em></h1>
  <p>90 秒产品演示 · 团队聚餐协商</p>
  <div class="chips"><span>单一讨论入口</span><span>硬约束优先</span><span>Pareto 妥协</span><span>人工确认</span></div>
  <div class="line">DISCUSSION → CONSENSUS → ACTION</div>
</main></body></html>
"""

OUTRO_HTML = """
<!doctype html>
<html lang="zh-CN"><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; color: #152521; background: #e5f0e6;
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
  main { width: 100%; height: 100%; padding: 82px 110px; display: grid; align-content: center; position: relative;
    background: radial-gradient(circle at 84% 16%, rgba(217,238,136,.82), transparent 28%); }
  .eyebrow { color: #1b665a; font-size: 16px; font-weight: 800; letter-spacing: .18em; }
  h1 { max-width: 1080px; margin: 20px 0 0; font: 500 76px/1.12 Georgia, "Noto Serif SC", serif; letter-spacing: -.045em; }
  h1 em { color: #1b665a; font-style: normal; }
  .stats { margin-top: 48px; display: flex; gap: 15px; }
  .stat { min-width: 195px; padding: 22px; border: 1px solid #ccdbce; border-radius: 18px; background: rgba(255,255,255,.68); }
  .stat b, .stat span { display: block; } .stat b { color: #1b665a; font: 500 42px/1 Georgia; }
  .stat span { margin-top: 9px; color: #61756f; font-size: 15px; }
  .foot { margin-top: 42px; color: #49605a; font-size: 21px; }
  main > * { animation: rise .75s ease both; } h1 { animation-delay: .08s; } .stats { animation-delay: .16s; }
  .foot { animation-delay: .24s; }
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
</style>
<body><main>
  <div class="eyebrow">CONVERGE · 从分歧到闭环</div>
  <h1>一段讨论，形成<em>可解释的共识</em>，<br />落实为可追踪的行动。</h1>
  <div class="stats"><div class="stat"><b>3</b><span>位参与者</span></div><div class="stat"><b>4</b><span>个候选方案</span></div><div class="stat"><b>2</b><span>个 Pareto 方案</span></div><div class="stat"><b>1</b><span>条闭环行动</span></div></div>
  <div class="foot">硬约束不被投票覆盖 · 系统建议不替代人工确认</div>
</main></body></html>
"""

DEMO_CSS = """
  html { scroll-behavior: smooth !important; }
  .demo-highlight {
    outline: 4px solid rgba(27, 102, 90, .58) !important;
    outline-offset: 5px !important;
    box-shadow: 0 0 0 10px rgba(185, 229, 204, .28), 0 16px 45px rgba(27, 102, 90, .18) !important;
    transition: outline .2s ease, box-shadow .2s ease !important;
  }
"""


def reset_demo(base_url: str) -> None:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/reset",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"无法重置演示数据库：HTTP {response.status}")


def wait(page: Page, seconds: float) -> None:
    page.wait_for_timeout(round(seconds * 1000))


def point_to(locator: Locator) -> None:
    locator.scroll_into_view_if_needed()
    locator.hover()
    locator.evaluate("element => element.classList.add('demo-highlight')")


def clear_highlight(locator: Locator) -> None:
    try:
        locator.evaluate("element => element.classList.remove('demo-highlight')")
    except Exception:
        # Some actions replace the highlighted node as part of a full state render.
        pass


def vote(page: Page, participant: str, options: list[str]) -> None:
    form = page.locator(".decision-vote-form", has_text=participant)
    form.scroll_into_view_if_needed()
    point_to(form)
    wait(page, 0.55)
    for option in options:
        form.locator("label", has_text=option).locator('input[name="option_ids"]').check()
        wait(page, 0.35)
    clear_highlight(form)
    with page.expect_response(lambda response: "/votes" in response.url and response.request.method == "POST"):
        form.locator("button").click()
    page.locator(".decision-vote-form").first.wait_for(state="visible")
    wait(page, 0.75)


def record(base_url: str, output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = output_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    reset_demo(base_url)

    captions: list[dict[str, object]] = []
    console_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT},
            device_scale_factor=1,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            color_scheme="light",
            record_video_dir=str(raw_dir),
            record_video_size={"width": WIDTH, "height": HEIGHT},
        )
        page = context.new_page()
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        video = page.video
        started_at = time.monotonic()

        @contextmanager
        def scene(text: str):
            start = time.monotonic() - started_at
            yield
            end = time.monotonic() - started_at
            captions.append({"start": round(start, 3), "end": round(end, 3), "text": text})

        page.set_content(TITLE_HTML, wait_until="load")
        wait(page, 4.0)

        page.goto(base_url, wait_until="networkidle")
        page.evaluate("document.documentElement.style.zoom = '0.88'")
        page.add_style_tag(content=DEMO_CSS)
        page.locator("#decision-demo-button").wait_for(state="visible")

        with scene("所有流程从一次「导入讨论」开始，用户不必预先选择工具。"):
            button = page.locator("#decision-demo-button")
            point_to(button)
            wait(page, 2.3)
            clear_highlight(button)
            button.click()
            page.locator(".deliberation-candidate").wait_for(state="visible")
            wait(page, 1.2)

        with scene("系统识别出尚未形成共识的议题，并保留原文与行号。"):
            card = page.locator(".deliberation-candidate")
            point_to(card.locator(".evidence-side"))
            wait(page, 3.8)
            clear_highlight(card.locator(".evidence-side"))

        with scene("3 位参与者和 4 个方案已从群聊预填；私密预算只显示“已识别”。"):
            preview = page.locator(".deliberation-candidate .draft-preview")
            point_to(preview)
            wait(page, 4.2)
            clear_highlight(preview)

        with scene("人工核对后才进入协商，系统不会静默创建决策。"):
            confirm = page.locator('[data-action="deliberate"]')
            point_to(confirm)
            wait(page, 1.8)
            clear_highlight(confirm)
            confirm.click()
            page.locator(".decision-room-head").wait_for(state="visible")
            wait(page, 1.4)

        with scene("协商空间继承原讨论：每项约束和候选方案都有来源。"):
            participants = page.locator(".decision-section").nth(0)
            participants.scroll_into_view_if_needed()
            point_to(participants.locator(".participant-grid"))
            wait(page, 4.6)
            clear_highlight(participants.locator(".participant-grid"))

        with scene("硬约束决定方案能否进入比较；软偏好只影响满意度。"):
            options = page.locator(".decision-section").nth(1)
            options.scroll_into_view_if_needed()
            point_to(options.locator(".option-grid"))
            wait(page, 4.4)
            clear_highlight(options.locator(".option-grid"))

        with scene("四个方案经过确定性校验：两个因距离或预算冲突被淘汰。"):
            analysis = page.locator(".analysis-section")
            analysis.scroll_into_view_if_needed()
            point_to(analysis.locator(".pareto-grid"))
            wait(page, 4.3)
            clear_highlight(analysis.locator(".pareto-grid"))

        with scene("剩下两个方案位于 Pareto 前沿，不存在让所有人都更好的替代方案。"):
            analyze = page.locator('[data-decision-action="analyze"]')
            point_to(analyze)
            wait(page, 1.5)
            clear_highlight(analyze)
            analyze.click()
            page.locator(".decision-vote-form").first.wait_for(state="visible")
            page.locator(".analysis-section").scroll_into_view_if_needed()
            wait(page, 3.6)

        with scene("每个人可以认可多个可接受方案，多数票不能覆盖任何人的硬约束。"):
            page.locator(".vote-grid").scroll_into_view_if_needed()
            wait(page, 2.0)
            vote(page, "小林", ["河畔轻食", "椒香小馆"])
            vote(page, "安然", ["河畔轻食"])

        with scene("阿哲完成投票；结果提供建议，但不会自动替主持人拍板。"):
            vote(page, "阿哲", ["椒香小馆"])
            page.locator(".vote-progress").scroll_into_view_if_needed()
            wait(page, 3.0)

        with scene("推荐综合认可票、最低满意度与平均满意度，主持人保留最终选择权。"):
            final_form = page.locator(".decision-finalize-form")
            final_form.scroll_into_view_if_needed()
            point_to(final_form)
            final_form.locator('textarea[name="decision_note"]').fill(
                "满足所有硬约束，并优先提高最低成员满意度。"
            )
            wait(page, 4.2)
            clear_highlight(final_form)

        with scene("确认后，方案、投票与原文依据一起转为可追踪任务。"):
            final_form = page.locator(".decision-finalize-form")
            submit = final_form.locator("button")
            point_to(submit)
            wait(page, 1.4)
            clear_highlight(submit)
            submit.click()
            page.locator(".decision-result-banner").wait_for(state="visible")
            page.locator(".decision-result-banner").scroll_into_view_if_needed()
            wait(page, 3.3)

        with scene("共同决定不会停在投票页，后续行动直接进入行动看板。"):
            open_task = page.locator(".decision-result-banner [data-view-link='board']")
            point_to(open_task)
            wait(page, 1.2)
            clear_highlight(open_task)
            open_task.click()
            page.locator(".task-card").wait_for(state="visible")
            wait(page, 3.3)

        with scene("负责人推进任务状态，系统同步记录版本与审计轨迹。"):
            task = page.locator(".task-card", has_text="预订")
            point_to(task)
            with page.expect_response(lambda response: "/api/tasks/" in response.url):
                task.locator(".task-status-select").select_option("in_progress")
            wait(page, 1.2)
            task = page.locator(".task-card", has_text="预订")
            with page.expect_response(lambda response: "/api/tasks/" in response.url):
                task.locator(".task-status-select").select_option("done")
            page.locator(".task-card", has_text="预订").wait_for(state="visible")
            wait(page, 3.4)

        with scene("完成、提醒和报告共用同一条证据链；外部提醒默认仍是草稿。"):
            page.locator('[data-view="reminders"]').click()
            page.locator("#digest-output").wait_for(state="visible")
            wait(page, 4.8)

        with scene("分流、人工确认、投票、任务提交和状态变化都可审计。"):
            page.locator('[data-view="audit"]').click()
            page.locator("#audit-list").wait_for(state="visible")
            wait(page, 5.0)

        page.set_content(OUTRO_HTML, wait_until="load")
        wait(page, 5.0)

        page.close()
        context.close()
        browser.close()

        raw_path = Path(video.path())

    if console_errors:
        raise RuntimeError(f"录制期间出现浏览器错误：{console_errors}")

    target = raw_dir / "converge-demo-browser.webm"
    target.unlink(missing_ok=True)
    shutil.move(str(raw_path), target)
    timeline = output_dir / "timeline.json"
    timeline.write_text(
        json.dumps(
            {
                "recording_width": WIDTH,
                "recording_height": HEIGHT,
                "captions": captions,
                "recorded_seconds": round(time.monotonic() - started_at, 3),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return target, timeline


def main() -> None:
    parser = argparse.ArgumentParser(description="录制 Converge 完整产品演示")
    parser.add_argument("--base-url", default="http://127.0.0.1:8791")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/demo-production"),
    )
    args = parser.parse_args()
    video, timeline = record(args.base_url.rstrip("/"), args.output_dir.resolve())
    print(json.dumps({"video": str(video), "timeline": str(timeline)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
