const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const [base, passwordFile, assets, output = "/tmp/worker-dashboard-entries"] =
    process.argv.slice(2);
  if (!base || !passwordFile || !assets)
    throw new Error(
      "Usage: node tests/test_entries.cjs URL PASSWORD_FILE APP_ASSETS [OUTPUT_DIR]",
    );
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
  });
  const errors = [],
    names = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const call = async (endpoint, data) => {
    const response = await page.request[data === undefined ? "get" : "post"](
      base + "/api/" + endpoint,
      data === undefined
        ? {}
        : { data, headers: { Origin: base, "X-Worker-Request": "1" } },
    );
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const mode = (value) =>
    page.locator(`[name=entry_mode][value=${value}]`).check({ force: true });
  const apply = async () => {
    await page.locator("[data-action=preview]").click();
    await page.locator("#dialog [data-action=apply]").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
  };
  const capture = async (filename) => {
    const viewport = page.viewportSize();
    await page.evaluate(() => window.scrollTo(0, 0));
    const height = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    await page.setViewportSize({ ...viewport, height });
    await page.screenshot({
      path: path.join(output, filename),
      fullPage: true,
    });
    await page.setViewportSize(viewport);
  };
  try {
    await page.goto(base);
    await page
      .locator("[name=password]")
      .fill((await fs.readFile(passwordFile, "utf8")).trim());
    await page.locator("#login-form button").click();
    await page.locator("#metrics").waitFor();
    for (const lang of ["python", "php"]) {
      const name = "entry-check-" + lang + "-" + Date.now();
      names.push(name);
      const firstPort = await freePort();
      let secondPort = await freePort();
      while (secondPort === firstPort) secondPort = await freePort();
      const firstAddress = "127.0.0.1:" + firstPort,
        secondAddress = "127.0.0.1:" + secondPort;
      await page.locator("[data-nav=apps]").click();
      await page.locator("[data-action=new-app]").click();
      await page.locator("[name=name]").fill(name);
      await page.locator("[name=type]").selectOption(lang);
      await page.locator("#single-entry [name=listen]").fill(firstAddress);
      if (lang === "python") {
        await page.locator("[name=path]").fill(path.resolve(assets));
        await page.locator("#single-entry [name=module]").fill("wsgi");
        await page.locator("#single-entry [name=callable]").fill("application");
      } else {
        await page
          .locator("#single-entry [name=root]")
          .fill(path.resolve(assets));
        await page.locator("#single-entry [name=script]").fill("index.php");
      }
      await page.locator("[data-action=add-env]").click();
      await page.locator("[data-env=key]").fill("ENTRY_CHECK");
      await page.locator("[data-env=value]").fill("keep-common-settings");
      await mode("targets");
      assert.equal(await page.locator("#single-entry").isVisible(), false);
      assert.equal(
        await page
          .locator("#single-entry")
          .evaluate((element) => element.disabled),
        true,
      );
      assert.equal(
        await page.locator(".target [name=listen]").inputValue(),
        firstAddress,
      );
      await page.locator("[data-action=add-target]").click();
      const second = page.locator(".target").nth(1);
      await second.locator("[name=target_name]").fill("admin");
      await second.locator("[name=listen]").fill(secondAddress);
      if (lang === "python") await second.locator("[name=module]").fill("wsgi");
      else {
        await second.locator("[name=root]").fill(path.resolve(assets));
        await second.locator("[name=script]").fill("index.php");
      }

      await mode("single");
      await page.locator("[name=retained_target]").selectOption("1");
      assert.equal(
        await page.locator("#single-entry [name=listen]").inputValue(),
        secondAddress,
      );
      await mode("targets");
      assert.equal(await page.locator(".target").count(), 2);
      assert.equal(
        await second.locator("[name=listen]").inputValue(),
        secondAddress,
      );
      if (lang === "python") {
        await page.locator("[name=type]").selectOption("ruby");
        assert.equal(await page.locator("[name=entry_mode]").count(), 0);
        await page
          .locator("#single-entry [name=listen]")
          .fill("127.0.0.1:19999");
        await page.locator("[name=type]").selectOption("python");
        assert.equal(
          await page.locator("[name=entry_mode][value=targets]").isChecked(),
          true,
        );
        assert.equal(
          await page.locator("[name=path]").inputValue(),
          path.resolve(assets),
        );
        assert.equal(await page.locator(".target").count(), 2);
        assert.equal(
          await second.locator("[name=listen]").inputValue(),
          secondAddress,
        );
      }
      await second.locator("[name=target_name]").fill("default");
      await page.locator("[data-action=preview]").click();
      assert.match(
        await page.locator("#form-error").innerText(),
        /名称不能为空或重复/,
      );
      assert.equal((await call("config")).config.applications[name], undefined);
      await second.locator("[name=target_name]").fill("admin");
      await second.locator("[name=listen]").fill(firstAddress);
      await page.locator("[data-action=preview]").click();
      assert.match(
        await page.locator("#form-error").innerText(),
        /监听地址不能重复/,
      );
      await second.locator("[name=listen]").fill(secondAddress);
      await second.locator("[name=listen]").press("Enter");
      await page.locator("#dialog").waitFor({ state: "visible" });
      assert.equal(await page.locator(".target").count(), 2);
      await page.locator("#dialog [data-action=close-dialog]").first().click();
      await capture(lang + "-new-targets.png");
      await apply();
      await page.locator("#detail-metrics").waitFor();
      let current = await call("config");
      let app = current.config.applications[name];
      assert.equal(app.listen, undefined);
      assert.equal(app.module, undefined);
      assert.equal(app.root, undefined);
      assert.equal(app.targets.default.listen, firstAddress);
      assert.equal(app.targets.admin.listen, secondAddress);
      assert.equal(app.environment.ENTRY_CHECK, "keep-common-settings");
      for (const address of [firstAddress, secondAddress]) {
        const response = await page.request.get("http://" + address + "/");
        assert.equal(response.status(), 200, await response.text());
      }

      app.processes = 2;
      app.limits = { timeout: 10 };
      if (lang === "python") app.targets.admin.factory = false;
      await call("change/application", {
        name,
        revision: current.revision,
        value: app,
      });
      await page
        .locator(".tabs a")
        .filter({ hasText: "应用配置", exact: true })
        .click();
      await page.locator("#multi-entry").waitFor({ state: "visible" });
      await mode("single");
      await page.locator("[name=retained_target]").selectOption("1");
      assert.equal(
        await page.locator("#single-entry [name=listen]").inputValue(),
        secondAddress,
      );
      assert.ok((await call("config")).config.applications[name].targets);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await capture(lang + "-retain-mobile.png");
      await apply();
      await page.locator("#single-entry").waitFor({ state: "visible" });
      app = (await call("config")).config.applications[name];
      assert.equal(app.targets, undefined);
      assert.equal(app.listen, secondAddress);
      assert.equal(app.processes, 2);
      assert.deepEqual(app.limits, { timeout: 10 });
      assert.equal(app.environment.ENTRY_CHECK, "keep-common-settings");
      if (lang === "python") assert.equal(app.factory, false);
      else assert.equal(app.script, "index.php");
      assert.equal(
        (await page.request.get("http://" + secondAddress + "/")).status(),
        200,
      );
      await mode("targets");
      await page.locator("[data-action=remove-target]").click();
      assert.equal(await page.locator(".target").count(), 1);
      await apply();
      app = (await call("config")).config.applications[name];
      assert.equal(app.listen, undefined);
      assert.equal(app.targets.default.listen, secondAddress);
      if (lang === "python") assert.equal(app.targets.default.factory, false);
      assert.equal(app.environment.ENTRY_CHECK, "keep-common-settings");
      await page.setViewportSize({ width: 1600, height: 1100 });
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          result: "passed",
          languages: ["python", "php"],
          screenshots: output,
          checks: [
            "direct multi-entry creation",
            "draft round trips",
            "runtime switching",
            "duplicate validation",
            "retained target selection",
            "shared configuration preservation",
            "last target guard",
            "real HTTP requests",
            "mobile layout",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      for (const name of names) {
        const current = await call("config");
        if (current.config.applications?.[name])
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
