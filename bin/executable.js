#!/usr/bin/env node

const { Engine } = require("@aux4/engine");
const { ConfigLoader } = require("@aux4/config");
const Server = require("../lib/Server");

process.title = "aux4-api";

const config = {
  profiles: [
    {
      name: "main",
      commands: [
        {
          name: "start",
          execute: async params => {
            const config = await loadConfig(params);

            const server = new Server(config);
            await server.start();
          },
          help: {
            text: "Start the server"
          }
        }
      ]
    }
  ]
};

async function loadConfig(params) {
  const configFile = await params.configFile;
  const configName = await params.config;

  const config = ConfigLoader.load(configFile);
  return config.get(configName);
}

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
