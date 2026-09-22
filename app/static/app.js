/* 混响配方实验台 —— 前端逻辑（原生 JS，无依赖） */

const BANDS = [125, 250, 500, 1000, 2000];
let library = [];
let lastRecommendation = null;

// ---------- 工具 ----------

const $ = (id) => document.getElementById(id);

/* HTML 转义：用户输入的名称插入页面前必须转义 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function showMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text;
  el.className = "message " + (isError ? "error" : "ok");
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 5000);
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = data.detail;
    const msg = Array.isArray(detail)
      ? detail.map((d) => d.msg).join("；")
      : (detail || `请求失败 (${resp.status})`);
    throw new Error(msg);
  }
  return data;
}

// ---------- 材料表格 ----------

function addMaterialRow(mat = {}) {
  const tbody = $("materials-body");
  const tr = document.createElement("tr");
  const coeffs = mat.coeffs || {};
  tr.innerHTML = `
    <td><input type="text" class="m-name" value="${esc(mat.name ?? "")}" placeholder="材料名" maxlength="50"></td>
    <td><input type="number" class="area" value="${mat.area ?? 10}" min="0.01" step="any"></td>
    ${BANDS.map((b) => `
      <td><input type="number" class="coeff" data-band="${b}"
           value="${coeffs[String(b)] ?? 0.1}" min="0" max="1" step="0.01"></td>`).join("")}
    <td><button class="btn small danger del-btn" title="删除该行">✕</button></td>
  `;
  tr.querySelector(".del-btn").onclick = () => {
    tr.remove();
    updateTotalArea();
  };
  tr.querySelectorAll("input").forEach((i) => i.addEventListener("input", updateTotalArea));
  tbody.appendChild(tr);
  updateTotalArea();
}

function updateTotalArea() {
  let total = 0;
  document.querySelectorAll("#materials-body .area").forEach((i) => {
    total += parseFloat(i.value) || 0;
  });
  $("total-area").textContent = total.toFixed(1);
}

function readConfig() {
  const volume = parseFloat($("volume").value);
  if (!volume || volume <= 0) throw new Error("请填写有效的房间体积");
  const targetMin = parseFloat($("target-min").value);
  const targetMax = parseFloat($("target-max").value);
  if (!(targetMin >= 0) || !(targetMax > 0) || targetMax < targetMin) {
    throw new Error("目标区间无效：需满足 0 ≤ 下限 ≤ 上限");
  }
  const materials = [];
  document.querySelectorAll("#materials-body tr").forEach((tr) => {
    const name = tr.querySelector(".m-name").value.trim();
    const area = parseFloat(tr.querySelector(".area").value);
    const coeffs = {};
    tr.querySelectorAll(".coeff").forEach((c) => {
      coeffs[c.dataset.band] = parseFloat(c.value);
    });
    if (!name) throw new Error("存在未命名的材料行");
    if (!(area > 0)) throw new Error(`材料「${name}」面积须大于 0`);
    for (const b of BANDS) {
      const v = coeffs[String(b)];
      if (!(v >= 0 && v <= 1)) throw new Error(`材料「${name}」${b}Hz 系数须在 0~1 之间`);
    }
    materials.push({ name, area, coeffs });
  });
  if (materials.length === 0) throw new Error("请至少添加一种材料");
  return { volume, materials, target_min: targetMin, target_max: targetMax };
}

function fillConfig(config, name = "") {
  $("exp-name").value = name;
  $("volume").value = config.volume;
  $("target-min").value = config.target_min;
  $("target-max").value = config.target_max;
  $("materials-body").innerHTML = "";
  config.materials.forEach((m) => addMaterialRow(m));
}

// ---------- 计算与渲染 ----------

async function calculate() {
  const config = readConfig();
  const data = await api("/api/calculate", {
    method: "POST",
    body: JSON.stringify(config),
  });
  renderResult(data, config);
  return data;
}

function renderResult(data, config) {
  const { rt60, eval: ev, absorption, ok_count: okCount } = data;
  const tmin = config.target_min, tmax = config.target_max;

  const summary = $("result-summary");
  summary.innerHTML = okCount === BANDS.length
    ? `<span class="ok">✓ 全部 ${BANDS.length} 个频带达标</span>（目标 ${tmin}~${tmax}s）`
    : `<span class="bad">✗ ${okCount}/${BANDS.length} 个频带达标</span>（目标 ${tmin}~${tmax}s）`;

  const tbody = $("rt-body");
  tbody.innerHTML = "";
  for (const b of BANDS) {
    const rt = rt60[String(b)] ?? rt60[b];
    const e = ev[String(b)] ?? ev[b];
    const a = absorption[String(b)] ?? absorption[b];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${b} Hz</td>
      <td>${a.toFixed(2)}</td>
      <td>${rt === null ? "∞" : rt.toFixed(2)}</td>
      <td><span class="badge ${e.in_range ? "ok" : "bad"}">${e.in_range ? "达标" : "未达标"}</span></td>
    `;
    tbody.appendChild(tr);
  }
  drawChart($("rt-chart"), rt60, ev, tmin, tmax);
}

// ---------- 频响曲线图（Canvas） ----------

function drawChart(canvas, rt60, ev, tmin, tmax) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 640;
  const H = 360;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 52, r: 16, t: 18, b: 34 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const values = BANDS.map((b) => rt60[String(b)] ?? rt60[b]);
  const finite = values.filter((v) => v !== null && v !== undefined);
  const yMax = Math.max(tmax * 1.4, ...(finite.length ? finite : [1])) * 1.15;
  const yMin = 0;

  const x = (i) => pad.l + (plotW * i) / (BANDS.length - 1);
  const y = (v) => pad.t + plotH - ((Math.min(v, yMax) - yMin) / (yMax - yMin)) * plotH;

  // 目标区间阴影
  ctx.fillStyle = "rgba(52, 201, 142, 0.12)";
  ctx.fillRect(pad.l, y(tmax), plotW, y(tmin) - y(tmax));
  ctx.strokeStyle = "rgba(52, 201, 142, 0.6)";
  ctx.setLineDash([5, 4]);
  [tmin, tmax].forEach((t) => {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(t));
    ctx.lineTo(pad.l + plotW, y(t));
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // 网格与坐标
  ctx.strokeStyle = "#2e3a55";
  ctx.fillStyle = "#8b96ad";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + ((yMax - yMin) * i) / ticks;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(pad.l + plotW, yy);
    ctx.stroke();
    ctx.fillText(v.toFixed(1) + "s", pad.l - 6, yy + 4);
  }
  ctx.textAlign = "center";
  BANDS.forEach((b, i) => {
    ctx.fillText(b >= 1000 ? b / 1000 + "k" : String(b), x(i), pad.t + plotH + 18);
  });
  ctx.fillText("Hz", pad.l + plotW + 4, pad.t + plotH + 18);

  // RT60 折线
  ctx.strokeStyle = "#4da3ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const vv = v === null ? yMax : v;
    if (i === 0) ctx.moveTo(x(i), y(vv));
    else ctx.lineTo(x(i), y(vv));
  });
  ctx.stroke();
  ctx.lineWidth = 1;

  // 数据点（按达标着色）
  values.forEach((v, i) => {
    const b = BANDS[i];
    const e = ev[String(b)] ?? ev[b];
    const vv = v === null ? yMax : v;
    ctx.fillStyle = e.in_range ? "#34c98e" : "#ff6b6b";
    ctx.beginPath();
    ctx.arc(x(i), y(vv), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e8ecf4";
    ctx.fillText(v === null ? "∞" : v.toFixed(2), x(i), y(vv) - 10);
  });
}

// ---------- 推荐 ----------

async function doRecommend() {
  const config = readConfig();
  const data = await api("/api/recommend", {
    method: "POST",
    body: JSON.stringify(config),
  });
  renderRecommendation(data, config);
}

function renderRecommendation(data, config) {
  const box = $("recommendation");
  const content = $("rec-content");
  const alt = $("alternatives");
  const rec = data.recommendation;
  lastRecommendation = rec;

  if (!rec) {
    box.classList.remove("hidden");
    content.innerHTML = "<p>材料库为空，无法给出推荐。</p>";
    alt.innerHTML = "";
    return;
  }

  const head = rec.improved
    ? `<p><strong>推荐：</strong>把「${esc(rec.old_name)}」换成「${esc(rec.new_name)}」（${rec.area} m² 不变），达标频带 ${data.before.ok_count} → <strong>${rec.ok_count}</strong> / ${BANDS.length}。</p>`
    : `<p><strong>当前已是最优附近：</strong>单次替换无法进一步改善（最优替换：「${esc(rec.old_name)}」→「${esc(rec.new_name)}」）。</p>`;

  content.innerHTML = head + "<ul>" +
    rec.explanation.map((l) => `<li>${esc(l)}</li>`).join("") + "</ul>";

  if (data.alternatives.length) {
    alt.innerHTML = "其他候选方案：" +
      "<table><thead><tr><th>替换</th><th>换为</th><th>达标数</th><th>总违规量(s)</th></tr></thead><tbody>" +
      data.alternatives.map((a) =>
        `<tr><td>${esc(a.old_name)}</td><td>${esc(a.new_name)}</td><td>${a.ok_count}/${BANDS.length}</td><td>${a.violation.toFixed(3)}</td></tr>`
      ).join("") + "</tbody></table>";
  } else {
    alt.innerHTML = "";
  }
  box.classList.remove("hidden");
}

function applyRecommendation() {
  if (!lastRecommendation) return;
  fillConfig({
    volume: parseFloat($("volume").value),
    materials: lastRecommendation.materials,
    target_min: parseFloat($("target-min").value),
    target_max: parseFloat($("target-max").value),
  }, $("exp-name").value);
  calculate().catch((e) => showMessage(e.message, true));
  showMessage(`已应用替换：${lastRecommendation.old_name} → ${lastRecommendation.new_name}`);
}

// ---------- 实验保存 / 加载 / 删除 ----------

async function saveExperiment() {
  const config = readConfig();
  const name = $("exp-name").value.trim() || `实验 ${new Date().toLocaleString()}`;
  await api("/api/experiments", {
    method: "POST",
    body: JSON.stringify({ name, ...config }),
  });
  showMessage(`已保存「${name}」`);
  loadExperiments();
}

async function loadExperiments() {
  const data = await api("/api/experiments");
  const tbody = $("experiments-body");
  tbody.innerHTML = "";
  if (!data.experiments.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">暂无保存的实验</td></tr>`;
    return;
  }
  for (const exp of data.experiments) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${exp.id}</td>
      <td>${esc(exp.name)}</td>
      <td>${new Date(exp.created_at).toLocaleString()}</td>
      <td>
        <button class="btn small load-btn">载入</button>
        <button class="btn small danger del-exp-btn">删除</button>
      </td>
    `;
    tr.querySelector(".load-btn").onclick = async () => {
      const full = await api(`/api/experiments/${exp.id}`);
      fillConfig(full.config, full.name);
      $("recommendation").classList.add("hidden");
      showMessage(`已载入「${full.name}」`);
      calculate().catch((e) => showMessage(e.message, true));
    };
    tr.querySelector(".del-exp-btn").onclick = async () => {
      if (!confirm(`确定删除实验「${exp.name}」？`)) return;
      await api(`/api/experiments/${exp.id}`, { method: "DELETE" });
      showMessage(`已删除「${exp.name}」`);
      loadExperiments();
    };
    tbody.appendChild(tr);
  }
}

// ---------- 初始化 ----------

async function init() {
  const data = await api("/api/materials");
  library = data.library;

  const sel = $("library-select");
  library.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
  sel.onchange = () => {
    if (sel.value === "") return;
    const m = library[parseInt(sel.value)];
    addMaterialRow({ name: m.name, area: 10, coeffs: m.coeffs });
    sel.value = "";
  };

  $("add-material").onclick = () => addMaterialRow();
  $("calc-btn").onclick = () =>
    calculate().catch((e) => showMessage(e.message, true));
  $("recommend-btn").onclick = () =>
    doRecommend().catch((e) => showMessage(e.message, true));
  $("save-btn").onclick = () =>
    saveExperiment().catch((e) => showMessage(e.message, true));
  $("apply-rec-btn").onclick = applyRecommendation;

  // 默认示例：一间 120 m³ 的房间
  fillConfig({
    volume: 120,
    target_min: 0.4,
    target_max: 0.8,
    materials: [
      { name: "混凝土/砖墙（抹灰）", area: 130, coeffs: { "125": 0.01, "250": 0.01, "500": 0.02, "1000": 0.02, "2000": 0.03 } },
      { name: "玻璃窗（普通）", area: 12, coeffs: { "125": 0.15, "250": 0.10, "500": 0.08, "1000": 0.05, "2000": 0.04 } },
      { name: "厚地毯（泡沫垫）", area: 20, coeffs: { "125": 0.05, "250": 0.15, "500": 0.35, "1000": 0.55, "2000": 0.60 } },
    ],
  });
  await loadExperiments();
  calculate().catch(() => {});
}

init().catch((e) => showMessage(e.message, true));
