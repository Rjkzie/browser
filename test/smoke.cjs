const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error("Smoke timeout");
}
module.exports = async function ({
  app,
  win,
  command,
  browserSession,
  snapshot,
  getTab,
}) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Quiet fixture</title><h1 id="fixture">Browser works</h1>',
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const screenshots = app.isPackaged
    ? path.join(app.getPath("userData"), "screenshots")
    : path.join(__dirname, "../docs");
  try {
    await until(() =>
      win.webContents.executeJavaScript(
        '!!document.querySelector("#home-search")',
      ),
    );
    await fs.mkdir(screenshots, { recursive: true });
    await delay(300);
    await fs.writeFile(
      path.join(screenshots, "screenshot.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await command("navigate", url);
    await until(() => getTab().title === "Quiet fixture" && !getTab().loading);
    const wc = getTab().view.webContents;
    assert.deepEqual(
      await wc.executeJavaScript(
        '({node:typeof require, bridge:typeof quiet, heading:document.querySelector("h1").textContent})',
      ),
      { node: "undefined", bridge: "undefined", heading: "Browser works" },
    );
    const preferences = wc.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    await assert.rejects(() =>
      command("navigate", "file:///C:/Windows/win.ini"),
    );
    const ses = await browserSession("web");
    const extensions = ses.extensions.getAllExtensions();
    assert.ok(
      extensions.some((e) => /uBlock Origin/i.test(e.name)),
      "uBlock extension missing",
    );
    wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Network.enable");
    const blocked = new Promise((resolve) => {
      wc.debugger.on("message", (_event, method, params) => {
        if (method === "Network.loadingFailed") resolve(params.errorText);
        if (
          method === "Network.requestWillBeSent" &&
          /chrome-extension:.*web_accessible_resources\/googlesyndication_adsbygoogle\.js/.test(
            params.request.url,
          )
        )
          resolve("ubo-redirect");
      });
    });
    await wc.executeJavaScript(
      'var s=document.createElement("script");s.src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";document.body.append(s);void 0',
    );
    const blockResult = await Promise.race([
      blocked,
      delay(12000).then(() => "timeout"),
    ]);
    assert.ok(
      ["net::ERR_BLOCKED_BY_CLIENT", "ubo-redirect"].includes(blockResult),
      "uBlock must cancel advertising or redirect it to its local neutralizing script: " +
        blockResult,
    );
    wc.debugger.detach();
    const aiSession = await browserSession("ai-gpt");
    assert.notEqual(aiSession, ses);
    await ses.cookies.set({ url, name: "isolation", value: "fixture" });
    assert.equal(
      (await aiSession.cookies.get({ url, name: "isolation" })).length,
      0,
    );
    const saved = snapshot().config;
    await command("save", {
      ...saved,
      network: { mode: "socks5", host: "127.0.0.1", port: 1 },
    });
    const before = hits;
    await command("navigate", url);
    await until(() => !!getTab().error);
    assert.equal(hits, before, "failed proxy must not fall back to direct");
    await command("save", saved);
    const fixtureProfile = await command("import-profile", {
      name: "Smoke fixture",
      text: "vless://00000000-0000-4000-8000-000000000000@127.0.0.1:9?security=none&type=tcp",
    });
    assert.equal(fixtureProfile.length, 1);
    assert.equal(fixtureProfile[0].payload, undefined);
    const encrypted = await fs.readFile(
      path.join(app.getPath("userData"), "profiles.encrypted"),
    );
    assert.ok(
      !encrypted.includes(Buffer.from("00000000-0000-4000-8000-000000000000")),
      "VPN keys must not be stored as plaintext",
    );
    await command("connect-profile", fixtureProfile[0].id);
    assert.equal(snapshot().config.network.mode, "profile");
    await command("save", saved);
    await command("delete-profile", fixtureProfile[0].id);
    await command("overlay", true);
    assert.equal(snapshot().overlay, true);
    await command("overlay", false);
    await win.webContents.executeJavaScript(
      'document.getElementById("settings").click()',
    );
    await until(() =>
      win.webContents.executeJavaScript(
        'document.getElementById("settings-dialog").open',
      ),
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        'document.querySelector("[data-page=search]").hidden',
      ),
      false,
    );
    await fs.writeFile(
      path.join(screenshots, "settings.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await win.webContents.executeJavaScript(
      'document.getElementById("close-settings").click()',
    );
    console.log(
      "SMOKE PASS: UI, real navigation, sandbox, URL guard, uBlock blocking, isolated AI cookies, fail-closed proxy.",
    );
  } catch (e) {
    console.error("SMOKE FAIL:", e);
    app.exitCode = 1;
    process.exitCode = 1;
  } finally {
    server.close();
    app.exit(process.exitCode || 0);
  }
};
