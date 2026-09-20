const colors = ["#32815d", "#4885aa", "#b99037", "#ab6b64"];

export function chart(container, samples, series, seconds) {
  if (!container) return;
  const end = samples.at(-1)?.time ?? Date.now() / 1000;
  const start = end - seconds;
  const points = samples.filter(
    (sample) => sample.time >= start && sample.time <= end,
  );
  let canvas = container.querySelector("canvas");
  if (!canvas) {
    container.replaceChildren();
    canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      series.map((item) => item.label).join("、"),
    );
    container.append(canvas);
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    container.append(tooltip);
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    container.append(empty);
  }
  const ratio = devicePixelRatio || 1;
  canvas.setAttribute(
    "aria-label",
    series.map((item) => item.label).join("、"),
  );
  const width = container.clientWidth,
    height = container.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const left = 39,
    right = width - 10,
    top = 12,
    bottom = height - 26;
  const values = points
    .flatMap((sample) => series.map((item) => item.value(sample)))
    .filter(Number.isFinite);
  const maximum = Math.max(4, ...values);
  const step = 10 ** Math.floor(Math.log10(maximum));
  const max = Math.ceil(maximum / step) * step;
  ctx.font = "10px system-ui,sans-serif";
  for (let n = 0; n <= 4; n++) {
    const y = bottom - (n / 4) * (bottom - top);
    ctx.strokeStyle = "#eaf0ea";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = "#7e8b81";
    const label = (n * max) / 4;
    ctx.fillText(
      label >= 1000
        ? (label / 1000).toFixed(1) + "k"
        : Number(label.toFixed(1)),
      0,
      y + 3,
    );
  }
  ctx.textAlign = "center";
  for (let n = 0; n <= 4; n++) {
    ctx.textAlign = n === 0 ? "left" : n === 4 ? "right" : "center";
    const date = new Date((start + (n / 4) * seconds) * 1000);
    ctx.fillText(
      date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      left + (n / 4) * (right - left),
      height - 4,
    );
  }
  const xFor = (time) => left + ((time - start) / seconds) * (right - left);
  series.forEach((item, index) => {
    ctx.strokeStyle = colors[index % colors.length];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.9;
    ctx.lineJoin = "round";
    let last = null;
    for (const sample of points) {
      const value = item.value(sample);
      if (!Number.isFinite(value)) {
        last = null;
        continue;
      }
      const point = [
        xFor(sample.time),
        bottom - (value / max) * (bottom - top),
      ];
      if (last && sample.time - last.time <= 8) {
        ctx.beginPath();
        ctx.moveTo(...last.point);
        ctx.lineTo(...point);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(...point, 2, 0, 2 * Math.PI);
        ctx.fill();
      }
      last = { time: sample.time, point };
    }
  });
  const empty = container.querySelector(".chart-empty");
  empty.textContent = "等待采样数据";
  empty.hidden = values.length > 0;
  const tooltip = container.querySelector(".chart-tooltip");
  canvas.onpointermove = (event) => {
    if (!points.length) return;
    const x = event.offsetX;
    const time = start + ((x - left) / (right - left)) * seconds;
    const nearest = points.reduce((a, b) =>
      Math.abs(a.time - time) < Math.abs(b.time - time) ? a : b,
    );
    tooltip.textContent =
      new Date(nearest.time * 1000).toLocaleTimeString("zh-CN") +
      "\n" +
      series
        .map((item) => {
          const value = item.value(nearest);
          return `${item.label}  ${Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + (item.unit ? " " + item.unit : "") : "无数据"}`;
        })
        .join("\n");
    tooltip.hidden = false;
    tooltip.style.left =
      Math.max(0, Math.min(x + 10, width - tooltip.offsetWidth)) + "px";
    tooltip.style.top = "18px";
  };
  canvas.onpointerleave = () => {
    tooltip.hidden = true;
  };
}
