const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  navigate,
  engine,
  proxyConfig,
  settings,
  defaults,
} = require("../src/policy.cjs");
test("search encodes query and supports custom engine", () => {
  assert.equal(
    navigate("a & б", {
      name: "custom",
      url: "https://example.org/?q={query}",
    }),
    "https://example.org/?q=a%20%26%20%D0%B1",
  );
});
test("direct address, localhost, IPv6 and port", () => {
  for (const [input, url] of [
    ["example.org", "https://example.org/"],
    ["localhost:3000", "http://localhost:3000/"],
    ["https://[::1]:3000", "https://[::1]:3000/"],
  ])
    assert.equal(navigate(input, defaults().engines[0]), url);
});
test("dangerous schemes and embedded credentials are denied", () => {
  for (const url of [
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:pass@example.org",
  ])
    assert.throws(() => navigate(url, defaults().engines[0]));
});
test("onion does not enter direct mode", () => {
  assert.throws(() => navigate("http://example.onion", defaults().engines[0]));
  assert.equal(
    navigate("http://example.onion", defaults().engines[0], true),
    "http://example.onion/",
  );
});
test("engine validates template and refuses hostname substitution", () => {
  assert.throws(() => engine({ name: "bad", url: "https://example.org/" }));
  assert.throws(() => engine({ name: "bad", url: "https://{query}.org/" }));
});
test("fixed proxy has no DIRECT and no implicit loopback bypass", () => {
  for (const mode of ["http", "socks5", "tor", "profile"]) {
    const c = proxyConfig({ mode, host: "127.0.0.1", port: 10808 });
    assert.equal(c.mode, "fixed_servers");
    assert.equal(c.proxyBypassRules, "<-loopback>");
    assert.ok(!c.proxyRules.includes("direct"));
  }
  assert.equal(
    proxyConfig({ mode: "profile", kind: "awg" }).proxyRules,
    "socks5://127.0.0.1:19081",
  );
});
test("proxy rejects injection and invalid ports", () => {
  for (const host of ["evil;direct://", "x/y", "user:pass@host"])
    assert.throws(() => proxyConfig({ mode: "socks5", host, port: 1000 }));
  assert.throws(() =>
    proxyConfig({ mode: "socks5", host: "localhost", port: 65536 }),
  );
});
test("settings preserve profile but never secret fields", () => {
  const s = settings({
    ...defaults(),
    secret: "not-a-real-secret",
    network: { mode: "profile", profileId: "id", kind: "awg" },
  });
  assert.equal(s.network.profileId, "id");
  assert.equal(s.secret, undefined);
});
