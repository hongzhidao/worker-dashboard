import { chart } from "./charts.js";

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const fmt = (value, precision = 1) =>
  Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: precision })
    : "--";
const json = (value) => JSON.stringify(value, null, 2);
const clone = (value) => JSON.parse(JSON.stringify(value));
const clock = (time) =>
  time ? new Date(time * 1000).toLocaleTimeString("zh-CN") : "--";
const stamp = (time) =>
  new Date(time * 1000).toLocaleString("zh-CN", { hour12: false });
const language = (app) => String(app?.type || "").split(/\s/)[0];
const languageName = (app) =>
  ({ python: "Python", php: "PHP", ruby: "Ruby", external: "Go / External" })[
    language(app)
  ] ||
  app?.type ||
  "--";
const appRoute = (name, tab = "runtime") =>
  "/apps/" + encodeURIComponent(name) + "/" + tab;
const operations = {
  application: "更新应用",
  delete: "删除应用",
  configuration: "更新配置",
  restore: "恢复配置",
  restart: "重启应用",
};
const results = {
  success: "已完成",
  failed: "失败",
  unknown: "结果待确认",
  pending: "结果待确认",
  changed: "配置再次发生变更",
};
let state = null,
  records = [],
  route = "",
  editor = null,
  dirty = false,
  loading = false,
  authenticated = false;
let timer,
  toastTimer,
  pending = null,
  historyRecord = null,
  lastHistory = 0;
let search = "",
  filter = "",
  trafficMode = "qps",
  range = 900,
  detailRange = 300,
  routeGeneration = 0;

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Worker-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "login") showLogin();
    const translations = {
      401: "管理员口令错误或登录已过期。",
      403: "请求来源未获允许。",
      409: "配置已发生变化，请重新载入后再提交。",
      429: "尝试次数过多，请一分钟后重试。",
      502: "无法连接 Worker，请检查控制连接。",
    };
    const detail =
      value.detail?.detail ||
      value.detail?.error ||
      value.detail ||
      value.error;
    const error = new Error(
      (translations[response.status] || "操作未完成。") +
        (detail
          ? "\n" + (typeof detail === "string" ? detail : json(detail))
          : ""),
    );
    error.status = response.status;
    throw error;
  }
  return value;
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 5000);
}

function showLogin() {
  authenticated = false;
  clearTimeout(timer);
  routeGeneration++;
  state = null;
  records = [];
  editor = null;
  pending = null;
  historyRecord = null;
  dirty = false;
  lastHistory = 0;
  $("#content").replaceChildren();
  $("#dialog-body").replaceChildren();
  $("#dialog-error").textContent = "";
  $("#toast").hidden = true;
  $("#app").hidden = true;
  $("#login").hidden = false;
  if ($("#dialog").open) $("#dialog").close();
  $("#login-form input").focus();
}

function getRoute() {
  return location.hash.slice(1) || "/overview";
}

function routeParts() {
  try {
    return route.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return ["overview"];
  }
}

function canLeave() {
  return !dirty || window.confirm("尚有未提交的修改。放弃这些修改并离开？");
}

function go(target) {
  if (!canLeave()) return;
  dirty = false;
  if (target === route) renderRoute();
  else location.hash = target;
}

function heading(title, subtitle = "", actions = "") {
  return `<div class="page-heading"><div><h1>${esc(title)}</h1><div class="subtitle">${esc(subtitle)}</div></div><div class="heading-actions">${actions}</div></div>`;
}

function button(action, label, symbol, primary = false, attributes = "") {
  return `<button type="${action === "preview" ? "submit" : "button"}" class="button${primary ? " primary" : ""}" data-action="${action}" ${attributes}>${symbol ? icon(symbol) : ""}${esc(label)}</button>`;
}

function iconButton(action, label, symbol, attributes = "") {
  return `<button type="button" class="icon-button" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${attributes}>${icon(symbol)}</button>`;
}

function statusLabel(app, stats) {
  if (!state?.connected) return '<span class="status gray">数据过期</span>';
  if (!stats) return '<span class="status gray">等待状态</span>';
  const p = stats.processes || {};
  if (p.starting) return '<span class="status amber">启动中</span>';
  if (p.stopping) return '<span class="status amber">退出中</span>';
  if (p.running) return '<span class="status">运行中</span>';
  if (typeof app.processes === "object" && app.processes?.spare === 0)
    return '<span class="status gray">按需待命</span>';
  return '<span class="status gray">无运行进程</span>';
}

function metric(label, value, note = "", unit = "", precision = 1) {
  return `<div class="metric" data-metric="${esc(label)}"><div class="metric-label">${esc(label)}</div><div class="metric-value">${fmt(value, precision)}${unit ? `<small>${unit}</small>` : ""}</div><div class="metric-note">${esc(note)}</div></div>`;
}

const responseClasses = ["1xx", "2xx", "3xx", "4xx", "5xx"];

function responseTotal(responses) {
  if (!responseClasses.every((key) => Number.isFinite(responses?.[key])))
    return null;
  return responseClasses.reduce((sum, key) => sum + responses[key], 0);
}

function failureRate(responses) {
  const total = responseTotal(responses);
  return total > 0 ? (responses["5xx"] / total) * 100 : null;
}

function statisticsMetrics(scope, qps) {
  const requests = scope.requests || {},
    processes = scope.processes || {};
  const latency = scope.latency || {},
    responses = scope.responses;
  const active =
    Number.isFinite(requests.waiting) && Number.isFinite(requests.processing)
      ? requests.waiting + requests.processing
      : null;
  const total = responseTotal(responses);
  return (
    metric("当前 QPS", qps, `累计请求 ${fmt(requests.total)}`, "req/s") +
    metric("等待中", requests.waiting, `活跃请求 ${fmt(active)}`) +
    metric("处理中", requests.processing, `已结束 ${fmt(requests.completed)}`) +
    metric(
      "P95 延迟",
      latency.p95,
      `P50 ${fmt(latency.p50)} / P99 ${fmt(latency.p99)} ms`,
      "ms",
    ) +
    metric(
      "5xx 占比",
      failureRate(responses),
      total === 0
        ? "暂无响应"
        : `${fmt(responses?.["5xx"])} / ${fmt(total)} 个累计响应`,
      "%",
      2,
    ) +
    metric(
      "运行进程",
      processes.running,
      `空闲 ${fmt(processes.idle)} · 启动 ${fmt(processes.starting)} · 退出 ${fmt(processes.stopping)}`,
    )
  );
}

