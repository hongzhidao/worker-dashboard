const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function main() {
  const [
    base,
    passwordFile,
    applicationPath,
    output = "/tmp/worker-dashboard-check",
  ] = process.argv.slice(2);
  if (!base || !passwordFile || !applicationPath)
    throw new Error(
      "Usage: node tests/test_browser.cjs URL PASSWORD_FILE PYTHON_APP_PATH [OUTPUT_DIR]",
    );
  const password = (await fs.readFile(passwordFile, "utf8")).trim();
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1080 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  let expectedFailure = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedFailure)
      errors.push(message.text());
  });
  const name = "dashboard-check-" + Date.now();
  const headers = { Origin: base, "X-Worker-Request": "1" };
  const call = async (endpoint, data) => {
    const response = await page.request[data === undefined ? "get" : "post"](
      base + "/api/" + endpoint,
      data === undefined ? {} : { data, headers },
    );
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  let appCreated = false;
  try {
    await page.goto(base);
    await page.locator("#login-form input").fill(password);
    await page.locator("#login-form button").click();
    await page.locator("h1").filter({ hasText: "运行总览" }).waitFor();
    await page.locator("[data-action=new-app]").first().click();
    await page.locator("#editor [name=name]").fill(name);
    await page.locator("[name=listen]").fill("127.0.0.1:18081");
    await page.locator("[name=path]").fill(path.resolve(applicationPath));
    await page.locator("[name=module]").fill("wsgi");
    await page.locator("[data-action=preview]").click();
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    appCreated = true;
    await page.locator("#detail-metrics").waitFor();

    const application = await page.request.get("http://127.0.0.1:18081/");
    assert.equal(application.status(), 200, await application.text());
    await page.locator(".tabs a").filter({ hasText: "进程配置" }).click();
    await page.locator("[name=mode][value=fixed]").check({ force: true });
    await page.locator("[name=fixed]").fill("2");
    await page.locator("[data-action=preview]").click();
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    assert.equal((await call("config")).config.applications[name].processes, 2);

    await page
      .locator(".tabs a")
      .filter({ hasText: "应用配置", exact: true })
      .click();
    await page.locator("[data-action=add-env]").click();
    await page.locator("[data-env=key]").fill("KEEP_ME");
    await page.locator("[data-env=value]").fill("test-secret-value");
    await page.locator("[data-action=preview]").click();
    assert.ok(
      !(await page.locator("#diff-content").innerText()).includes(
        "test-secret-value",
      ),
    );
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);

    // A different browser/API writer changes configuration while the editor is open.
    await page
      .locator(".tabs a")
      .filter({ hasText: "JSON", exact: true })
      .click();
    const original = await call("config");
    const external = structuredClone(original.config.applications[name]);
    external.processes = 3;
    await call("change/application", {
      name,
      revision: original.revision,
      value: external,
    });
    const draft = JSON.parse(await page.locator("[name=json]").inputValue());
    draft.processes = 4;
    await page.locator("[name=json]").fill(JSON.stringify(draft, null, 2));
    await page.locator("[data-action=preview]").click();
    expectedFailure = true;
    await page.locator("#dialog [data-action=apply]").click();
    await page
      .locator("#dialog-error")
      .filter({ hasText: "配置已发生变化" })
      .waitFor();
    expectedFailure = false;
    assert.equal((await call("config")).config.applications[name].processes, 3);
    await page.locator("#dialog [data-action=close-dialog]").first().click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("[data-action=reload-editor]").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[name=json]") &&
        JSON.parse(document.querySelector("[name=json]").value).processes === 3,
    );

    const invalid = JSON.parse(await page.locator("[name=json]").inputValue());
    invalid.listen = "127.0.0.1:8090";
    await page.locator("[name=json]").fill(JSON.stringify(invalid, null, 2));
    await page.locator("[data-action=preview]").click();
    expectedFailure = true;
    await page.locator("#dialog [data-action=apply]").click();
    await page
      .locator("#dialog-error")
      .filter({ hasText: "操作未完成" })
      .waitFor();
    expectedFailure = false;
    assert.equal(
      (await call("config")).config.applications[name].listen,
      "127.0.0.1:18081",
    );
    await page.locator("#dialog [data-action=close-dialog]").first().click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("[data-action=reload-editor]").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[name=json]") &&
        JSON.parse(document.querySelector("[name=json]").value).listen ===
          "127.0.0.1:18081",
    );

    await page
      .locator(".tabs a")
      .filter({ hasText: "Targets", exact: true })
      .click();
    await page
      .locator("[name=entry_mode][value=targets]")
      .check({ force: true });
    await page.locator("[data-action=preview]").click();
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    const withTargets = (await call("config")).config.applications[name];
    assert.ok(withTargets.targets.default);
    assert.equal(withTargets.environment.KEEP_ME, "test-secret-value");
    assert.equal(
      (await page.request.get("http://127.0.0.1:18081/")).status(),
      200,
    );

    await page
      .locator(".tabs a")
      .filter({ hasText: "运行情况", exact: true })
      .click();
    await page.locator("[data-action=restart]").click();
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    await page.waitForTimeout(2400);
    await page.screenshot({
      path: path.join(output, "application-desktop.png"),
      fullPage: true,
    });
    await page.locator("[data-nav=overview]").click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(output, "overview-desktop.png"),
      fullPage: true,
    });
    const pixels = await page
      .locator("#request-chart canvas")
      .evaluate((canvas) => {
        const data = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let colored = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i + 3] && data[i + 1] > data[i] + 15) colored++;
        return colored;
      });
    assert.ok(pixels > 0, "Chart should contain the sampled data series");

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 760, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(output, `overview-${viewport.width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1600, height: 1080 });
    await page.locator("[data-nav=history]").click();
    await page.locator("[data-action=refresh]").click();
    await page.locator("[data-action=record]").first().click();
    await page.locator("#dialog-title").waitFor();
    await page.locator("#dialog [data-action=close-dialog]").first().click();
    const targetChange = (await call("history")).find(
      (record) =>
        record.name === name &&
        record.operation === "application" &&
        record.result === "success",
    );
    await page
      .locator(`[data-action=record][data-id="${targetChange.id}"]`)
      .click();
    await page.locator("[data-action=restore]").click();
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    assert.equal(
      (await call("config")).config.applications[name].targets,
      undefined,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["settings", "processes", "targets", "json"]) {
      await page.goto(base + "#/apps/" + encodeURIComponent(name) + "/" + tab);
      await page.locator("#editor").waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        tab + " overflows on mobile",
      );
      if (tab === "settings")
        await page.screenshot({
          path: path.join(output, "settings-mobile.png"),
          fullPage: true,
        });
    }
    await page.setViewportSize({ width: 1600, height: 1080 });
    await page.locator("[data-nav=apps]").click();
    await page.locator(`[data-action=delete][data-name="${name}"]`).click();
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    appCreated = false;
    assert.equal((await call("config")).config.applications[name], undefined);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          result: "passed",
          name,
          chartPixels: pixels,
          screenshots: output,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (appCreated) {
        const current = await call("config");
        await call("change/delete", { name, revision: current.revision });
      }
    } finally {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
