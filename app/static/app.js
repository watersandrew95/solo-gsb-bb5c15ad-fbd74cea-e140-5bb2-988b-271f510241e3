/* 混响配方实验台 —— 前端逻辑（原生 JS，Canvas 绘图） */

const $ = (sel) => document.querySelector(sel);

const state = {
  bands: [125, 250, 500, 1000, 2000],
  materials: [],
  rooms: [],
  currentRoom: null,      // 当前房间完整数据（含 rt60）
  recommendation: null,   // 当前推荐结果
};

/* ---------- 工具 ---------- */

async function api(path, options = {}) {
  if (options.body) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, options);
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try { msg = (await res.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

function getTarget() {
  const min = parseFloat($("#target-min").value);
  const max = parseFloat($("#target-max").value);
  if (!(min > 0) || !(max > 0) || min > max) {
    throw new Error("目标区间无效：请保证 0 < 下限 ≤ 上限");
  }
  return { target_min: min, target_max: max };
}

const fmt = (v) => (v === null || v === undefined ? "∞" : Number(v).toFixed(2));

/* ---------- Canvas 频响曲线 ---------- */

function drawChart(canvas, rt60Bands, target, afterRt60) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const padL = 56, padR = 20, padT = 26, padB = 44;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);

  // 收集数值确定 y 轴范围
  const vals = [];
  for (const b of state.bands) {
    const v = rt60Bands?.[String(b)]?.rt60;
    if (v !== null && v !== undefined) vals.push(v);
    const a = afterRt60?.[String(b)];
    if (a !== null && a !== undefined) vals.push(a);
  }
  if (target) vals.push(target.target_max, target.target_min);
  const yMax = Math.max(1.2, ...vals) * 1.2;
  const yOf = (v) => padT + plotH * (1 - Math.min(v, yMax) / yMax);
  const xOf = (i) => padL + (plotW * (i + 0.5)) / state.bands.length;

  // 网格与 y 轴刻度
  ctx.strokeStyle = "#2e3a55";
  ctx.fillStyle = "#8fa0bd";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const v = (yMax * i) / steps;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(1), padL - 8, y + 4);
  }
  ctx.save();
  ctx.translate(14, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("RT60 (s)");
  ctx.restore();

  // 目标区间阴影
  if (target) {
    const y1 = yOf(target.target_max), y2 = yOf(target.target_min);
    ctx.fillStyle = "rgba(62,207,142,0.12)";
    ctx.fillRect(padL, y1, plotW, y2 - y1);
    ctx.strokeStyle = "rgba(62,207,142,0.6)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(padL, y1, plotW, y2 - y1);
    ctx.setLineDash([]);
    ctx.fillStyle = "#3ecf8e";
    ctx.textAlign = "left";
    ctx.fillText(`目标 ${target.target_min}~${target.target_max}s`, padL + 6, y1 + 14);
  }

  // x 轴频带标签
  ctx.fillStyle = "#8fa0bd";
  ctx.textAlign = "center";
  state.bands.forEach((b, i) => {
    ctx.fillText(b >= 1000 ? `${b / 1000}k Hz` : `${b} Hz`, xOf(i), H - padB + 18);
  });

  // 折线绘制函数
  function line(getVal, color, dash, label) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    state.bands.forEach((b, i) => {
      const v = getVal(String(b));
      if (v === null || v === undefined) return;
      const x = xOf(i), y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    state.bands.forEach((b, i) => {
      const v = getVal(String(b));
      if (v === null || v === undefined) return;
      const x = xOf(i), y = yOf(v);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(Number(v).toFixed(2), x, y - 9);
    });
    ctx.lineWidth = 1;
  }

  line((b) => rt60Bands?.[b]?.rt60, "#4da3ff", [], "当前");
  if (afterRt60) line((b) => afterRt60[b], "#ffb84d", [6, 4], "替换后");

  // 图例
  ctx.textAlign = "left";
  ctx.fillStyle = "#4da3ff";
  ctx.fillText("● 当前", W - padR - 110, 16);
  if (afterRt60) {
    ctx.fillStyle = "#ffb84d";
    ctx.fillText("◌ 替换后", W - padR - 60, 16);
  }
}

/* ---------- 渲染：侧栏 ---------- */

async function refreshRooms() {
  state.rooms = await api("/api/rooms");
  const ul = $("#room-list");
  ul.innerHTML = "";
  for (const r of state.rooms) {
    const li = document.createElement("li");
    li.classList.toggle("active", state.currentRoom?.id === r.id);
    li.innerHTML = `<span>${r.name}</span><span class="meta">${r.volume} m³</span>`;
    li.onclick = () => selectRoom(r.id);
    ul.appendChild(li);
  }
  if (!state.rooms.length) ul.innerHTML = '<li class="meta">暂无房间</li>';
}

async function refreshExperiments() {
  const exps = await api("/api/experiments");
  const ul = $("#experiment-list");
  ul.innerHTML = "";
  for (const e of exps) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${e.name}<br><span class="meta">${e.room_name ?? "（房间已删）"} · ${e.created_at}</span></span>
      <button class="del" title="删除实验">✕</button>`;
    li.querySelector("span").onclick = () => viewExperiment(e.id);
    li.querySelector(".del").onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`删除实验「${e.name}」？`)) return;
      await api(`/api/experiments/${e.id}`, { method: "DELETE" });
      toast("实验已删除");
      $("#experiment-view").hidden = true;
      refreshExperiments();
    };
    ul.appendChild(li);
  }
  if (!exps.length) ul.innerHTML = '<li class="meta">暂无实验</li>';
}

/* ---------- 渲染：房间 ---------- */

async function selectRoom(id) {
  state.currentRoom = await api(`/api/rooms/${id}`);
  state.recommendation = null;
  $("#empty-hint").hidden = true;
  $("#experiment-view").hidden = true;
  $("#room-view").hidden = false;
  renderRoom();
  refreshRooms();
}

function renderRoom() {
  const room = state.currentRoom;
  $("#room-name").value = room.name;
  $("#room-volume").value = room.volume;
  $("#recommend-panel").hidden = true;

  // 表面表格
  const tbody = $("#surface-table tbody");
  tbody.innerHTML = "";
  for (const s of room.surfaces) {
    const tr = document.createElement("tr");
    const opts = state.materials
      .map((m) => `<option value="${m.id}" ${m.id === s.material_id ? "selected" : ""}>${m.name}</option>`)
      .join("");
    tr.innerHTML = `
      <td><input value="${s.name}" maxlength="80"></td>
      <td><input type="number" step="any" min="0.1" value="${s.area}"></td>
      <td><select>${opts}</select></td>
      <td><button class="del danger small">删除</button></td>`;
    const [nameInput, areaInput, matSel] = tr.querySelectorAll("input, select");
    const save = async () => {
      try {
        state.currentRoom = await api(`/api/surfaces/${s.id}`, {
          method: "PUT",
          body: { name: nameInput.value, area: parseFloat(areaInput.value), material_id: +matSel.value },
        });
        state.recommendation = null;
        renderRoom();
        toast("已更新");
      } catch (e) { toast(e.message, true); }
    };
    nameInput.onchange = save;
    areaInput.onchange = save;
    matSel.onchange = save;
    tr.querySelector(".del").onclick = async () => {
      state.currentRoom = await api(`/api/surfaces/${s.id}`, { method: "DELETE" });
      state.recommendation = null;
      renderRoom();
    };
    tbody.appendChild(tr);
  }

  renderRt60Table();
  redrawChart();
}

function renderRt60Table() {
  const room = state.currentRoom;
  let target = null;
  try { target = getTarget(); } catch (e) {}
  const tbody = $("#rt60-table tbody");
  tbody.innerHTML = "";
  for (const b of state.bands) {
    const d = room.rt60.bands[String(b)];
    let badge = '<span class="badge bad">—</span>';
    if (target && d.rt60 !== null) {
      const ok = d.rt60 >= target.target_min && d.rt60 <= target.target_max;
      badge = `<span class="badge ${ok ? "ok" : "bad"}">${ok ? "✓ 达标" : "✗ 超标"}</span>`;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${b} Hz</td><td>${d.absorption.toFixed(2)}</td><td>${fmt(d.rt60)}</td><td>${badge}</td>`;
    tbody.appendChild(tr);
  }
}

