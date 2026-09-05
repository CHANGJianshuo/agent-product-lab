const app = {
  state: null,
  view: location.hash.slice(1) || "dashboard",
  candidateFilter: "open",
  selectedFile: null,
  reportScope: "daily",
  reportText: "",
  decisionRoomId: null,
};

const labels = {
  kind: { task: "候选任务", decision: "决策记录", risk: "风险信号" },
  change: { create: "新建", complete: "标记完成", cancel: "取消任务", reschedule: "任务改期", transfer: "负责人转交", record: "记录", deliberate: "需要继续协商" },
  status: { pending: "待确认", needs_clarification: "需要澄清", approved: "已确认", rejected: "已忽略" },
  taskStatus: { todo: "待开始", in_progress: "进行中", blocked: "阻塞", done: "已完成", cancelled: "已取消" },
  health: { on_track: "正常", due_soon: "临期", overdue: "逾期", blocked: "阻塞", done: "已完成", cancelled: "已取消" },
  scenario: { dining: "聚餐", outing: "团建 / 活动", travel: "群体出游", rent: "合租 / 租房", general: "通用决策" },
  decisionStatus: { collecting: "收集约束", voting: "方案投票", decided: "已经决策" },
  audit: {
    "model.candidate_detected": "识别出候选事项",
    "model.extraction_completed": "模型抽取完成",
    "model.extraction_fallback": "模型失败并安全回退",
    "tool.import_conversation": "完成对话导入",
    "human.clarification": "人工补充了信息",
    "human.approved": "人工确认候选事项",
    "human.rejected": "人工忽略候选事项",
    "tool.commit_approved_action": "提交已审批动作",
    "human.task_updated": "人工更新任务状态",
    "tool.simulated_clock": "推进模拟时钟",
    "human.decision_room_created": "创建协商空间",
    "human.constraint_submitted": "提交参与者约束",
    "human.decision_option_added": "添加候选方案",
    "tool.pareto_analyzed": "计算 Pareto 方案",
    "human.vote_submitted": "提交认可投票",
    "human.decision_finalized": "确认最终决策",
    "tool.decision_to_action": "将决策转为行动",
    "tool.decision_demo_created": "创建聚餐决策示例",
    "human.deliberation_confirmed": "确认议题需要继续协商",
    "tool.discussion_routed": "将导入讨论转入协商流程",
  },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function initials(name = "?") { return [...String(name)][0] || "?"; }

function displayDate(value, detailed = false) {
  if (!value) return "待补充";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options = detailed
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" };
  return new Intl.DateTimeFormat("zh-CN", options).format(date).replace("24:", "00:");
}

function localInputValue(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (match) return `${match[1]}T${match[2]}`;
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function apiDueValue(value) {
  return value ? `${value}:00+08:00` : "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function setBusy(active, message = "正在梳理承诺与证据…") {
  const overlay = $("#loading");
  $("p", overlay).textContent = message;
  overlay.hidden = !active;
}

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type === "error" ? "error" : ""}`;
  element.innerHTML = `<i>${type === "error" ? "!" : "✓"}</i><span>${escapeHtml(message)}</span>`;
  $("#toast-region").append(element);
  setTimeout(() => element.remove(), 3600);
}

async function loadState() {
  try {
    app.state = await api("/api/state");
    app.reportScope = "daily";
    app.reportText = app.state.digest;
    renderAll();
  } catch (error) {
    toast(error.message, "error");
  }
}

function navigate(view) {
  const known = ["dashboard", "decisions", "candidates", "board", "reminders", "audit"];
  app.view = known.includes(view) ? view : "dashboard";
  location.hash = app.view;
  $$(".view").forEach((node) => node.classList.toggle("active", node.id === `view-${app.view}`));
  $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === app.view));
  $(".sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderAll() {
  if (!app.state) return;
  renderChrome();
  renderDashboard();
  renderDecisions();
  renderCandidates();
  renderBoard();
  renderReminders();
  renderAudit();
  navigate(app.view);
}

function renderChrome() {
  const { stats, simulated_now: now, provider } = app.state;
  $("#top-clock").textContent = displayDate(now, true);
  $("#today-label").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Shanghai" }).format(new Date(now));
  $("#nav-pending").textContent = stats.pending_count;
  $("#nav-decisions").textContent = stats.open_decision_count;
  $("#nav-attention").hidden = !stats.attention_count;
  $("#stat-decisions").textContent = stats.open_decision_count;
  $("#stat-pending").textContent = stats.pending_count;
  $("#stat-tasks").textContent = stats.task_count;
  $("#stat-attention").textContent = stats.attention_count;
  const connected = provider.configured;
  $("#provider-pill").classList.toggle("connected", connected);
  $("#provider-pill span").textContent = connected ? `${provider.model} 已连接` : "本地 Baseline";
  $("#provider-footer").textContent = connected ? `${provider.model} · HUMAN APPROVAL` : "BASELINE RULES V1 · 未配置模型";
  $("#smart-mode-detail").textContent = connected ? `${provider.model} · 失败自动回退` : "尚未配置，当前自动使用本地规则";
}

function emptyState(icon, title, copy) {
  return `<div class="empty-state"><span class="empty-icon">${icon}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></div>`;
}

function renderDashboard() {
  const rooms = app.state.decision_rooms.slice(0, 3);
  $("#dashboard-decisions").innerHTML = rooms.length
    ? rooms.map((room) => `<button class="decision-mini-card" data-room-open="${room.id}">
        <span class="decision-mini-icon">${room.status === "decided" ? "✓" : "◎"}</span>
        <span><strong>${escapeHtml(room.title)}</strong><small>${escapeHtml(labels.scenario[room.scenario] || room.scenario)} · ${room.analysis.participant_count} 人 · ${room.analysis.pareto_count} 个 Pareto 方案</small></span>
        <b class="decision-status ${room.status}">${escapeHtml(labels.decisionStatus[room.status])}</b><i>→</i>
      </button>`).join("")
    : emptyState("◎", "还没有协商中的议题", "导入一场尚未形成共识的讨论，确认后会在这里继续推进。 ");

  const open = app.state.candidates.filter((item) => ["pending", "needs_clarification"].includes(item.status)).slice(0, 3);
  $("#dashboard-candidates").innerHTML = open.length
    ? open.map((item) => `<div class="mini-candidate"><span class="mini-type">${item.kind === "risk" ? "△" : item.kind === "decision" ? "◇" : "✓"}</span><div><strong>${escapeHtml(item.title || "信息待补充")}</strong><small>${escapeHtml(item.change_type === "deliberate" ? "需要继续协商" : labels.kind[item.kind])} · ${escapeHtml(item.speaker)} · ${escapeHtml(labels.status[item.status])}</small></div><button data-view-link="candidates" aria-label="查看">→</button></div>`).join("")
    : emptyState("✦", "暂时没有待整理事项", "导入一场讨论，系统会先判断它需要协商还是已经形成行动。 ");

  const events = app.state.audits.filter((event) => ["human.approved", "tool.commit_approved_action", "human.task_updated", "human.deliberation_confirmed", "tool.discussion_routed", "human.decision_finalized", "tool.decision_to_action"].includes(event.event_type)).slice(0, 4);
  $("#dashboard-flow").innerHTML = events.length
    ? events.map((event) => `<div class="flow-item"><span class="flow-line"><i></i></span><div><strong>${escapeHtml(labels.audit[event.event_type] || event.event_type)}</strong><small>${displayDate(event.created_at, true)} · ${escapeHtml(event.actor)} · ${escapeHtml(event.entity_type)} #${event.entity_id || "—"}</small></div></div>`).join("")
    : emptyState("⌁", "闭环从确认开始", "完成第一次审批后，状态变化会在这里串成可追溯的时间线。 ");
}

