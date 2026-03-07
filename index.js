#!/usr/bin/env node

const Server = require('./lib/Server');

async function main() {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0 || (args[0] !== 'start' && args[0] !== 'stop')) {
      console.error('Usage: node index.js start|stop [port] [cors] [api] [ws] [server] [tls]');
      process.exit(1);
    }

    if (args[0] === 'stop') {
      Server.stopByPid();
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

    const server = new Server(config);
    await server.start();

  } catch (error) {
    console.error('Error starting server:', error.message);
    process.exit(1);
  }
}

main();