function requestSummary(requests) {
  const fields = [
    ["total", "累计请求"],
    ["waiting", "等待中"],
    ["processing", "处理中"],
    ["completed", "已结束"],
  ];
  return `<div class="section-heading"><h2>请求生命周期</h2><span class="section-note">当前应用实例</span></div><dl class="lifecycle-values">${fields.map(([key, label]) => `<div><dt>${label}</dt><dd data-request="${key}">${fmt(requests?.[key])}</dd></div>`).join("")}</dl>`;
}

function responseSummary(responses) {
  const total = responseTotal(responses);
  return `<div class="section-heading"><h2>响应分布</h2><span class="section-note">累计 ${fmt(total)}</span></div><div class="response-bar" aria-hidden="true">${responseClasses.map((key) => `<span class="http-${key}" data-size="${total > 0 ? (responses[key] / total) * 100 : 0}"></span>`).join("")}</div><dl class="response-values">${responseClasses.map((key) => `<div class="response-${key}"><dt><i class="http-${key}"></i>${key}</dt><dd data-response="${key}">${fmt(responses?.[key])}</dd><small>${total > 0 ? fmt((responses[key] / total) * 100, 2) + "%" : "--"}</small></div>`).join("")}</dl>`;
}

function statisticsLayout(kind, seconds) {
  return `<section id="${kind === "overview" ? "metrics" : "detail-metrics"}" class="metrics"></section><section class="statistics-trends"><div class="section-heading"><h2>统计趋势</h2>${rangeControl(kind, seconds)}</div><div class="metric-charts"><section><div class="section-heading"><h3>请求负载</h3><div class="range" role="group" aria-label="请求趋势指标">${[
    ["qps", "QPS"],
    ["requests", "等待 / 处理"],
  ]
    .map(
      ([mode, label]) =>
        `<button data-action="traffic-mode" data-mode="${mode}" class="${trafficMode === mode ? "active" : ""}" aria-pressed="${trafficMode === mode}">${label}</button>`,
    )
    .join(
      "",
    )}</div></div><div id="traffic-legend" class="legend chart-legend"></div><div class="chart" id="request-chart"></div></section><section><div class="section-heading"><h3>处理延迟</h3><span class="section-note">60 秒窗口 · ms</span></div><div class="legend chart-legend"><span><i></i>P50</span><span><i class="blue"></i>P95</span><span><i class="amber"></i>P99</span></div><div class="chart" id="latency-chart"></div></section></div></section><div class="statistics-breakdown"><section id="request-summary"></section><section id="response-summary"></section></div>`;
}

function renderStatistics(scope, name, seconds) {
  scope ||= {};
  const sampleScope = (sample) => (name ? sample.applications?.[name] : sample);
  const latest = sampleScope(state.samples.at(-1) || {});
  $(name ? "#detail-metrics" : "#metrics").innerHTML = statisticsMetrics(
    scope,
    latest?.qps,
  );
  $("#request-summary").innerHTML = requestSummary(scope.requests);
  $("#response-summary").innerHTML = responseSummary(scope.responses);
  const traffic =
    trafficMode === "qps"
      ? [
          {
            label: "QPS",
            unit: "req/s",
            value: (sample) => sampleScope(sample)?.qps,
          },
        ]
      : [
          {
            label: "等待中",
            unit: "个",
            value: (sample) => sampleScope(sample)?.requests?.waiting,
          },
          {
            label: "处理中",
            unit: "个",
            value: (sample) => sampleScope(sample)?.requests?.processing,
          },
        ];
  $("#traffic-legend").innerHTML = traffic
    .map(
      (item, index) =>
        `<span><i class="${index === 1 ? "blue" : ""}"></i>${item.label}</span>`,
    )
    .join("");
  chart($("#request-chart"), state.samples, traffic, seconds);
  chart(
    $("#latency-chart"),
    state.samples,
    ["p50", "p95", "p99"].map((key) => ({
      label: key.toUpperCase(),
      unit: "ms",
      value: (sample) => sampleScope(sample)?.latency?.[key],
    })),
    seconds,
  );
  chart(
    $("#process-chart"),
    state.samples,
    [
      ["running", "运行"],
      ["idle", "空闲"],
      ["starting", "启动"],
      ["stopping", "退出"],
    ].map(([key, label]) => ({
      label,
      unit: "个",
      value: (sample) => sampleScope(sample)?.processes?.[key],
    })),
    seconds,
  );
  document.querySelectorAll("[data-size]").forEach((element) => {
    element.style.width = element.dataset.size + "%";
  });
}

function rangeControl(kind, value) {
  return `<div class="range" role="group" aria-label="时间范围">${[
    [300, "5 分钟"],
    [900, "15 分钟"],
    [3600, "1 小时"],
  ]
    .map(
      ([seconds, label]) =>
        `<button data-action="range" data-kind="${kind}" data-seconds="${seconds}" class="${value === seconds ? "active" : ""}" aria-pressed="${value === seconds}">${label}</button>`,
    )
    .join("")}</div>`;
}

function tableShell() {
  return `<section class="table-section"><div class="section-heading"><h2>应用<span class="count" id="table-count"></span></h2><div class="tools"><label class="search">${icon("search")}<input id="search" aria-label="搜索应用或监听地址" placeholder="搜索应用或监听地址" value="${esc(search)}"></label><select id="language-filter" aria-label="运行时筛选"><option value="">全部语言</option>${[
    ["python", "Python"],
    ["php", "PHP"],
    ["ruby", "Ruby"],
    ["external", "Go / External"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${filter === value ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></div></div><div class="table-scroll"><table class="application-metrics"><thead><tr><th>应用</th><th>QPS</th><th>等待中</th><th>处理中</th><th>P95 (ms)</th><th>5xx 占比</th><th>进程（运行 / 空闲）</th><th></th></tr></thead><tbody id="app-table-body"></tbody></table></div><div id="table-empty"></div><div class="table-footer"><span id="table-summary"></span><span>采样间隔 2 秒</span></div></section>`;
}