function formatNumber(value, suffix = "") {
  return value === null || value === undefined ? "未设置" : `${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;
}

function tagChips(values = [], className = "") {
  return values.length ? values.map((value) => `<span class="constraint-chip ${className}">${escapeHtml(value)}</span>`).join("") : '<span class="muted-inline">无</span>';
}

function currentDecisionRoom() {
  const rooms = app.state?.decision_rooms || [];
  let room = rooms.find((item) => item.id === Number(app.decisionRoomId));
  if (!room && rooms.length) {
    room = rooms[0];
    app.decisionRoomId = room.id;
  }
  return room;
}

function decisionDefaultDue() {
  const base = new Date(app.state.simulated_now);
  base.setDate(base.getDate() + 1);
  base.setHours(18, 0, 0, 0);
  return localInputValue(base.toISOString());
}

function participantCard(participant) {
  const budget = participant.budget_private
    ? "已设置私密预算"
    : participant.budget_max !== null ? `人均 ≤ ¥${formatNumber(participant.budget_max)}` : "未设置预算";
  const windowLabel = participant.earliest_time || participant.latest_time
    ? `${participant.earliest_time || "00:00"}–${participant.latest_time || "24:00"}` : "时间不限";
  return `<article class="constraint-person-card">
    <div class="person-card-head"><span class="speaker-avatar">${escapeHtml(initials(participant.name))}</span><div><strong>${escapeHtml(participant.name)}</strong><small>${escapeHtml(budget)}</small></div>${participant.budget_private ? '<span class="private-chip">私密</span>' : ""}</div>
    <div class="constraint-facts"><span>⌖ ${participant.max_distance_km ? `${formatNumber(participant.max_distance_km)} km 内` : "距离不限"}</span><span>◷ ${escapeHtml(windowLabel)}</span></div>
    <div class="constraint-row"><b>必须</b>${tagChips(participant.required_tags, "hard")}</div>
    <div class="constraint-row"><b>避开</b>${tagChips(participant.avoided_tags, "avoid")}</div>
    <div class="constraint-row"><b>偏好</b>${tagChips(participant.preferred_tags, "soft")}</div>
    ${participant.source_note ? `<blockquote class="constraint-note">“${escapeHtml(participant.source_note)}”</blockquote>` : ""}
    ${participant.source_line_start ? `<div class="evidence-inline">↳ 来自讨论第 ${participant.source_line_start}${participant.source_line_end !== participant.source_line_start ? `–${participant.source_line_end}` : ""} 行</div>` : ""}
  </article>`;
}

function optionCard(option) {
  const cost = option.cost_per_person === null || option.cost_per_person === undefined
    ? "费用待确认" : `¥${formatNumber(option.cost_per_person)} / 人`;
  return `<article class="decision-option-card">
    <div class="option-card-head"><strong>${escapeHtml(option.name)}</strong><span>${escapeHtml(cost)}</span></div>
    <div class="option-facts"><span>⌖ ${formatNumber(option.distance_km, " km")}</span><span>◷ ${escapeHtml(option.available_time || "待确认")}</span></div>
    <div class="tag-cloud">${tagChips(option.tags, "soft")}</div>
    ${option.source_note ? `<p>${escapeHtml(option.source_note)}</p>` : ""}
    ${option.source_line_start ? `<div class="evidence-inline">↳ 来自讨论第 ${option.source_line_start}${option.source_line_end !== option.source_line_start ? `–${option.source_line_end}` : ""} 行</div>` : ""}
  </article>`;
}

function analysisCard(result) {
  const status = result.pareto ? "Pareto 候选" : result.feasible ? "可行但被支配" : "硬约束未通过";
  const violations = result.violations.length
    ? `<div class="violation-list">${result.violations.map((entry) => `<p><strong>${escapeHtml(entry.participant)}</strong>：${entry.reasons.map(escapeHtml).join("；")}</p>`).join("")}</div>` : "";
  const scores = result.feasible
    ? `<div class="score-list">${result.scores.map((score) => `<div><span>${escapeHtml(score.participant)}</span><i><b style="width:${score.score}%"></b></i><strong>${score.score.toFixed(1)}</strong></div>`).join("")}</div>` : "";
  return `<article class="pareto-card ${result.pareto ? "pareto" : result.feasible ? "dominated" : "infeasible"}">
    <div class="pareto-card-head"><div><span class="pareto-state">${escapeHtml(status)}</span><h3>${escapeHtml(result.name)}</h3></div>${result.pareto ? `<b class="pareto-rank">#${result.pareto_rank}</b>` : ""}</div>
    <p class="pareto-summary">${escapeHtml(result.summary)}</p>
    ${result.feasible ? `<div class="pareto-metrics"><span><b>${result.vote_count}</b> 认可票</span><span><b>${result.min_score.toFixed(1)}</b> 最低满意</span><span><b>${result.average_score.toFixed(1)}</b> 平均满意</span></div>` : ""}
    ${scores}${violations}
  </article>`;
}

function participantForm(room) {
  if (room.status !== "collecting") return '<div class="locked-note">✓ 已进入投票，参与者约束已锁定</div>';
  return `<details class="builder-card" ${room.participants.length ? "" : "open"}>
    <summary><span>＋ 添加参与者与约束</span><small>预算可设为私密；硬约束不会被投票覆盖</small></summary>
    <form class="decision-participant-form" data-room-id="${room.id}">
      <div class="builder-grid">
        <label class="field"><span>参与者</span><input name="name" required maxlength="40" placeholder="姓名或昵称" /></label>
        <label class="field"><span>人均预算上限</span><input name="budget_max" type="number" min="1" step="1" placeholder="150" /></label>
        <label class="field checkbox-field"><input name="budget_private" type="checkbox" /><span>预算只显示“已设置”</span></label>
        <label class="field"><span>最远距离 km</span><input name="max_distance_km" type="number" min="0.1" step="0.1" placeholder="5" /></label>
        <label class="field"><span>最早时间</span><input name="earliest_time" type="time" /></label>
        <label class="field"><span>最晚时间</span><input name="latest_time" type="time" /></label>
        <label class="field"><span>必须条件</span><input name="required_tags" placeholder="素食可选, 可停车" /></label>
        <label class="field"><span>避开条件</span><input name="avoided_tags" placeholder="花生, 楼梯" /></label>
        <label class="field"><span>软偏好</span><input name="preferred_tags" placeholder="安静, 川菜" /></label>
        <label class="field builder-wide"><span>约束原话 / 备注</span><textarea name="source_note" rows="2" maxlength="500" placeholder="保留参与者原始表达，便于核对"></textarea></label>
      </div>
      <div class="builder-actions"><span>预算、距离、时间、必须与避开条件均按硬约束处理</span><button class="button button-primary compact">保存参与者</button></div>
    </form>
  </details>`;
}

function optionForm(room) {
  if (room.status !== "collecting") return '<div class="locked-note">✓ 已进入投票，候选方案已锁定</div>';
  return `<details class="builder-card" ${room.options.length ? "" : "open"}>
    <summary><span>＋ 添加候选方案</span><small>价格和可用性必须来自真实来源或人工确认</small></summary>
    <form class="decision-option-form" data-room-id="${room.id}">
      <div class="builder-grid option-builder-grid">
        <label class="field"><span>方案名称</span><input name="name" required maxlength="80" placeholder="椒香小馆" /></label>
        <label class="field"><span>人均费用</span><input name="cost_per_person" type="number" min="1" step="1" placeholder="118" /></label>
        <label class="field"><span>距离 km</span><input name="distance_km" type="number" min="0.1" step="0.1" placeholder="2.4" /></label>
        <label class="field"><span>可用时间</span><input name="available_time" type="time" /></label>
        <label class="field"><span>方案标签</span><input name="tags" placeholder="川菜, 素食可选, 安静" /></label>
        <label class="field builder-wide"><span>信息来源 / 备注</span><textarea name="source_note" rows="2" maxlength="500" placeholder="例如：电话确认可订 19:00"></textarea></label>
      </div>
      <div class="builder-actions"><span>缺失的费用、距离或时间可能导致方案无法通过硬约束</span><button class="button button-primary compact">保存方案</button></div>
    </form>
  </details>`;
}

function voteSection(room) {
  const pareto = room.analysis.results.filter((item) => item.pareto);
  if (room.status === "collecting" && room.analysis.ready) {
    return emptyState("③", "先确认 Pareto 计算", "点击上方“计算并记录”，确认候选方案已经按当前约束完成比较。 ");
  }
  if (!room.analysis.ready || !pareto.length) {
    return emptyState("③", "还不能投票", "先添加至少两位参与者与两个候选方案，并确保存在满足全部硬约束的方案。 ");
  }
  const forms = room.participants.map((participant) => {
    const selected = new Set(room.votes.filter((vote) => vote.participant_id === participant.id && vote.approved).map((vote) => vote.option_id));
    return `<form class="decision-vote-form vote-card" data-room-id="${room.id}" data-participant-id="${participant.id}">
      <div class="vote-person"><span class="speaker-avatar">${escapeHtml(initials(participant.name))}</span><div><strong>${escapeHtml(participant.name)}</strong><small>可认可多个能接受的方案</small></div></div>
      <div class="vote-options">${pareto.map((result) => `<label><input type="checkbox" name="option_ids" value="${result.option_id}" ${selected.has(result.option_id) ? "checked" : ""} ${room.status === "decided" ? "disabled" : ""}/><span><b>${escapeHtml(result.name)}</b><small>最低 ${result.min_score.toFixed(1)} · 平均 ${result.average_score.toFixed(1)}</small></span></label>`).join("")}</div>
      ${room.status === "decided" ? "" : '<button class="button button-ghost compact">保存这一票</button>'}
    </form>`;
  }).join("");
  return `<div class="vote-progress"><span><b>${room.analysis.voter_count}</b> / ${room.analysis.participant_count} 人已投票</span><i><b style="width:${Math.min(100, room.analysis.voter_count / room.analysis.participant_count * 100)}%"></b></i></div><div class="vote-grid">${forms}</div>`;
}

function finalizeSection(room) {
  if (room.status === "decided") {
    return `<div class="decision-result-banner"><span>✓</span><div><small>FINAL DECISION</small><h3>${escapeHtml(room.selected_option?.name || "已确认方案")}</h3><p>${escapeHtml(room.decision_note || "最终方案已经人工确认，并留下完整审计轨迹。")}</p></div>${room.action_task_id ? `<button class="button button-primary" data-view-link="board">查看 TASK-${String(room.action_task_id).padStart(3, "0")}</button>` : ""}</div>`;
  }
  const pareto = room.analysis.results.filter((item) => item.pareto);
  if (!pareto.length || room.analysis.voter_count < 1) {
    return emptyState("④", "等待投票后确认", "至少一位参与者提交认可票后，主持人才能确认 Pareto 方案并创建后续行动。 ");
  }
  const recommended = pareto.find((item) => item.option_id === room.analysis.recommended_option_id) || pareto[0];
  const actionTitle = room.scenario === "dining" ? `预订${recommended.name}并确认人数` : `落实「${room.title}」最终方案`;
  return `<form class="decision-finalize-form finalize-card" data-room-id="${room.id}">
    <div class="finalize-copy"><p class="section-kicker">HUMAN CONFIRMATION</p><h3>确认共识，并把它变成行动</h3><p>推荐基于认可票、最低成员满意度和平均满意度排序；主持人仍可选择任意 Pareto 方案。</p></div>
    <div class="finalize-grid">
      <label class="field"><span>最终方案</span><select name="option_id">${pareto.map((item) => `<option value="${item.option_id}" ${item.option_id === recommended.option_id ? "selected" : ""}>${escapeHtml(item.name)} · ${item.vote_count} 票</option>`).join("")}</select></label>
      <label class="field"><span>后续行动</span><input name="action_title" required maxlength="120" value="${escapeHtml(actionTitle)}" /></label>
      <label class="field"><span>负责人</span><input name="action_owner" required maxlength="40" value="${escapeHtml(room.organizer)}" /></label>
      <label class="field"><span>截止时间</span><input name="action_due_at" type="datetime-local" required value="${decisionDefaultDue()}" /></label>
      <label class="field finalize-wide"><span>决策说明</span><textarea name="decision_note" rows="2" maxlength="500" placeholder="说明最终选择与主要妥协"></textarea></label>
    </div>
    <div class="builder-actions"><span>确认后锁定本决策室，并创建一条带来源证据的任务</span><button class="button button-primary">确认决策并转为行动</button></div>
  </form>`;
}

function renderDecisions() {
  const root = $("#decision-workspace");
  const rooms = app.state.decision_rooms || [];
  if (!rooms.length) {
    root.innerHTML = `<div class="decision-empty panel">${emptyState("◎", "还没有进入协商的议题", "先导入一场讨论。系统识别到尚未形成共识的共同问题后，会在“讨论整理”中等待你确认。")}
      <div class="empty-actions"><button class="button button-primary" data-open-import>导入讨论记录</button></div></div>`;
    return;
  }
  const room = currentDecisionRoom();
  const stages = [
    { label: "收集约束", done: room.analysis.participant_count >= 2, meta: `${room.analysis.participant_count} 人` },
    { label: "录入方案", done: room.analysis.option_count >= 2, meta: `${room.analysis.option_count} 个` },
    { label: "Pareto 与投票", done: room.analysis.voter_count > 0, meta: `${room.analysis.pareto_count} 个前沿` },
    { label: "转为行动", done: room.status === "decided", meta: room.status === "decided" ? "已闭环" : "待确认" },
  ];
  root.innerHTML = `<div class="decision-shell">
    <aside class="room-rail"><div class="room-rail-head"><strong>决策列表</strong><span>${rooms.length}</span></div>${rooms.map((item) => `<button class="room-switch ${item.id === room.id ? "active" : ""}" data-room-switch="${item.id}"><span>${item.status === "decided" ? "✓" : "◎"}</span><div><strong>${escapeHtml(item.title)}</strong><small>${item.analysis.participant_count} 人 · ${escapeHtml(labels.decisionStatus[item.status])}</small></div></button>`).join("")}</aside>
    <div class="decision-main">
      <header class="decision-room-head"><div><div class="room-meta"><span>${escapeHtml(labels.scenario[room.scenario] || room.scenario)}</span><b class="decision-status ${room.status}">${escapeHtml(labels.decisionStatus[room.status])}</b>${room.source ? `<span class="source-room-chip">源自 ${escapeHtml(room.source.filename)} · 第 ${room.source.line_start} 行</span>` : ""}</div><h2>${escapeHtml(room.title)}</h2><p>${escapeHtml(room.description || "先收集硬约束，再寻找所有人都能接受的方案。")}</p></div><div class="organizer-badge"><small>主持人</small><strong>${escapeHtml(room.organizer)}</strong></div></header>
      <div class="decision-stepper">${stages.map((stage, index) => `<div class="decision-step ${stage.done ? "done" : index === stages.findIndex((item) => !item.done) ? "active" : ""}"><span>${stage.done ? "✓" : index + 1}</span><div><strong>${escapeHtml(stage.label)}</strong><small>${escapeHtml(stage.meta)}</small></div></div>`).join("")}</div>

      <section class="decision-section"><div class="decision-section-head"><span>01</span><div><h3>收集每个人的约束</h3><p>预算、距离、时间、必须与避开条件是硬约束；偏好只影响满意度。</p></div><b>${room.participants.length} 人</b></div><div class="participant-grid">${room.participants.length ? room.participants.map(participantCard).join("") : emptyState("①", "等待参与者", "至少录入两位参与者，才能形成真正的多人决策。")}</div>${participantForm(room)}</section>

      <section class="decision-section"><div class="decision-section-head"><span>02</span><div><h3>提供真实候选方案</h3><p>Converge 不会编造价格、距离或可用时间；候选信息需要人工或可信来源确认。</p></div><b>${room.options.length} 个</b></div><div class="option-grid">${room.options.length ? room.options.map(optionCard).join("") : emptyState("②", "等待候选方案", "录入至少两个方案，系统才会比较约束和妥协。")}</div>${optionForm(room)}</section>

      <section class="decision-section analysis-section"><div class="decision-section-head"><span>03</span><div><h3>查看 Pareto 前沿</h3><p>没有其他方案能让所有人都不变差且至少一人更满意时，该方案进入前沿。</p></div>${room.status === "collecting" ? `<button class="button button-dark compact" data-decision-action="analyze" data-room-id="${room.id}" ${room.analysis.ready ? "" : "disabled"}>计算并记录</button>` : `<b>${room.status === "decided" ? "已完成" : "已记录"}</b>`}</div>${room.analysis.blockers.length ? `<div class="analysis-blockers">${room.analysis.blockers.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}<div class="pareto-grid">${room.analysis.results.length ? room.analysis.results.map(analysisCard).join("") : emptyState("③", "等待可比较数据", "参与者和候选方案就绪后，这里会展示可行性与逐人满意度。")}</div></section>

      <section class="decision-section"><div class="decision-section-head"><span>04</span><div><h3>认可投票</h3><p>每个人可以认可多个可接受方案；硬约束不满足的方案不会进入选票。</p></div><b>${room.analysis.voter_count}/${room.analysis.participant_count}</b></div>${voteSection(room)}</section>

      <section class="decision-section final-section"><div class="decision-section-head"><span>✓</span><div><h3>从共识到行动</h3><p>最终决定不会停在投票结果里，而会进入任务看板继续追踪。</p></div></div>${finalizeSection(room)}</section>
    </div>
  </div>`;
}

function deliberationCandidateCard(item) {
  const draft = item.decision_draft || {};
  const participants = Array.isArray(draft.participants) ? draft.participants : [];
  const options = Array.isArray(draft.options) ? draft.options : [];
  const readonly = ["approved", "rejected"].includes(item.status);
  const lineLabel = item.line_start === item.line_end ? `第 ${item.line_start} 行` : `第 ${item.line_start}–${item.line_end} 行`;
  const participantPreview = participants.length
    ? participants.map((person) => {
        const budget = person.budget_private ? "私密预算已识别" : person.budget_max ? `预算 ≤ ¥${formatNumber(person.budget_max)}` : "预算待补";
        const hardCount = [person.max_distance_km, person.earliest_time, person.latest_time].filter(Boolean).length
          + (person.required_tags || []).length + (person.avoided_tags || []).length;
        return `<span class="draft-person"><i>${escapeHtml(initials(person.name))}</i><b>${escapeHtml(person.name)}</b><small>${escapeHtml(budget)} · ${hardCount} 项其他硬约束</small></span>`;
      }).join("")
    : '<span class="draft-missing">尚未从讨论中识别出完整的参与者约束，进入协商后可补充。</span>';
  const optionPreview = options.length
    ? options.map((option) => `<span class="draft-option">${escapeHtml(option.name)}</span>`).join("")
    : '<span class="draft-missing">讨论中还没有结构化候选方案。</span>';
  const controls = readonly
    ? item.promoted_room_id
      ? `<span class="approval-note">该议题已经确认并进入协商</span><button class="button button-primary compact" data-room-open="${item.promoted_room_id}">继续查看协商</button>`
      : `<span class="approval-note">该议题已${item.status === "rejected" ? "忽略" : "处理"}</span>`
    : `<div class="review-actions-left"><button class="button button-danger compact" data-action="reject">忽略</button></div><div class="review-actions-right"><button class="button button-primary compact" data-action="deliberate">确认并继续协商 <span>→</span></button></div>`;
  return `<article class="candidate-card deliberation-candidate" data-candidate-id="${item.id}">
    <div class="evidence-side">
      <div class="candidate-meta"><span class="type-chip deliberation">◎ 需要继续协商</span><span class="confidence">置信度 ${Math.round(item.confidence * 100)}%</span></div>
      <div class="speaker-line"><span class="speaker-avatar">${escapeHtml(initials(item.speaker))}</span><strong>${escapeHtml(item.speaker)}</strong><time>${displayDate(item.sent_at, true)}</time></div>
      <blockquote class="evidence-quote">“${escapeHtml(item.source_text)}”</blockquote>
      <div class="source-ref"><b>议题证据</b> · ${escapeHtml(item.filename)} · ${lineLabel} · ${item.rule_id.startsWith("llm.") ? "模型" : "讨论分流器"}</div>
    </div>
    <div class="review-side">
      <div class="review-title-row"><div><p class="section-kicker">DISCUSSION DIAGNOSIS</p><h3>尚未形成共识</h3></div><span class="status-pill ${item.status}">${escapeHtml(labels.status[item.status])}</span></div>
      <p class="route-explanation">这不是可直接执行的承诺。确认后，系统会把已识别约束和候选方案带入协商流程，再计算 Pareto 前沿。</p>
      <div class="field-grid deliberation-fields">
        <div class="field"><label>共同议题</label><input name="title" value="${escapeHtml(draft.title || item.title || "")}" ${readonly ? "disabled" : ""} /></div>
        <div class="field"><label>场景</label><select name="scenario" ${readonly ? "disabled" : ""}>${Object.entries(labels.scenario).map(([value, label]) => `<option value="${value}" ${value === (draft.scenario || "general") ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></div>
        <div class="field"><label>默认主持人</label><input name="organizer" value="${escapeHtml(draft.organizer || item.owner || item.speaker)}" ${readonly ? "disabled" : ""} /></div>
      </div>
      <div class="draft-coverage"><div><span>已识别参与者约束</span><b>${participants.length} 人</b></div><div><span>已识别候选方案</span><b>${options.length} 个</b></div><div><span>来源消息</span><b>${draft.message_count || 1} 条</b></div></div>
      <div class="draft-preview"><div><strong>参与者</strong><div class="draft-person-list">${participantPreview}</div></div><div><strong>候选方案</strong><div class="draft-option-list">${optionPreview}</div></div></div>
      <div class="review-actions">${controls}</div>
    </div>
  </article>`;
}

function candidateCard(item) {
  if (item.change_type === "deliberate") return deliberationCandidateCard(item);
  const readonly = ["approved", "rejected"].includes(item.status);
  const isChange = !["create", "record"].includes(item.change_type);
  const lineLabel = item.line_start === item.line_end ? `第 ${item.line_start} 行` : `第 ${item.line_start}–${item.line_end} 行`;
  const questions = item.clarifications.filter((question) => !question.resolved);
  const tasks = app.state.tasks.filter((task) => task.status !== "cancelled");
  const targetField = isChange ? `<div class="field"><label>目标任务</label><select name="target_task_id" ${readonly ? "disabled" : ""}><option value="">自动匹配</option>${tasks.map((task) => `<option value="${task.id}" ${Number(item.target_task_id) === task.id ? "selected" : ""}>#${task.id} ${escapeHtml(task.title)}</option>`).join("")}</select></div>` : "";
  const titleField = `<div class="field"><label>${item.kind === "task" ? "动作 / 任务" : "记录内容"}</label><input name="title" value="${escapeHtml(item.title || "")}" placeholder="${item.kind === "task" ? "具体要完成什么" : "事项内容"}" ${readonly ? "disabled" : ""} /></div>`;
  const taskFields = item.kind === "task" ? `
    <div class="field"><label>负责人</label><input name="owner" value="${escapeHtml(item.owner || "")}" placeholder="待补充" ${readonly || ["complete", "cancel", "reschedule"].includes(item.change_type) ? "disabled" : ""} /></div>
    <div class="field"><label>${item.change_type === "reschedule" ? "新截止时间" : "截止时间"}</label><input name="due_at" type="datetime-local" value="${localInputValue(item.due_at)}" ${readonly || ["complete", "cancel", "transfer"].includes(item.change_type) ? "disabled" : ""} /></div>${targetField}` : "";
  const clarification = questions.length ? `<div class="clarification-box"><span>?</span><div><strong>需要最少必要澄清</strong>${questions.map((question) => escapeHtml(question.question)).join("<br />")}</div></div>` : "";
  const cardType = isChange ? "change" : item.kind;
  const controls = readonly
    ? `<span class="approval-note">该候选已${item.status === "approved" ? "确认并留下审计记录" : "忽略，不会写入看板"}</span>`
    : `<div class="review-actions-left"><button class="button button-danger compact" data-action="reject">忽略</button></div><div class="review-actions-right">${questions.length ? '<button class="button button-ghost compact" data-action="clarify">保存补充</button>' : ""}<button class="button button-primary compact" data-action="approve">${item.kind === "task" ? (isChange ? "确认变更" : "确认并写入") : "确认收录"}</button></div>`;
  return `<article class="candidate-card" data-candidate-id="${item.id}">
    <div class="evidence-side">
      <div class="candidate-meta"><span class="type-chip ${cardType}">${isChange ? "↻" : item.kind === "risk" ? "△" : item.kind === "decision" ? "◇" : "✓"} ${escapeHtml(isChange ? labels.change[item.change_type] : labels.kind[item.kind])}</span><span class="confidence">置信度 ${Math.round(item.confidence * 100)}%</span></div>
      <div class="speaker-line"><span class="speaker-avatar">${escapeHtml(initials(item.speaker))}</span><strong>${escapeHtml(item.speaker)}</strong><time>${displayDate(item.sent_at, true)}</time></div>
      <blockquote class="evidence-quote">“${escapeHtml(item.source_text)}”</blockquote>
      <div class="source-ref"><b>证据</b> · ${escapeHtml(item.filename)} · ${lineLabel} · ${item.rule_id.startsWith("llm.") ? "模型" : "规则"} ${escapeHtml(item.rule_id.replace(/^llm\./, ""))}</div>
    </div>
    <div class="review-side">
      <div class="review-title-row"><h3>${escapeHtml(labels.change[item.change_type] || labels.kind[item.kind])}</h3><span class="status-pill ${item.status}">${escapeHtml(labels.status[item.status])}</span></div>
      ${clarification}
      <div class="field-grid ${item.kind !== "task" ? "single" : ""}">${titleField}${taskFields}</div>
      <div class="review-actions">${controls}</div>
    </div>
  </article>`;
}

function renderCandidates() {
  const filters = {
    open: (item) => ["pending", "needs_clarification"].includes(item.status),
    approved: (item) => item.status === "approved",
    rejected: (item) => item.status === "rejected",
    all: () => true,
  };
  const items = app.state.candidates.filter(filters[app.candidateFilter]);
  const openCount = app.state.candidates.filter(filters.open).length;
  $("#filter-open-count").textContent = openCount;
  const deliberations = items.filter((item) => item.change_type === "deliberate");
  const actions = items.filter((item) => item.change_type !== "deliberate");
  const group = (className, kicker, title, copy, entries) => entries.length ? `<section class="candidate-group ${className}"><div class="candidate-group-head"><div><p class="section-kicker">${kicker}</p><h2>${title}</h2><span>${copy}</span></div><b>${entries.length}</b></div><div class="candidate-list">${entries.map(candidateCard).join("")}</div></section>` : "";
  $("#candidate-list").innerHTML = items.length
    ? group("deliberation-group", "NEEDS CONSENSUS", "需要继续协商", "讨论里存在共同问题，但还没有形成可执行结论。", deliberations)
      + group("action-group", "READY FOR REVIEW", "已经形成行动或记录", "这些内容可以在核对负责人、时间和证据后直接提交。", actions)
    : emptyState("✓", app.candidateFilter === "open" ? "讨论已经整理完毕" : "这个分类还没有内容", app.candidateFilter === "open" ? "所有议题和行动都已处理，可以继续导入下一场讨论。" : "切换筛选条件查看其他事项。");
  $$(".filter-chip").forEach((node) => node.classList.toggle("active", node.dataset.filter === app.candidateFilter));
}

function healthLabel(task) { return labels.health[task.health] || task.health; }

function taskCard(task) {
  return `<article class="task-card" data-task-id="${task.id}">
    <div class="task-top"><span class="task-id">TASK-${String(task.id).padStart(3, "0")} · v${task.version}</span><span class="health-label ${task.health}">${escapeHtml(healthLabel(task))}</span></div>
    <h3>${escapeHtml(task.title)}</h3>
    <div class="task-detail"><span class="owner-badge">${escapeHtml(initials(task.owner))}</span><span>${escapeHtml(task.owner)}</span></div>
    <div class="task-detail"><span>◷</span><time>${displayDate(task.due_at, true)}</time></div>
    <select class="task-status-select" aria-label="更新任务状态">${Object.entries(labels.taskStatus).map(([value, label]) => `<option value="${value}" ${task.status === value ? "selected" : ""}>${label}</option>`).join("")}</select>
  </article>`;
}

function renderBoard() {
  const columns = ["todo", "in_progress", "blocked", "done", "cancelled"];
  $("#task-board").innerHTML = columns.map((status) => {
    const tasks = app.state.tasks.filter((task) => task.status === status);
    return `<section class="board-column"><div class="board-column-head"><strong>${labels.taskStatus[status]}</strong><span>${tasks.length}</span></div><div class="board-stack">${tasks.length ? tasks.map(taskCard).join("") : '<div class="board-empty">暂无任务</div>'}</div></section>`;
  }).join("");
}

function renderReminders() {
  const now = app.state.simulated_now;
  $("#clock-large").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(now));
  $("#clock-input").value = localInputValue(now);
  $("#reminder-count").textContent = app.state.reminders.length;
  $("#reminder-list").innerHTML = app.state.reminders.length
    ? app.state.reminders.map((item) => `<article class="reminder-item"><div class="reminder-top"><strong>${escapeHtml(healthLabel({ health: item.kind }))} · TASK-${String(item.task_id).padStart(3, "0")}</strong><span class="draft-chip">仅草稿</span></div><p>${escapeHtml(item.draft)}</p></article>`).join("")
    : emptyState("◷", "目前无需提醒", "推进模拟时钟或把任务标记为阻塞后，提醒草稿会出现在这里。 ");
  $("#digest-output").textContent = app.reportText || app.state.digest;
  $("#report-title").textContent = app.reportScope === "weekly" ? "闭环周报" : "闭环日报";
  $("#report-kicker").textContent = app.reportScope === "weekly" ? "WEEKLY DIGEST" : "DAILY DIGEST";
  $$('[data-report-scope]').forEach((button) => button.classList.toggle("active", button.dataset.reportScope === app.reportScope));
}

async function loadReport(scope) {
  try {
    const result = await api(`/api/report?scope=${encodeURIComponent(scope)}`);
    app.reportScope = scope;
    app.reportText = result.report;
    renderReminders();
  } catch (error) { toast(error.message, "error"); }
}

function payloadSummary(payload) {
  const text = JSON.stringify(payload || {}, null, 0);
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}

function renderAudit() {
  $("#audit-count").textContent = app.state.audits.length;
  $("#model-token-count").textContent = app.state.stats.model_tokens.toLocaleString("zh-CN");
  const lastCall = app.state.provider.last_call;
  $("#model-last-call").textContent = lastCall
    ? `最近调用 ${lastCall.model} · ${lastCall.latency_ms}ms · ${(lastCall.prompt_tokens + lastCall.completion_tokens).toLocaleString("zh-CN")} Token`
    : "尚无模型调用；外部内容始终按不可信数据处理。";
  $("#audit-list").innerHTML = app.state.audits.length
    ? app.state.audits.map((event) => `<article class="audit-item"><time class="audit-time">${displayDate(event.created_at, true)}</time><span class="audit-glyph">${event.event_type.startsWith("human") ? "●" : event.event_type.startsWith("model") ? "✦" : "↗"}</span><div class="audit-body"><strong>${escapeHtml(labels.audit[event.event_type] || event.event_type)}</strong><small>${escapeHtml(payloadSummary(event.payload))}</small></div><span class="actor-chip">${escapeHtml(event.actor)}</span></article>`).join("")
    : emptyState("⌁", "还没有审计事件", "导入记录后，系统判断和工具动作会按时间记录在这里。 ");
}

function collectCandidateEdits(card) {
  const updates = {};
  const title = $("[name=title]", card)?.value.trim();
  const owner = $("[name=owner]", card)?.value.trim();
  const due = $("[name=due_at]", card)?.value;
  const target = $("[name=target_task_id]", card)?.value;
  if (title) updates.title = title;
  if (owner) updates.owner = owner;
  if (due) updates.due_at = apiDueValue(due);
  if (target) updates.target_task_id = Number(target);
  return updates;
}

async function candidateAction(button) {
  const card = button.closest(".candidate-card");
  const id = Number(card.dataset.candidateId);
  const action = button.dataset.action;
  const updates = collectCandidateEdits(card);
  button.disabled = true;
  try {
    if (action === "deliberate") {
      const result = await api(`/api/candidates/${id}/continue-deliberation`, {
        method: "POST",
        body: JSON.stringify({
          title: $('[name="title"]', card)?.value.trim(),
          scenario: $('[name="scenario"]', card)?.value,
          organizer: $('[name="organizer"]', card)?.value.trim(),
          idempotency_key: `deliberation:${id}:${crypto.randomUUID()}`,
        }),
      });
      app.decisionRoomId = result.room_id;
      await loadState();
      navigate("decisions");
      toast(result.idempotent_replay
        ? "该议题已在协商中，已为你打开"
        : `议题已进入协商，预填 ${result.participant_count} 人约束和 ${result.option_count} 个方案`);
    } else if (action === "clarify") {
      await api(`/api/candidates/${id}/clarify`, { method: "POST", body: JSON.stringify({ updates }) });
      toast("补充信息已保存，证据来源标记为人工确认");
    } else if (action === "approve") {
      await api(`/api/candidates/${id}/approve`, { method: "POST", body: JSON.stringify({ edits: updates, idempotency_key: `approve:${id}:${crypto.randomUUID()}` }) });
      toast("审批完成，动作已安全提交");
    } else {
      await api(`/api/candidates/${id}/reject`, { method: "POST", body: JSON.stringify({ idempotency_key: `reject:${id}:${crypto.randomUUID()}` }) });
      toast("已忽略，不会写入任务看板");
    }
    if (action !== "deliberate") await loadState();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

async function importFile(filename, content, extractorOverride = null) {
  const extractor = extractorOverride || $("input[name=extractor]:checked")?.value || "auto";
  setBusy(true, extractor === "rules" ? "正在运行本地 Baseline…" : "正在调用模型并校验证据…");
  try {
    const result = await api("/api/import", { method: "POST", body: JSON.stringify({ filename, content, extractor }) });
    if ($("#import-dialog").open) $("#import-dialog").close();
    $("#paste-input").value = "";
    app.selectedFile = null;
    updateDropzone();
    await loadState();
    navigate("candidates");
    const source = result.extractor === "deepseek" ? `${result.model} · ${result.latency_ms}ms` : "本地 Baseline";
    const routed = result.deliberation_count ? `，其中 ${result.deliberation_count} 个需要继续协商` : "";
    toast(`已读取 ${result.message_count} 条消息，整理出 ${result.candidate_count} 个事项${routed} · ${source}`);
    if (result.fallback_reason) toast(`模型未使用：${result.fallback_reason}`, "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function updateDropzone() {
  $("#drop-title").textContent = app.selectedFile ? app.selectedFile.name : "拖入文件，或点击选择";
  $("#drop-detail").textContent = app.selectedFile ? `${Math.ceil(app.selectedFile.size / 1024)} KB · 准备导入` : "最大 5 MB · UTF-8 编码";
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function loadDiscussionDemo() {
  setBusy(true, "正在导入一场聚餐讨论…");
  try {
    const content = await fetch("/decision-demo-chat.txt").then((response) => {
      if (!response.ok) throw new Error("无法读取讨论示例");
      return response.text();
    });
    await importFile("聚餐讨论示例.txt", content, "rules");
  } catch (error) {
    toast(error.message, "error");
    setBusy(false);
  }
}

async function submitParticipant(form) {
  const roomId = Number(form.dataset.roomId);
  const payload = formValues(form);
  payload.budget_private = form.elements.budget_private.checked;
  const button = $("button", form);
  button.disabled = true;
  try {
    await api(`/api/decision-rooms/${roomId}/participants`, { method: "POST", body: JSON.stringify(payload) });
    app.decisionRoomId = roomId;
    await loadState();
    navigate("decisions");
    toast(`${payload.name}的约束已保存`);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

async function submitOption(form) {
  const roomId = Number(form.dataset.roomId);
  const payload = formValues(form);
  const button = $("button", form);
  button.disabled = true;
  try {
    await api(`/api/decision-rooms/${roomId}/options`, { method: "POST", body: JSON.stringify(payload) });
    app.decisionRoomId = roomId;
    await loadState();
    navigate("decisions");
    toast(`候选方案“${payload.name}”已加入比较`);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

async function analyzeDecision(button) {
  const roomId = Number(button.dataset.roomId);
  button.disabled = true;
  try {
    const result = await api(`/api/decision-rooms/${roomId}/analyze`, { method: "POST", body: "{}" });
    app.decisionRoomId = roomId;
    await loadState();
    navigate("decisions");
    toast(`已记录 Pareto 计算：${result.analysis.feasible_count} 个可行方案，${result.analysis.pareto_count} 个前沿方案`);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

async function submitVote(form) {
  const roomId = Number(form.dataset.roomId);
  const participantId = Number(form.dataset.participantId);
  const optionIds = $$('[name="option_ids"]:checked', form).map((input) => Number(input.value));
  const participantName = $(".vote-person strong", form)?.textContent || "参与者";
  const button = $("button", form);
  button.disabled = true;
  try {
    await api(`/api/decision-rooms/${roomId}/votes`, {
      method: "POST",
      body: JSON.stringify({ participant_id: participantId, option_ids: optionIds }),
    });
    app.decisionRoomId = roomId;
    await loadState();
    navigate("decisions");
    toast(optionIds.length ? `${participantName}的认可票已保存` : `${participantName}的选票已清空`);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

async function finalizeDecision(form) {
  const roomId = Number(form.dataset.roomId);
  const payload = formValues(form);
  payload.option_id = Number(payload.option_id);
  payload.action_due_at = apiDueValue(payload.action_due_at);
  payload.idempotency_key = `decision:${roomId}:${crypto.randomUUID()}`;
  const button = $("button", form);
  button.disabled = true;
  setBusy(true, "正在把共同决定转为可追踪行动…");
  try {
    const result = await api(`/api/decision-rooms/${roomId}/finalize`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    app.decisionRoomId = roomId;
    await loadState();
    navigate("decisions");
    toast(result.task_id ? `最终方案已确认，并创建 TASK-${String(result.task_id).padStart(3, "0")}` : "最终方案已确认");
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  } finally {
    setBusy(false);
  }
}

document.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view], [data-view-link]");
  if (viewButton) navigate(viewButton.dataset.view || viewButton.dataset.viewLink);
  if (event.target.closest("[data-open-import]")) $("#import-dialog").showModal();
  const roomButton = event.target.closest("[data-room-open], [data-room-switch]");
  if (roomButton) {
    app.decisionRoomId = Number(roomButton.dataset.roomOpen || roomButton.dataset.roomSwitch);
    navigate("decisions");
    renderDecisions();
  }
  const decisionAction = event.target.closest('[data-decision-action="analyze"]');
  if (decisionAction) await analyzeDecision(decisionAction);
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) await candidateAction(actionButton);
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.matches(".decision-participant-form")) {
    event.preventDefault();
    await submitParticipant(form);
  } else if (form.matches(".decision-option-form")) {
    event.preventDefault();
    await submitOption(form);
  } else if (form.matches(".decision-vote-form")) {
    event.preventDefault();
    await submitVote(form);
  } else if (form.matches(".decision-finalize-form")) {
    event.preventDefault();
    await finalizeDecision(form);
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.matches('input[name="extractor"]')) {
    $("#privacy-disclosure").textContent = event.target.value === "rules"
      ? "本地 Baseline 不会向任何模型服务发送对话内容。"
      : "智能增强模式会把本次对话发送给已配置的 DeepSeek API；密钥仅从服务端环境变量读取。";
  }
  if (event.target.matches(".task-status-select")) {
    const card = event.target.closest(".task-card");
    try {
      await api(`/api/tasks/${card.dataset.taskId}`, { method: "POST", body: JSON.stringify({ updates: { status: event.target.value } }) });
      toast("任务状态已更新并记录审计");
      await loadState();
    } catch (error) { toast(error.message, "error"); await loadState(); }
  }
  if (event.target.matches("#file-input")) {
    app.selectedFile = event.target.files[0] || null;
    updateDropzone();
  }
});

$("#import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let filename = "粘贴的对话.txt";
  let content = $("#paste-input").value.trim();
  if (app.selectedFile) {
    filename = app.selectedFile.name;
    content = await app.selectedFile.text();
  }
  if (!content) return toast("请选择文件或粘贴对话内容", "error");
  await importFile(filename, content);
});

$("#clock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/time", { method: "POST", body: JSON.stringify({ now: apiDueValue($("#clock-input").value) }) });
    toast("模拟时间已推进，提醒队列已重算");
    await loadState();
  } catch (error) { toast(error.message, "error"); }
});

$("#download-report").addEventListener("click", () => {
  const blob = new Blob([app.reportText || app.state.digest], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `converge-${app.reportScope}-${app.state.simulated_now.slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
});

$$('[data-report-scope]').forEach((button) => button.addEventListener("click", () => loadReport(button.dataset.reportScope)));

$("#decision-demo-button").addEventListener("click", loadDiscussionDemo);
$("#close-import").addEventListener("click", () => $("#import-dialog").close());
$("#mobile-menu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#reset-button").addEventListener("click", async () => {
  if (!confirm("确定清空所有本地演示数据吗？此操作不可撤销。")) return;
  try {
    await api("/api/reset", { method: "POST", body: "{}" });
    toast("本地演示数据已清空");
    await loadState();
    navigate("dashboard");
  } catch (error) { toast(error.message, "error"); }
});

$$(`[data-filter]`).forEach((button) => button.addEventListener("click", () => {
  app.candidateFilter = button.dataset.filter;
  renderCandidates();
}));

const dropzone = $("#dropzone");
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); }));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); }));
dropzone.addEventListener("drop", (event) => {
  app.selectedFile = event.dataTransfer.files[0] || null;
  updateDropzone();
});

window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
loadState();
