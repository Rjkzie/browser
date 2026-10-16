const fs = require("node:fs/promises");
const path = require("node:path");
const { hash } = require("../src/components.cjs");
(async () => {
  const root = path.resolve(__dirname, "../components");
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "manifest.json"), "utf8"),
  );
  delete manifest.happ;
  const native = path.join(root, "awg", "quiet-awg.exe");
  const binary = await fs.readFile(native);
  const mod = await fs.readFile(
    path.resolve(__dirname, "../native/awg/go.mod"),
    "utf8",
  );
  const version = mod.match(/amneziawg-go\/v3 (v[^\s]+)/)?.[1];
  if (!version) throw Error("AmneziaWG version missing");
  manifest.awg = {
    version,
    filename: "quiet-awg.exe",
    sha256: hash(binary),
    source: "https://github.com/amnezia-vpn/amneziawg-go",
    downloaded: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await fs.copyFile(
    path.resolve(__dirname, "../docs/THIRD-PARTY.md"),
    path.join(root, "THIRD-PARTY.md"),
  );
  console.log("Distribution ready:", Object.keys(manifest).join(", "));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
