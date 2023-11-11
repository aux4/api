const fs = require("fs");
const pack = require("../package.json");
const aux4 = require("../aux4.json");

const args = process.argv.splice(2);

const params = {};
args
  .filter(arg => arg.includes("="))
  .map(arg => arg.split("="))
  .forEach(([key, value]) => {
    params[key] = value;
  });

pack.name = `@aux4/${params.name}`;
pack.description = params.description;
pack.keywords = [...pack.keywords, ...params.keywords.split(",")];
pack.bin = { [`aux4-${params.command}`]: "bin/executable.js" };
pack.repository.url = pack.repository.url.replace("template", params.name);
pack.bugs.url = pack.bugs.url.replace("template", params.name);
pack.homepage = pack.homepage.replace("template", params.name);
fs.writeFileSync("package.json", JSON.stringify(pack, null, 2));

const release = aux4.profiles[0].commands.find(command => command.name === "release");
release.help.text = release.help.text.replace("template", params.name);
fs.writeFileSync("aux4.json", JSON.stringify(aux4, null, 2));

const executable = fs.readFileSync("bin/executable.js", { encoding: "utf8" });
fs.writeFileSync("bin/executable.js", executable.replace("aux4-template", `aux4-${params.name}`));