function redrawChart() {
  let target = null;
  try { target = getTarget(); } catch (e) {}
  const after = state.recommendation?.best?.rt60_after ?? null;
  drawChart($("#rt60-chart"), state.currentRoom.rt60.bands, target, after);
}

/* ---------- 推荐 ---------- */

async function recommend() {
  const room = state.currentRoom;
  if (!room) return;
  let target;
  try { target = getTarget(); } catch (e) { return toast(e.message, true); }
  try {
    state.recommendation = await api(`/api/rooms/${room.id}/recommend`, {
      method: "POST", body: target,
    });
  } catch (e) { return toast(e.message, true); }
  renderRecommendation(state.recommendation, $("#recommend-result"));
  $("#recommend-panel").hidden = false;
  renderRt60Table();
  redrawChart();
}

function bandDetailTable(details) {
  const rows = details.map((d) => {
    const arrow = d.improved ? '<span class="up">↑ 达标</span>'
      : d.worsened ? '<span class="down">↓ 跌出</span>' : "";
    return `<tr>
      <td>${d.band} Hz</td>
      <td>${d.absorption_before.toFixed(2)} → ${d.absorption_after.toFixed(2)}</td>
      <td>${fmt(d.rt60_before)} → ${fmt(d.rt60_after)}</td>
      <td>${arrow}</td></tr>`;
  }).join("");
  return `<table class="band-detail">
    <thead><tr><th>频带</th><th>A (m²)</th><th>RT60 (s)</th><th>变化</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderRecommendation(rec, container) {
  if (rec.error) { container.innerHTML = `<p>${rec.error}</p>`; return; }
  let html = "";
  if (rec.already_ok) {
    html += `<p><span class="badge ok">当前方案已全部达标 (5/5)</span> 仍可参考以下方案进一步优化。</p>`;
  } else {
    html += `<p>当前达标频带 <b>${rec.before.ok}/5</b>，总偏差 ${rec.before.deviation.toFixed(2)} s。</p>`;
  }
  if (rec.best) {
    const b = rec.best;
    html += `<div class="rec-card">
      <h3>✅ 最优替换：${b.surface_name}｜${b.old_material} → ${b.new_material}</h3>
      <p>替换后达标 <b>${b.ok_after}/5</b>，总偏差 ${b.deviation_after.toFixed(2)} s</p>
      <p class="why">${b.explanation}</p>
      ${bandDetailTable(b.band_details)}
    </div>`;
  }
  if (rec.alternatives?.length) {
    html += `<h3 style="font-size:14px;color:var(--muted)">备选方案</h3>`;
    for (const a of rec.alternatives) {
      html += `<div class="rec-card alt">
        <h3>${a.surface_name}｜${a.old_material} → ${a.new_material}</h3>
        <p>达标 ${a.ok_after}/5，总偏差 ${a.deviation_after.toFixed(2)} s</p>
        <p class="why">${a.explanation}</p>
      </div>`;
    }
  }
  container.innerHTML = html;
}

/* ---------- 实验快照 ---------- */

async function viewExperiment(id) {
  const exp = await api(`/api/experiments/${id}`);
  $("#room-view").hidden = true;
  $("#empty-hint").hidden = true;
  $("#experiment-view").hidden = false;
  $("#exp-title").textContent = `实验：${exp.name}`;
  const snap = exp.snapshot;
  $("#exp-meta").innerHTML =
    `房间 <b>${snap.room_name}</b>（V = ${snap.volume} m³）· ` +
    `目标 ${exp.target_min}~${exp.target_max} s · 保存于 ${exp.created_at}<br>` +
    `表面：${snap.surfaces.map((s) => `${s.name}(${s.area}m², ${s.material_name})`).join("、")}`;
  drawChart($("#exp-chart"), snap.rt60.bands,
    { target_min: exp.target_min, target_max: exp.target_max },
    exp.recommendation?.best?.rt60_after ?? null);
  const box = $("#exp-recommendation");
  if (exp.recommendation) renderRecommendation(exp.recommendation, box);
  else box.innerHTML = "";
}

/* ---------- 事件绑定 ---------- */

$("#new-room-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const room = await api("/api/rooms", {
      method: "POST",
      body: { name: $("#new-room-name").value, volume: parseFloat($("#new-room-volume").value) },
    });
    $("#new-room-form").reset();
    await refreshRooms();
    await selectRoom(room.id);
    toast("房间已创建");
  } catch (err) { toast(err.message, true); }
};

$("#save-room-meta").onclick = async () => {
  try {
    state.currentRoom = await api(`/api/rooms/${state.currentRoom.id}`, {
      method: "PUT",
      body: { name: $("#room-name").value, volume: parseFloat($("#room-volume").value) },
    });
    state.recommendation = null;
    renderRoom();
    refreshRooms();
    toast("已保存，RT60 已重算");
  } catch (e) { toast(e.message, true); }
};

$("#delete-room").onclick = async () => {
  if (!confirm(`删除房间「${state.currentRoom.name}」及其全部表面？`)) return;
  await api(`/api/rooms/${state.currentRoom.id}`, { method: "DELETE" });
  state.currentRoom = null;
  $("#room-view").hidden = true;
  $("#empty-hint").hidden = false;
  refreshRooms();
  toast("房间已删除");
};

$("#add-surface-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    state.currentRoom = await api(`/api/rooms/${state.currentRoom.id}/surfaces`, {
      method: "POST",
      body: {
        name: $("#surface-name").value,
        area: parseFloat($("#surface-area").value),
        material_id: +$("#surface-material").value,
      },
    });
    state.recommendation = null;
    $("#surface-name").value = "";
    $("#surface-area").value = "";
    renderRoom();
  } catch (err) { toast(err.message, true); }
};

$("#recommend-btn").onclick = recommend;

$("#save-exp-btn").onclick = async () => {
  if (!state.currentRoom) return;
  const name = $("#exp-name").value.trim();
  if (!name) return toast("请先填写实验名称", true);
  let target;
  try { target = getTarget(); } catch (e) { return toast(e.message, true); }
  try {
    await api(`/api/rooms/${state.currentRoom.id}/experiments`, {
      method: "POST", body: { name, ...target },
    });
    $("#exp-name").value = "";
    refreshExperiments();
    toast("实验已保存");
  } catch (e) { toast(e.message, true); }
};

$("#close-exp").onclick = () => {
  $("#experiment-view").hidden = true;
  if (state.currentRoom) $("#room-view").hidden = false;
  else $("#empty-hint").hidden = false;
};

$("#target-min").onchange = () => { if (state.currentRoom) { renderRt60Table(); redrawChart(); } };
$("#target-max").onchange = () => { if (state.currentRoom) { renderRt60Table(); redrawChart(); } };

/* ---------- 启动 ---------- */

(async function init() {
  try {
    const data = await api("/api/materials");
    state.bands = data.bands;
    state.materials = data.materials;
    $("#surface-material").innerHTML = state.materials
      .map((m) => `<option value="${m.id}">${m.name}（α500=${m.coeffs[2]}）</option>`)
      .join("");
    await refreshRooms();
    await refreshExperiments();
  } catch (e) {
    toast("初始化失败: " + e.message, true);
  }
})();
