const { test } = require("node:test");
const assert = require("node:assert/strict");
const { trustedURL, verify, hash } = require("../src/components.cjs");
test("updates trust exact official hosts over HTTPS", () => {
  assert.ok(trustedURL("https://github.com/XTLS/Xray-core"));
  for (const url of [
    "http://github.com/a",
    "https://github.com.evil.org/a",
    "https://user:pass@github.com/a",
    "file:///etc/passwd",
  ])
    assert.throws(() => trustedURL(url));
});
test("mandatory SHA-256 detects tampering and missing hashes", () => {
  const b = Buffer.from("fixture");
  verify(b, "sha256:" + hash(b));
  assert.throws(() => verify(Buffer.from("modified"), "sha256:" + hash(b)));
  assert.throws(() => verify(b, ""));
});
