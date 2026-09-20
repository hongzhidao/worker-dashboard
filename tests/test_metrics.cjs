const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function main() {
  const [
    base = "http://127.0.0.1:8090",
    output = "/tmp/worker-dashboard-metrics",
  ] = process.argv.slice(2);
  await fs.mkdir(output, { recursive: true });
  const status = {
    processes: { running: 5, idle: 2, starting: 1, stopping: 1 },
    requests: { total: 100, waiting: 5, processing: 3, completed: 92 },
    responses: { "1xx": 0, "2xx": 80, "3xx": 4, "4xx": 5, "5xx": 3 },
    latency: { p50: 8, p95: 24, p99: 24 },
    applications: {
      "app-a": {
        processes: { running: 3, idle: 1, starting: 0, stopping: 0 },
        requests: { total: 60, waiting: 2, processing: 2, completed: 56 },
        responses: { "1xx": 0, "2xx": 50, "3xx": 2, "4xx": 3, "5xx": 1 },
        latency: { p50: 8, p95: 8, p99: 8 },
      },
      "app-b": {
        processes: { running: 2, idle: 1, starting: 1, stopping: 1 },
        requests: { total: 40, waiting: 3, processing: 1, completed: 36 },
        responses: { "1xx": 0, "2xx": 30, "3xx": 2, "4xx": 2, "5xx": 2 },
        latency: { p50: 24, p95: 24, p99: 24 },
      },
    },
  };
  const config = {
    applications: {
      "app-a": {
        type: "python",
        protocol: "asgi",
        listen: "127.0.0.1:8080",
        path: "/srv/app-a",
        module: "main",
      },
      "app-b": { type: "php", listen: "127.0.0.1:8081", root: "/srv/app-b" },
    },
  };
  const now = Date.now() / 1000;
  const samples = Array.from({ length: 60 }, (_, index) => ({
    ...structuredClone(status),
    time: now - (59 - index) * 2,
    qps: 5,
    applications: {
      "app-a": { ...structuredClone(status.applications["app-a"]), qps: 3 },
      "app-b": { ...structuredClone(status.applications["app-b"]), qps: 2 },
    },
  }));
  let snapshot = {
    config,
    status,
    samples,
    instance: "metrics-check",
    connected: true,
    last_success: now,
    revision: "fixture",
    interval: 2,
    config_source: "state",
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1100 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Only this browser receives fixture data; the running service is untouched.
    await page.route("**/api/**", (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      const body =
        endpoint === "/api/session"
          ? { authenticated: true, instance: "metrics-check" }
          : endpoint === "/api/state"
            ? snapshot
            : endpoint === "/api/config"
              ? { config, revision: "fixture" }
              : endpoint === "/api/history"
                ? []
                : null;
      return body === null ? route.abort() : route.fulfill({ json: body });
    });
    const metric = (label) =>
      page.locator(`[data-metric="${label}"] .metric-value`);
    await page.goto(base);
    await metric("P95 延迟").waitFor();
    assert.equal(
      (await metric("当前 QPS").innerText()).replace(/\s/g, ""),
      "5req/s",
    );
    assert.equal(await metric("等待中").innerText(), "5");
    assert.equal(await metric("处理中").innerText(), "3");
    assert.equal(
      (await metric("P95 延迟").innerText()).replace(/\s/g, ""),
      "24ms",
    );
    assert.equal(
      (await metric("5xx 占比").innerText()).replace(/\s/g, ""),
      "3.26%",
    );
    assert.equal(await metric("运行进程").innerText(), "5");
    assert.equal(
      await page.locator("[data-request=completed]").innerText(),
      "92",
    );
    assert.equal(await page.locator('[data-response="5xx"]').innerText(), "3");
    assert.equal(
      await page
        .locator("[data-application=app-b] [data-column=failure-rate]")
        .innerText(),
      "5.56%",
    );
    assert.equal(
      await page
        .locator("[data-application=app-a] [data-column=p95]")
        .innerText(),
      "8",
    );
    assert.equal(
      await page
        .locator("[data-application=app-b] [data-column=waiting]")
        .innerText(),
      "3",
    );
    await page
      .locator("[data-action=traffic-mode][data-mode=requests]")
      .click();
    assert.equal(
      await page.locator("#request-chart canvas").getAttribute("aria-label"),
      "等待中、处理中",
    );
    await page.locator('[data-action=range][data-seconds="300"]').click();
    await page.screenshot({
      path: path.join(output, "overview.png"),
      fullPage: true,
    });
    await page.locator("[data-application=app-b] .app-link").click();
    await page.locator("#detail-metrics").waitFor();
    assert.equal(await metric("等待中").innerText(), "3");
    assert.equal(await metric("处理中").innerText(), "1");
    assert.equal(
      (await metric("5xx 占比").innerText()).replace(/\s/g, ""),
      "5.56%",
    );
    assert.equal(await page.locator("[data-request=total]").innerText(), "40");
    assert.equal(await page.locator('[data-response="2xx"]').innerText(), "30");
    await page.screenshot({
      path: path.join(output, "application.png"),
      fullPage: true,
    });
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(80);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(output, `application-${viewport.width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.locator("[data-nav=overview]").click();
    await page.locator("#metrics").waitFor();
    status.requests.completed = 90;
    status.requests.total = 98;
    status.applications["app-a"].processes.running = 99;
    await page.locator("[data-action=refresh]").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-request=completed]").textContent === "90",
    );
    assert.equal(await metric("运行进程").innerText(), "5");
    assert.equal(
      (await metric("5xx 占比").innerText()).replace(/\s/g, ""),
      "3.26%",
    );

    status.latency = { p50: 0, p95: 0, p99: 0 };
    await page.locator("[data-action=refresh]").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-metric="P95 延迟"] .metric-value')
          .textContent === "0ms",
    );
    status.latency = { p50: null, p95: null, p99: null };
    status.responses = { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
    snapshot.samples = samples.map((sample) => ({
      ...sample,
      latency: structuredClone(status.latency),
    }));
    await page.locator("[data-action=refresh]").click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-metric="P95 延迟"] .metric-value')
        .textContent.startsWith("--"),
    );
    assert.ok((await metric("5xx 占比").innerText()).startsWith("--"));
    assert.equal(
      await page.locator("#latency-chart .chart-empty").isVisible(),
      true,
    );
    snapshot.connected = false;
    snapshot.error = "Connection unavailable";
    await page.locator("[data-action=refresh]").click();
    await page.locator("#connection-error").waitFor({ state: "visible" });
    assert.equal(await metric("等待中").innerText(), "5");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          result: "passed",
          screenshots: output,
          checks: [
            "top-level metrics",
            "per-app metrics",
            "response denominator",
            "request modes",
            "zero versus null latency",
            "empty responses",
            "stale state",
            "desktop and mobile",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
