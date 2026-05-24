#!/usr/bin/env node

const Server = require('./lib/Server');

async function main() {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0 || !['start', 'stop', 'init'].includes(args[0])) {
      console.error('Usage: node index.js start|stop|init');
      process.exit(1);
    }

    if (args[0] === 'stop') {
      Server.stopByPid();
      return;
    }

    if (args[0] === 'init') {
      const { execSync } = require('child_process');
      const configFile = args[1] || 'config.yaml';
      try {
        const output = execSync(`aux4 config get components --configFile ${configFile}`).toString().trim();
        const components = JSON.parse(output || '{}');
        for (const [, value] of Object.entries(components)) {
          if (value.package) {
            console.log(`Installing ${value.package}...`);
            execSync(`aux4 api package install ${value.package}`, { stdio: 'inherit' });
          }
        }
      } catch (error) {
        if (error.message.includes('components')) {
          console.log('No components configured');
        } else {
          console.error('Error:', error.message);
          process.exit(1);
        }
      }
      return;
    }

    const config = {};

    if (args[1]) {
      const port = parseInt(args[1], 10);
      if (isNaN(port)) {
        console.error('Error: Port must be a valid number');
        process.exit(1);
      }
      config.port = port;
    }

    if (args[2]) {
      try {
        config.cors = JSON.parse(args[2]);
      } catch (error) {
        config.cors = args[2];
      }
    }

    if (args[3]) {
      try {
        config.api = JSON.parse(args[3]);
      } catch (error) {
        config.api = args[3];
      }
    }

    if (args[4]) {
      try {
        config.ws = JSON.parse(args[4]);
      } catch (error) {
        config.ws = args[4];
      }
    }

    if (args[5]) {
      try {
        config.server = JSON.parse(args[5]);
      } catch (error) {
        config.server = args[5];
      }
    }

    if (args[6]) {
      try {
        config.tls = JSON.parse(args[6]);
      } catch (error) {
        config.tls = args[6];
      }
    }

    if (args[7]) {
      try {
        config.security = JSON.parse(args[7]);
      } catch (error) {
        config.security = args[7];
      }
    }

    if (args[8] === "true") {
      config.production = true;
    }

    const server = new Server(config);
    await server.start();

  } catch (error) {
    console.error('Error starting server:', error.message);
    process.exit(1);
  }
}

main();
