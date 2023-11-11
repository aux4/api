#!/usr/bin/env node

const { Engine } = require("@aux4/engine");

process.title = "aux4-template";

const config = {
  profiles: [
    {
      name: "main",
      commands: [
        {
          name: "",
          execute: [],
          help: {
            text: ""
          }
        }
      ]
    }
  ]
};

(async () => {
  const engine = new Engine({ aux4: config });

  const args = process.argv.splice(2);

  try {
    await engine.run(args);
  } catch (e) {
    console.error(e.message.red);
    process.exit(1);
  }
})();