function renderTable() {
  if (!$("#app-table-body")) return;
  const all = Object.entries(state?.config?.applications || {});
  const apps = all.filter(
    ([name, app]) =>
      (!filter || language(app) === filter) &&
      (!search ||
        (name + " " + addresses(app).join(" "))
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  $("#table-count").textContent = all.length;
  $("#table-summary").textContent =
    `显示 ${apps.length} / ${all.length} 个应用`;
  const rows = apps
    .map(([name, app]) => {
      const stats = state.status?.applications?.[name],
        p = stats?.processes || {};
      const addressesList = addresses(app);
      const attrs = `data-name="${esc(name)}"`;
      const path =
        app.path || app.root || app.working_directory || app.executable || "";
      const qps = state.samples.at(-1)?.applications?.[name]?.qps;
      const rate = failureRate(stats?.responses);
      return `<tr data-application="${esc(name)}"><td><a class="app-link" href="#${appRoute(name)}"><span class="app-icon ${esc(language(app))}">${icon(language(app) === "php" ? "globe" : "webhook")}</span><span><strong>${esc(name)}</strong><small title="${esc(path)}">${esc(languageName(app))} ${esc(app.protocol?.toUpperCase() || "")} · ${esc(addressesList[0] || "--")}${addressesList.length > 1 ? ` +${addressesList.length - 1}` : ""}</small></span></a></td><td class="numeric" data-column="qps">${fmt(qps)}</td><td class="numeric" data-column="waiting">${fmt(stats?.requests?.waiting)}</td><td class="numeric" data-column="processing">${fmt(stats?.requests?.processing)}</td><td class="numeric" data-column="p95">${fmt(stats?.latency?.p95)}</td><td class="numeric" data-column="failure-rate">${Number.isFinite(rate) ? fmt(rate, 2) + "%" : "--"}</td><td class="numeric"><div class="process-cell"><span>${fmt(p.running)}<small>/ ${fmt(p.idle)}</small></span>${statusLabel(app, stats)}</div><small class="process-cell-note">启动 ${fmt(p.starting)} · 退出 ${fmt(p.stopping)}</small></td><td><div class="row-actions">${iconButton("edit-app", "编辑应用", "pencil", attrs)}${iconButton("restart", "重启应用", "rotate-cw", attrs)}${iconButton("delete", "删除应用", "trash-2", attrs)}</div></td></tr>`;
    })
    .join("");
  const body = $("#app-table-body");
  if (body.renderedRows !== rows) {
    const focused = body.contains(document.activeElement)
      ? document.activeElement
      : null;
    body.innerHTML = rows;
    body.renderedRows = rows;
    if (focused) {
      [...body.querySelectorAll("a, button")]
        .find(
          (element) =>
            element.dataset.action === focused.dataset.action &&
            element.dataset.name === focused.dataset.name &&
            element.getAttribute("href") === focused.getAttribute("href"),
        )
        ?.focus({ preventScroll: true });
    }
  }
  $("#table-empty").innerHTML = apps.length
    ? ""
    : `<div class="empty">${icon("boxes")}<p>${all.length ? "没有匹配的应用" : state?.connected ? "暂无应用" : "等待 Worker 连接"}</p>${all.length || !state?.connected ? "" : button("new-app", "新建应用", "plus", true)}</div>`;
}

function addresses(app) {
  return app.targets
    ? Object.values(app.targets)
        .map((target) => target.listen)
        .filter(Boolean)
    : app.listen
      ? [app.listen]
      : [];
}

function changeRows(items) {
  if (!items.length) return '<div class="empty">暂无后台变更记录</div>';
  return items
    .map(
      (item) =>
        `<div class="change"><span class="change-symbol">${icon(item.operation === "restart" ? "rotate-cw" : "sliders-horizontal")}</span><div class="change-main"><strong>${esc(item.name || "Worker")}</strong> ${operations[item.operation] || esc(item.operation)}<small>${results[item.result] || esc(item.result)}${item.error ? " · " + esc(item.error.message) : ""}</small></div><time>${stamp(item.time)}</time><button class="text-button" data-action="record" data-id="${esc(item.id)}">查看${icon("arrow-right")}</button></div>`,
    )
    .join("");
}

function updateLive() {
  if (!state || !authenticated) return;
  $("#instance").textContent = state.instance;
  $("#app-count").textContent = Object.keys(
    state.config?.applications || {},
  ).length;
  const label = state.connected
    ? '<span class="status">已连接</span>'
    : '<span class="status red">连接中断</span>';
  $("#connection").innerHTML = label;
  $("#sidebar-status").innerHTML = label;
  $("#updated").textContent = "最后采样 " + clock(state.last_success);
  $("#connection-error").hidden = state.connected;
  $("#connection-error").textContent =
    `无法获取 Worker 最新数据。最后成功采样：${clock(state.last_success)}。${state.error || ""}`;
  $("#content").classList.toggle("stale", !state.connected);
  renderTable();
  const parts = routeParts();
  if (parts[0] === "overview" && $("#metrics")) {
    renderStatistics(state.status, null, range);
    if ($("#recent-changes"))
      $("#recent-changes").innerHTML = changeRows(records.slice(0, 3));
  }
  if (
    parts[0] === "apps" &&
    parts[1] &&
    parts[2] === "runtime" &&
    $("#detail-metrics")
  ) {
    const name = parts[1],
      config = state.config.applications?.[name];
    const stats = state.status?.applications?.[name];
    renderStatistics(stats, name, detailRange);
    $("#app-state").innerHTML = config
      ? statusLabel(config, stats)
      : '<span class="status gray">应用已删除</span>';
  }
}

async function refresh() {
  if (loading || !authenticated) return;
  loading = true;
  try {
    const next = await api("state");
    if (!authenticated) return;
    state = next;
    if (Date.now() - lastHistory > 6000) {
      records = await api("history");
      lastHistory = Date.now();
    }
    updateLive();
    if (routeParts()[0] === "history" && $("#history-list"))
      $("#history-list").innerHTML = changeRows(records);
  } catch (error) {
    if (state) {
      state.connected = false;
      state.error = error.message;
      updateLive();
    } else if (authenticated) {
      $("#connection-error").hidden = false;
      $("#connection-error").textContent = error.message;
    }
  } finally {
    loading = false;
  }
}

async function poll() {
  clearTimeout(timer);
  await refresh();
  if (authenticated) timer = setTimeout(poll, document.hidden ? 10000 : 2000);
}

function overview() {
  const count = Object.keys(state?.config?.applications || {}).length;
  const listens = Object.values(state?.config?.applications || {}).flatMap(
    addresses,
  ).length;
  $("#content").innerHTML =
    heading(
      "运行总览",
      `${state?.instance || "Worker"} / ${count} 个应用 / ${listens} 个监听地址`,
      button("config", "查看配置", "code-2") +
        button("new-app", "新建应用", "plus", true),
    ) +
    statisticsLayout("overview", range) +
    tableShell() +
    '<section class="changes"><div class="section-heading"><h2>最近变更</h2><a class="text-button" href="#/history">全部记录' +
    icon("arrow-right") +
    '</a></div><div id="recent-changes" class="change-list"></div></section>';
}

function appHeader(name, tab, app) {
  return (
    heading(
      name,
      languageName(app) + " / " + addresses(app).join(" · "),
      `<span id="app-state">${statusLabel(app, state?.status?.applications?.[name])}</span>` +
        button(
          "restart",
          "重启应用",
          "rotate-cw",
          false,
          `data-name="${esc(name)}"`,
        ),
    ) +
    `<div class="tabs" role="navigation" aria-label="应用详情">${[["runtime", "运行情况"], ["settings", "应用配置"], ["processes", "进程配置"], ...(["python", "php"].includes(language(app)) ? [["targets", "Targets"]] : []), ["json", "JSON"]].map(([id, label]) => `<a href="#${appRoute(name, id)}" class="${tab === id ? "active" : ""}">${label}</a>`).join("")}</div>`
  );
}

function runtimePage(name, app) {
  return (
    statisticsLayout("detail", detailRange) +
    `<section class="process-history"><div class="section-heading"><h2>进程趋势</h2><span class="legend"><span><i></i>运行</span><span><i class="blue"></i>空闲</span><span><i class="amber"></i>启动</span><span><i class="red"></i>退出</span></span></div><div class="chart" id="process-chart"></div></section><section class="detail-metadata"><div class="section-heading"><h2>当前配置</h2><a class="text-button" href="#${appRoute(name, "settings")}">编辑${icon("arrow-right")}</a></div><dl class="metadata"><div><dt>监听地址</dt><dd>${addresses(app).map(esc).join("<br>") || "--"}</dd></div><div><dt>入口</dt><dd>${esc(app.module || app.script || app.executable || (app.targets ? Object.keys(app.targets).join(", ") : "--"))}</dd></div><div><dt>进程策略</dt><dd>${app.processes === undefined ? "默认" : typeof app.processes === "number" ? `固定 ${app.processes} 个` : `按需 · spare ${app.processes.spare ?? "默认"} / max ${app.processes.max ?? "默认"}`}</dd></div></dl></section>`
  );
}

function field(label, name, value = "", type = "text", extra = "") {
  return `<label>${esc(label)}<input name="${name}" value="${esc(value)}" type="${type}" ${extra}></label>`;
}

function footer() {
  return `<p id="form-error" class="error-text" role="alert"></p><div class="form-footer"><span class="draft-label" id="draft-label">与当前配置一致</span>${button("reload-editor", "重新载入", "refresh-cw")}${button("preview", "查看差异并应用", "check", true)}</div>`;
}

function languageFields(app) {
  const lang = language(app);
  if (lang === "python")
    return `<div class="form-grid">${field("应用路径 · path", "path", Array.isArray(app.path) ? json(app.path) : app.path || "")}<label>协议 · protocol<select name="protocol"><option value="">默认</option><option value="wsgi" ${app.protocol === "wsgi" ? "selected" : ""}>WSGI</option><option value="asgi" ${app.protocol === "asgi" ? "selected" : ""}>ASGI</option></select></label>${field("虚拟环境 · home", "home", app.home || "")}</div>`;
  return "";
}

function entryKeys(lang) {
  return [
    "listen",
    ...({
      python: ["module", "callable", "factory"],
      php: ["root", "script", "index"],
      ruby: ["script", "hooks"],
      external: ["executable", "arguments"],
    }[lang] || []),
  ];
}

function entryValue(app, lang) {
  return Object.fromEntries(
    entryKeys(lang)
      .filter((key) => Object.hasOwn(app, key))
      .map((key) => [key, clone(app[key])]),
  );
}

function entryValueFields(app, lang) {
  const listen = field(
    "监听地址 · listen",
    "listen",
    app.listen || "",
    "text",
    "required",
  );
  const python = () =>
    field("模块 · module", "module", app.module || "", "text", "required") +
    field("可调用对象 · callable", "callable", app.callable || "") +
    `<label class="checkbox"><input name="factory" type="checkbox" ${app.factory ? "checked" : ""}>应用工厂 · factory</label>`;
  const php = () =>
    field("应用根目录 · root", "root", app.root || "", "text", "required") +
    field("入口脚本 · script", "script", app.script || "") +
    field("索引文件 · index", "index", app.index || "");
  const ruby = () =>
    field(
      "Rack 脚本 · script",
      "script",
      app.script || "",
      "text",
      "required",
    ) + field("Hooks 文件 · hooks", "hooks", app.hooks || "");
  const external = () =>
    field(
      "可执行文件 · executable",
      "executable",
      app.executable || "",
      "text",
      "required",
    ) +
    field(
      "启动参数 · arguments (JSON)",
      "arguments",
      app.arguments ? json(app.arguments) : "",
    );
  return listen + ({ python, php, ruby, external }[lang]?.() || "");
}

function languageSection(app) {
  const fields = languageFields(app);
  return `<section class="form-section" id="language-fields" ${fields ? "" : "hidden"}><h3>运行环境</h3>${fields}</section>`;
}

function entriesSection(app) {
  const lang = language(app),
    multiple = !!app.targets;
  const supportsTargets = ["python", "php"].includes(lang);
  const targets = Object.entries(app.targets || {});
  const single = multiple ? targets[0]?.[1] || {} : entryValue(app, lang);
  return `<section id="entry-section" class="form-section"><h3>应用入口</h3>${
    supportsTargets
      ? `<div class="process-mode" role="radiogroup" aria-label="入口模式">${[
          ["single", "单入口"],
          ["targets", "多入口（Targets）"],
        ]
          .map(
            ([mode, label]) =>
              `<label><input type="radio" name="entry_mode" value="${mode}" ${multiple === (mode === "targets") ? "checked" : ""}><span>${label}</span></label>`,
          )
          .join("")}</div>`
      : ""
  }<fieldset id="single-entry" ${multiple ? "hidden disabled" : ""}><label id="retained-target-label" class="retained-target" hidden>保留入口<select name="retained_target"></select></label><div id="single-entry-fields" class="form-grid">${entryValueFields(single, lang)}</div></fieldset>${supportsTargets ? `<fieldset id="multi-entry" ${multiple ? "" : "hidden disabled"}><div class="section-heading"><h3>Targets</h3>${button("add-target", "添加 Target", "plus")}</div><div id="target-rows">${targets.map(([name, target]) => targetRow(name, target, lang)).join("")}</div></fieldset>` : ""}</section>`;
}

function initializeEntries(app) {
  const section = $("#entry-section");
  if (!section || section.entryState) return;
  const lang = language(app),
    rows = [...section.querySelectorAll(".target")];
  section.entryState = {
    lang,
    mode: app.targets ? "targets" : "single",
    initialized: !!app.targets,
    source: null,
  };
  rows.forEach((row) => {
    row.entryBase = clone(app.targets[row.dataset.originalName]);
  });
  $("#single-entry").entryBase = app.targets
    ? clone(Object.values(app.targets)[0] || {})
    : entryValue(app, lang);
}

function readEntry(container) {
  const result = clone(container.entryBase || {});
  container.querySelectorAll("input[name]").forEach((input) => {
    if (input.name === "target_name") return;
    if (input.type === "checkbox") {
      if (input.checked || Object.hasOwn(result, input.name))
        result[input.name] = input.checked;
    } else if (input.name === "arguments") {
      setOptional(
        result,
        input.name,
        input.value.trim() ? JSON.parse(input.value) : "",
      );
    } else setOptional(result, input.name, input.value);
  });
  return result;
}

function writeEntry(container, value) {
  container.entryBase = clone(value);
  container.querySelectorAll("input[name]").forEach((input) => {
    if (input.name === "target_name") return;
    if (input.type === "checkbox") input.checked = !!value[input.name];
    else
      input.value =
        input.name === "arguments" && value.arguments
          ? json(value.arguments)
          : (value[input.name] ?? "");
  });
}

function appendTarget(name, value) {
  const container = $("#target-rows"),
    lang = $("#entry-section").entryState.lang;
  container.insertAdjacentHTML("beforeend", targetRow(name, value, lang));
  const row = container.lastElementChild;
  row.entryBase = clone(value);
  return row;
}

function retainTarget(row) {
  const settings = $("#entry-section").entryState;
  if (settings.source?.isConnected && settings.mode === "single")
    writeEntry(settings.source, readEntry($("#single-entry")));
  settings.source = row;
  const value = readEntry(row);
  $("#single-entry-fields").innerHTML = entryValueFields(value, settings.lang);
  $("#single-entry").entryBase = clone(value);
}

function setEntryMode(mode) {
  const settings = $("#entry-section").entryState;
  if (settings.mode === mode) return;
  if (mode === "targets") {
    if (!settings.initialized) {
      settings.source = appendTarget("default", readEntry($("#single-entry")));
      settings.initialized = true;
    } else if (settings.source?.isConnected)
      writeEntry(settings.source, readEntry($("#single-entry")));
  } else {
    const rows = $$("#target-rows .target");
    const index = Math.max(0, rows.indexOf(settings.source));
    $("[name=retained_target]").innerHTML = rows
      .map(
        (row, i) =>
          `<option value="${i}" ${i === index ? "selected" : ""}>${esc(row.querySelector("[name=target_name]").value || `Target ${i + 1}`)}</option>`,
      )
      .join("");
    $("#retained-target-label").hidden = rows.length < 2;
    retainTarget(rows[index]);
  }
  settings.mode = mode;
  $("#single-entry").hidden = $("#single-entry").disabled = mode !== "single";
  $("#multi-entry").hidden = $("#multi-entry").disabled = mode !== "targets";
  markDirty();
}

function gatherEntries(value) {
  const settings = $("#entry-section").entryState;
  for (const key of entryKeys(settings.lang)) delete value[key];
  if (settings.mode === "single") {
    delete value.targets;
    Object.assign(value, readEntry($("#single-entry")));
  } else {
    const rows = $$("#target-rows .target"),
      targets = Object.create(null),
      listens = new Set();
    if (!rows.length) throw new Error("至少需要一个 Target。");
    for (const row of rows) {
      const name = row.querySelector("[name=target_name]").value.trim();
      if (!name || Object.hasOwn(targets, name))
        throw new Error("Target 名称不能为空或重复。");
      const target = readEntry(row);
      if (!target.listen?.trim()) throw new Error("Target 监听地址不能为空。");
      if (listens.has(target.listen))
        throw new Error("Target 监听地址不能重复。");
      listens.add(target.listen);
      targets[name] = target;
    }
    value.targets = targets;
  }
  return value;
}

function switchRuntime(lang) {
  const current = $("#entry-section");
  editor.runtimeForms ||= new Map();
  editor.runtimeForms.set(current.entryState.lang, {
    entries: current,
    shared: $("#language-fields"),
  });
  const saved = editor.runtimeForms.get(lang);
  if (saved) {
    $("#language-fields").replaceWith(saved.shared);
    current.replaceWith(saved.entries);
  } else {
    $("#language-fields").outerHTML = languageSection({ type: lang });
    current.outerHTML = entriesSection({ type: lang });
    initializeEntries({ type: lang });
  }
  markDirty();
}

function envRow(key = "", value = "") {
  return `<div class="env-row"><input data-env="key" value="${esc(key)}" aria-label="环境变量名称" placeholder="变量名"><input data-env="value" type="password" value="${esc(value)}" aria-label="环境变量值" autocomplete="off" placeholder="值">${iconButton("toggle-secret", "显示或隐藏值", "eye")}${iconButton("remove-row", "移除环境变量", "trash-2")}</div>`;
}

function settingsForm(app, creating = false) {
  const lang = language(app) || "python";
  return `<form id="editor"><section class="form-section"><h3>基本信息</h3><div class="form-grid">${field("应用名称", "name", editor.name || "", "text", creating ? 'required maxlength="256"' : "readonly")}<label>运行时<select name="type" ${creating ? "" : "disabled"}>${[
    ["python", "Python"],
    ["php", "PHP"],
    ["ruby", "Ruby"],
    ["external", "Go / External"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${lang === value ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></label></div></section>${entriesSection({ ...app, type: lang })}${languageSection({ ...app, type: lang })}<section class="form-section"><h3>运行设置</h3><div class="form-grid">${field("工作目录 · working_directory", "working_directory", app.working_directory || "")}${field("运行用户 · user", "user", app.user || "")}${field("运行组 · group", "group", app.group || "")}</div></section><section class="form-section"><div class="section-heading"><h3>环境变量</h3>${button("add-env", "添加变量", "plus")}</div><div id="env-rows">${Object.entries(
    app.environment || {},
  )
    .map(([key, value]) => envRow(key, value))
    .join("")}</div></section>${footer()}</form>`;
}

function processesForm(app) {
  const p = app.processes,
    mode =
      p === undefined ? "default" : typeof p === "number" ? "fixed" : "dynamic";
  return `<form id="editor"><section class="form-section"><h3>进程策略</h3><div class="process-mode">${[
    ["default", "默认"],
    ["fixed", "固定"],
    ["dynamic", "按需"],
  ]
    .map(
      ([value, label]) =>
        `<label><input type="radio" name="mode" value="${value}" ${mode === value ? "checked" : ""}><span>${label}</span></label>`,
    )
    .join(
      "",
    )}</div><div id="fixed-fields" class="form-grid" ${mode !== "fixed" ? "hidden" : ""}>${field("进程数", "fixed", typeof p === "number" ? p : 1, "number", 'min="1" step="1"')}</div><div id="dynamic-fields" class="form-grid" ${mode !== "dynamic" ? "hidden" : ""}>${field("预备进程 · spare", "spare", p?.spare ?? "", "number", 'min="0" step="1" placeholder="默认"')}${field("最大进程 · max", "max", p?.max ?? "", "number", 'min="1" step="1" placeholder="默认"')}${field("空闲超时 · idle_timeout (秒)", "idle_timeout", p?.idle_timeout ?? "", "number", 'min="0" step="1" placeholder="默认"')}</div></section>${footer()}</form>`;
}

function targetRow(name, target, lang) {
  return `<section class="target" data-original-name="${esc(name)}"><div class="section-heading"><h3>Target</h3>${iconButton("remove-target", "删除 Target", "trash-2")}</div><div class="form-grid">${field("名称", "target_name", name, "text", "required")}${entryValueFields(target, lang)}</div></section>`;
}

function targetsForm(app) {
  return `<form id="editor">${entriesSection(app)}${footer()}</form>`;
}

function jsonForm(value) {
  return `<form id="editor"><div class="editor-tools">${button("format-json", "格式化", "code-2")}${iconButton("import-json", "导入 JSON", "upload")}${iconButton("export-json", "导出 JSON", "download")}<input id="import-file" type="file" accept=".json,application/json" hidden></div><textarea name="json" class="json-editor" spellcheck="false" aria-label="JSON 配置">${esc(json(value))}</textarea>${footer()}</form>`;
}

const httpFields = [
  ["header_read_timeout", "请求头读取超时 (秒)"],
  ["body_read_timeout", "请求体读取超时 (秒)"],
  ["send_timeout", "响应发送超时 (秒)"],
  ["idle_timeout", "连接空闲超时 (秒)"],
  ["body_buffer_size", "请求体缓冲区 (字节)"],
  ["max_body_size", "最大请求体 (字节)"],
];
function httpForm(config) {
  const http = config.settings?.http || {};
  return `<form id="editor"><section class="form-section"><h3>HTTP</h3><div class="form-grid">${httpFields.map(([name, label]) => field(label, name, http[name] ?? "", "number", 'min="0" step="1" placeholder="默认"')).join("")}${field("请求体临时目录", "body_temp_path", http.body_temp_path || "")}<label>过滤不安全字段<select name="discard_unsafe_fields"><option value="">默认</option><option value="true" ${http.discard_unsafe_fields === true ? "selected" : ""}>启用</option><option value="false" ${http.discard_unsafe_fields === false ? "selected" : ""}>禁用</option></select></label></div></section>${footer()}</form>`;
}

async function renderRoute() {
  if (!authenticated) return;
  const generation = ++routeGeneration;
  route = getRoute();
  editor = null;
  dirty = false;
  const parts = routeParts();
  const section = ["overview", "apps", "config", "history"].includes(parts[0])
    ? parts[0]
    : "overview";
  document
    .querySelectorAll("[data-nav]")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.nav === section),
    );
  $("#breadcrumb").textContent =
    "工作空间 / " +
    { overview: "总览", apps: "应用", config: "配置", history: "变更记录" }[
      section
    ] +
    (parts[1] && section === "apps" ? " / " + parts[1] : "");
  try {
    if (section === "overview") overview();
    else if (section === "apps" && !parts[1])
      $("#content").innerHTML =
        heading(
          "应用",
          `${Object.keys(state?.config?.applications || {}).length} 个应用`,
          button("new-app", "新建应用", "plus", true),
        ) + tableShell();
    else if (section === "history")
      $("#content").innerHTML =
        heading("变更记录", "最近 100 条后台操作") +
        `<div class="change-list" id="history-list">${changeRows(records)}</div>`;
    else {
      $("#content").innerHTML = '<div class="empty">正在读取配置…</div>';
      const current = await api("config");
      if (generation !== routeGeneration) return;
      if (state) state.config = current.config;
      if (section === "config") {
        const tab = parts[1] === "json" ? "json" : "http";
        editor = {
          kind: "configuration",
          tab,
          original: clone(current.config),
          revision: current.revision,
        };
        const source =
          state?.config_source === "state"
            ? "持久化状态配置"
            : `启动配置文件：${state?.config_source}`;
        $("#content").innerHTML =
          heading("配置", source) +
          (state?.config_source !== "state"
            ? '<div class="notice">Worker 使用启动配置文件。下次启动会重新应用该文件中的配置。</div>'
            : "") +
          `<div class="tabs"><a href="#/config/http" class="${tab === "http" ? "active" : ""}">HTTP 设置</a><a href="#/config/json" class="${tab === "json" ? "active" : ""}">完整 JSON</a></div>` +
          (tab === "json"
            ? jsonForm(current.config)
            : httpForm(current.config));
      } else if (parts[1] === "new" && parts.length === 2) {
        editor = {
          kind: "application",
          tab: "settings",
          original: { type: "python" },
          revision: current.revision,
          name: "",
          creating: true,
        };
        $("#content").innerHTML =
          heading("新建应用", "") + settingsForm(editor.original, true);
      } else {
        const name = parts[1],
          app = current.config.applications?.[name];
        if (!app) {
          $("#content").innerHTML =
            heading("应用不存在", name) +
            '<a class="text-button" href="#/apps">返回应用列表</a>';
          return;
        }
        const tab = [
          "runtime",
          "settings",
          "processes",
          "targets",
          "json",
        ].includes(parts[2])
          ? parts[2]
          : "runtime";
        if (parts[2] !== tab) {
          go(appRoute(name, tab));
          return;
        }
        editor = {
          kind: "application",
          tab,
          original: clone(app),
          revision: current.revision,
          name,
          creating: false,
        };
        const body =
          tab === "runtime"
            ? runtimePage(name, app)
            : tab === "settings"
              ? settingsForm(app)
              : tab === "processes"
                ? processesForm(app)
                : tab === "targets"
                  ? targetsForm(app)
                  : jsonForm(app);
        $("#content").innerHTML = appHeader(name, tab, app) + body;
      }
    }
    if (editor?.kind === "application" && $("#entry-section"))
      initializeEntries(editor.original);
    updateLive();
  } catch (error) {
    if (generation === routeGeneration)
      $("#content").innerHTML =
        heading("无法读取配置") +
        `<p class="error-text">${esc(error.message)}</p>` +
        button("reload-editor", "重试", "refresh-cw");
  }
}

