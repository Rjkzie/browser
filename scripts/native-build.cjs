const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
(async () => {
  const root = path.resolve(__dirname, "..");
  const cwd = path.join(root, "native/awg");
  const go = process.env.QUIET_GO || "go";
  const call = (args) =>
    execFileSync(go, args, { cwd, encoding: "utf8", windowsHide: true });
  const target = path.join(root, "components/awg");
  await fs.mkdir(target, { recursive: true });
  call([
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    path.join(target, "quiet-awg.exe"),
    ".",
  ]);
  const modules = call([
    "list",
    "-deps",
    "-f",
    "{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}",
    ".",
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const notices = path.join(target, "licenses");
  await fs.mkdir(notices, { recursive: true });
  for (const line of new Set(modules)) {
    const [name, version, dir] = line.split("|");
    if (!dir || !version) continue;
    for (const entry of await fs.readdir(dir)) {
      if (/^(LICENSE|COPYING|NOTICE)([._-].*)?$/i.test(entry)) {
        const from = path.join(dir, entry);
        if ((await fs.stat(from)).isFile()) {
          const destination = path.join(
            notices,
            name.replaceAll("/", "_") + "_" + entry,
          );
          await fs.chmod(destination, 0o666).catch(() => {});
          await fs.writeFile(destination, await fs.readFile(from));
        }
      }
    }
  }
  const goLicense = path.join(notices, "Go-LICENSE");
  await fs.chmod(goLicense, 0o666).catch(() => {});
  await fs.writeFile(
    goLicense,
    await fs.readFile(path.join(call(["env", "GOROOT"]).trim(), "LICENSE")),
  );
  await fs.writeFile(
    path.join(target, "SOURCES.txt"),
    modules.map((line) => line.split("|").slice(0, 2).join(" ")).join("\n") +
      "\nCorresponding module sources: https://proxy.golang.org/ and upstream repositories.\n",
  );
  console.log("Built AmneziaWG with dependency notices");
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
