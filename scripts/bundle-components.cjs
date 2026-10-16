const path = require("node:path");
const { Components } = require("../src/components.cjs");
new Components(path.resolve(__dirname, "../components"), fetch, console.log)
  .update()
  .then((m) => console.log("Bundled:", Object.keys(m).join(", ")))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