function markDirty() {
  dirty = true;
  $("#toast").hidden = true;
  if ($("#form-error")) $("#form-error").textContent = "";
  if ($("#draft-label")) $("#draft-label").textContent = "有未提交的修改";
}

function setOptional(target, key, value) {
  if (value === "" || value === undefined) delete target[key];
  else target[key] = value;
}

function parseObject(source) {
  const value = JSON.parse(source);
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("配置必须是 JSON 对象。");
  return value;
}

function integer(value, label) {
  const number = Number(value);
  if (value === "" || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} 必须是非负整数。`);
  return number;
}

function gather() {
  const form = $("#editor");
  if (!form.reportValidity()) throw new Error("请检查必填项和数值范围。");
  const data = new FormData(form),
    value = clone(editor.original);
  if (editor.tab === "json") return parseObject(data.get("json"));
  if (editor.kind === "configuration") {
    const http = clone(value.settings?.http || {});
    httpFields.forEach(([key, label]) =>
      setOptional(
        http,
        key,
        data.get(key) === "" ? "" : integer(data.get(key), label),
      ),
    );
    setOptional(http, "body_temp_path", data.get("body_temp_path"));
    setOptional(
      http,
      "discard_unsafe_fields",
      data.get("discard_unsafe_fields") === ""
        ? ""
        : data.get("discard_unsafe_fields") === "true",
    );
    value.settings = { ...value.settings, http };
    return value;
  }
  if (editor.tab === "processes") {
    const mode = data.get("mode");
    if (mode === "default") delete value.processes;
    else if (mode === "fixed") {
      value.processes = integer(data.get("fixed"), "进程数");
      if (value.processes < 1) throw new Error("固定进程数至少为 1。");
    } else {
      value.processes = {};
      for (const key of ["spare", "max", "idle_timeout"])
        if (data.get(key) !== "")
          value.processes[key] = integer(data.get(key), key);
      if (
        value.processes.max !== undefined &&
        value.processes.spare > value.processes.max
      )
        throw new Error("spare 不能大于 max。");
    }
    return value;
  }
  if (editor.tab === "targets") {
    return gatherEntries(value);
  }
  if (editor.creating) {
    editor.name = data.get("name").trim();
    value.type = data.get("type");
  }
  ["working_directory", "user", "group", "home", "protocol"].forEach((key) => {
    if (data.has(key)) setOptional(value, key, data.get(key));
  });
  if (data.has("path")) {
    const path = data.get("path").trim();
    setOptional(value, "path", path.startsWith("[") ? JSON.parse(path) : path);
  }
  const environment = Object.create(null);
  document.querySelectorAll(".env-row").forEach((row) => {
    const key = row.querySelector("[data-env=key]").value;
    if (!key || Object.hasOwn(environment, key))
      throw new Error("环境变量名称不能为空或重复。");
    environment[key] = row.querySelector("[data-env=value]").value;
  });
  if (Object.keys(environment).length) value.environment = environment;
  else delete value.environment;
  return gatherEntries(value);
}

function differences(before, after, path = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) => differences(before[key], after[key], path + "/" + key));
  }
  return [{ path: path || "/", before, after }];
}

function diffHTML(diff, reveal = false) {
  return `<div class="diff">${
    diff
      .map((item) => {
        const secret =
          !reveal && /environment|password|secret|token/i.test(item.path);
        const render = (value) =>
          value === undefined ? "(无)" : secret ? "••••••••" : json(value);
        return `<div class="diff-row"><div class="diff-path">${esc(item.path)}</div><div class="diff-values"><pre class="diff-before">${esc(render(item.before))}</pre><pre class="diff-after">${esc(render(item.after))}</pre></div></div>`;
      })
      .join("") || '<div class="empty">配置没有变化</div>'
  }</div>`;
}

function dialog(title, body, actions) {
  $("#dialog-title").textContent = title;
  $("#dialog-body").innerHTML = body;
  $("#dialog-actions").innerHTML = actions;
  $("#dialog-error").textContent = "";
  if (!$("#dialog").open) $("#dialog").showModal();
}

function stage(operation, body, before, after, redirect) {
  const diff = differences(before, after);
  if (!diff.length && operation !== "restart") {
    toast("配置没有变化");
    return;
  }
  pending = { operation, body, diff, redirect };
  historyRecord = null;
  const title =
    operation === "restart"
      ? "重启应用"
      : operation === "delete"
        ? "删除应用"
        : "确认配置变更";
  dialog(
    title,
    `<p>${esc(body.name || "Worker")}</p>${operation === "restart" ? '<p class="muted">重新启动应用进程。</p>' : '<label class="checkbox"><input id="reveal-diff" type="checkbox">显示敏感值</label>' + `<div id="diff-content">${diffHTML(diff)}</div>`}`,
    button("close-dialog", "取消", "") +
      button(
        "apply",
        operation === "restart"
          ? "确认重启"
          : operation === "delete"
            ? "确认删除"
            : "应用配置",
        "check",
        true,
      ),
  );
}

async function applyChange() {
  if (!pending) return;
  const item = pending,
    buttons = [...$("#dialog").querySelectorAll("button")];
  buttons.forEach((button) => (button.disabled = true));
  try {
    const result = await api("change/" + item.operation, item.body);
    dirty = false;
    if (state) {
      state.config = result.config;
      state.revision = result.revision;
    }
    $("#dialog").close();
    pending = null;
    lastHistory = 0;
    toast(
      result.result === "changed"
        ? "操作后配置再次发生变化，请核对当前配置。"
        : item.operation === "restart"
          ? "重启请求已接受"
          : "配置已应用",
    );
    if (item.redirect) go(item.redirect);
    else await renderRoute();
    await refresh();
  } catch (error) {
    $("#dialog-error").textContent = error.message;
    lastHistory = 0;
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}

async function preview() {
  try {
    $("#form-error").textContent = "";
    const value = gather();
    const body = { revision: editor.revision, value };
    if (editor.kind === "application")
      Object.assign(body, { name: editor.name, create: !!editor.creating });
    stage(
      editor.kind,
      body,
      editor.creating ? undefined : editor.original,
      value,
      editor.creating ? appRoute(editor.name) : null,
    );
  } catch (error) {
    $("#form-error").textContent = error.message;
  }
}

async function appOperation(operation, name) {
  if (!canLeave()) return;
  const current = await api("config"),
    app = current.config.applications?.[name];
  if (!app) throw new Error("应用不存在。");
  stage(
    operation,
    { name, revision: current.revision },
    app,
    operation === "delete" ? undefined : app,
    operation === "delete" ? "/apps" : null,
  );
}

async function viewRecord(id) {
  const item = await api("history/" + id);
  historyRecord = item;
  pending = null;
  const diff = differences(item.before, item.after);
  dialog(
    operations[item.operation] || item.operation,
    `<p>${esc(item.name || "Worker")} · ${stamp(item.time)} · ${results[item.result] || esc(item.result)}</p>${item.error ? `<p class="error-text">${esc(json(item.error))}</p>` : ""}<label class="checkbox"><input id="reveal-diff" type="checkbox">显示敏感值</label><div id="diff-content">${diffHTML(diff)}</div>`,
    button("close-dialog", "关闭", "") +
      (item.operation !== "restart" && item.result !== "failed"
        ? button("restore", "恢复变更前配置", "history")
        : ""),
  );
}

const actions = {
  refresh: async () => {
    lastHistory = 0;
    await refresh();
  },
  logout: async () => {
    if (!canLeave()) return;
    await api("logout", {});
    dirty = false;
    showLogin();
  },
  config: () => go("/config/json"),
  "new-app": () => go("/apps/new"),
  "edit-app": (element) => go(appRoute(element.dataset.name, "settings")),
  restart: (element) => appOperation("restart", element.dataset.name),
  delete: (element) => appOperation("delete", element.dataset.name),
  "reload-editor": () => {
    if (canLeave()) renderRoute();
  },
  preview,
  apply: applyChange,
  "close-dialog": () => {
    $("#dialog").close();
    pending = null;
    historyRecord = null;
  },
  range: (element) => {
    if (element.dataset.kind === "overview")
      range = Number(element.dataset.seconds);
    else detailRange = Number(element.dataset.seconds);
    element.parentElement.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button === element);
      button.setAttribute("aria-pressed", String(button === element));
    });
    updateLive();
  },
  "traffic-mode": (element) => {
    trafficMode = element.dataset.mode;
    element.parentElement.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button === element);
      button.setAttribute("aria-pressed", String(button === element));
    });
    updateLive();
  },
  "add-env": () => {
    $("#env-rows").insertAdjacentHTML("beforeend", envRow());
    markDirty();
  },
  "remove-row": (element) => {
    element.closest(".env-row").remove();
    markDirty();
  },
  "toggle-secret": (element) => {
    const input = element.closest(".env-row").querySelector("[data-env=value]");
    input.type = input.type === "password" ? "text" : "password";
    element.innerHTML = icon(input.type === "password" ? "eye" : "eye-off");
  },
  "format-json": () => {
    const input = $("[name=json]");
    input.value = json(JSON.parse(input.value));
    markDirty();
  },
  "import-json": () => $("#import-file").click(),
  "export-json": () => {
    const value =
      $("[name=json]")?.value || json(editor?.original || state.config);
    JSON.parse(value);
    const url = URL.createObjectURL(
      new Blob([value], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = editor?.name ? editor.name + ".json" : "worker-config.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  "add-target": () => {
    appendTarget("", {}).querySelector("input").focus();
    markDirty();
  },
  "remove-target": (element) => {
    if ($$(".target").length <= 1)
      throw new Error("至少保留一个 Target；也可以改为单入口。");
    element.closest(".target").remove();
    markDirty();
  },
  record: (element) => viewRecord(element.dataset.id),
  restore: async () => {
    const saved = historyRecord,
      current = await api("config");
    stage(
      "restore",
      { id: saved.id, revision: current.revision },
      current.config,
      saved.before,
      "/history",
    );
  },
};

function $$(selector) {
  return [...document.querySelectorAll(selector)];
}

document.addEventListener("click", async (event) => {
  const link = event.target.closest('a[href^="#/"]');
  if (link) {
    event.preventDefault();
    go(link.getAttribute("href").slice(1));
    return;
  }
  const element = event.target.closest("[data-action]");
  if (!element || element.disabled) return;
  event.preventDefault();
  try {
    await actions[element.dataset.action]?.(element);
  } catch (error) {
    if ($("#dialog").open) $("#dialog-error").textContent = error.message;
    else toast(error.message);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    search = event.target.value;
    renderTable();
  } else if (event.target.closest("#editor")) markDirty();
});

document.addEventListener("change", async (event) => {
  const input = event.target;
  try {
    if (input.id === "language-filter") {
      filter = input.value;
      renderTable();
    }
    if (input.name === "mode") {
      $("#fixed-fields").hidden = input.value !== "fixed";
      $("#dynamic-fields").hidden = input.value !== "dynamic";
      markDirty();
    }
    if (input.name === "type" && editor?.creating) {
      switchRuntime(input.value);
    }
    if (input.name === "entry_mode") {
      setEntryMode(input.value);
    }
    if (input.name === "retained_target") {
      retainTarget($$("#target-rows .target")[Number(input.value)]);
      markDirty();
    }
    if (input.id === "reveal-diff") {
      const diff =
        pending?.diff || differences(historyRecord.before, historyRecord.after);
      $("#diff-content").innerHTML = diffHTML(diff, input.checked);
    }
    if (input.id === "import-file" && input.files[0]) {
      if (input.files[0].size > 2 * 1024 * 1024)
        throw new Error("配置文件不能超过 2 MiB。");
      const value = parseObject(await input.files[0].text());
      $("[name=json]").value = json(value);
      markDirty();
      input.value = "";
    }
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "editor") {
    await preview();
    return;
  }
  if (event.target.id !== "login-form") return;
  const button = $("#login-form button");
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    await api("login", {
      password: new FormData(event.target).get("password"),
    });
    event.target.reset();
    await enter();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("hashchange", () => {
  if (getRoute() === route) return;
  if (!canLeave()) {
    history.replaceState(null, "", "#" + route);
    return;
  }
  renderRoute();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("resize", updateLive);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && authenticated) poll();
});
$("#dialog").addEventListener("cancel", (event) => {
  if ($("#dialog [data-action=apply]")?.disabled) event.preventDefault();
});

async function enter() {
  authenticated = true;
  $("#login").hidden = true;
  $("#app").hidden = false;
  await refresh();
  await renderRoute();
  poll();
}

async function initialize() {
  try {
    const session = await api("session");
    $("#login-instance").textContent = session.instance;
    if (session.authenticated) await enter();
    else showLogin();
  } catch (error) {
    showLogin();
    $("#login-error").textContent = error.message;
  }
}

initialize();
