const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { parseProfile, xrayConfig } = require("../src/profiles.cjs");
const uri =
  "vless://00000000-0000-4000-8000-000000000000@example.org:443?security=reality&sni=example.org&pbk=fixture&sid=aa&type=tcp#test";
test("VLESS Reality imports as outbound only", () => {
  const p = parseProfile(uri);
  assert.equal(p.kind, "xray");
  assert.equal(p.payload.streamSettings.security, "reality");
  const c = xrayConfig(p.payload);
  assert.equal(c.inbounds[0].listen, "127.0.0.1");
  assert.equal(c.outbounds.length, 1);
  assert.equal(c.routing, undefined);
});
test("raw JSON discards inbounds, direct fallback, logs and socket overrides", () => {
  const p = parseProfile(
    JSON.stringify({
      log: { access: "secret.log" },
      inbounds: [{ listen: "0.0.0.0" }],
      outbounds: [
        { protocol: "freedom" },
        {
          protocol: "trojan",
          settings: { servers: [] },
          streamSettings: {
            sockopt: { dialerProxy: "bypass" },
            tlsSettings: { allowInsecure: true },
          },
        },
      ],
    }),
  );
  assert.equal(p.payload.streamSettings.sockopt, undefined);
  assert.equal(p.payload.streamSettings.tlsSettings.allowInsecure, false);
});
test("Amnezia vpn envelope finds embedded protocol config", () => {
  const config = "[Interface]\nPrivateKey=fixture\n[Peer]\nPublicKey=fixture";
  const data = Buffer.from(
    JSON.stringify({ containers: [{ awg: { last_config: config } }] }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const key =
    "vpn://" +
    Buffer.concat([header, zlib.deflateSync(data)]).toString("base64url");
  assert.equal(parseProfile(key).kind, "awg");
});
test("unknown and remote subscription formats fail explicitly", () => {
  for (const value of [
    "https://provider.example/sub",
    "vpn://bad",
    "not-a-profile",
    JSON.stringify({ outbounds: [{ protocol: "freedom" }] }),
  ])
    assert.throws(() => parseProfile(value));
});
