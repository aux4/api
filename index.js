#!/usr/bin/env node

const Server = require('./lib/Server');

async function main() {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0 || !['start', 'stop', 'init', 'openapi', 'handle'].includes(args[0])) {
      console.error('Usage: node index.js start|stop|init|openapi|handle');
      process.exit(1);
    }

    if (args[0] === 'stop') {
      Server.stopByPid();
      return;
    }

    if (args[0] === 'handle') {
      const { handleCommand } = require('./lib/handleCommand');
      const parse = value => {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };

      const config = {};
      if (args[1]) config.cors = parse(args[1]);
      if (args[2]) config.api = parse(args[2]);
      if (args[3]) config.ws = parse(args[3]);
      if (args[4]) config.server = parse(args[4]);
      if (args[5]) config.tls = parse(args[5]);
      if (args[6]) config.security = parse(args[6]);
      if (args[7] === 'true') config.production = true;
      if (args[8]) config.components = parse(args[8]);

      await handleCommand(config);
      return;
    }

    if (args[0] === 'openapi') {
      const { generate } = require('./lib/openapi');
      const configFile = args[1] || 'config.yaml';
      const format = args[2] || 'json';
      try {
        process.stdout.write(generate(configFile, format));
        process.stdout.write('\n');
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
      return;
    }

    if (args[0] === 'init') {
      const fs = require('fs');
      const { execSync } = require('child_process');
      const configFile = args[1] || 'config.yaml';
      try {
        const output = execSync(`aux4 config get components --configFile ${configFile}`).toString().trim();
        const components = JSON.parse(output || '{}');
        const profiles = [];

        for (const [, value] of Object.entries(components)) {
          if (value.package) {
            const scope = value.package.split('/')[0];
            const name = value.package.split('/')[1];
            const componentDir = `./components/${scope}/${name}`;

            if (!fs.existsSync(componentDir)) {
              console.log(`Installing ${value.package}...`);
              execSync(`aux4 api package install ${value.package}`, { stdio: 'inherit' });
            } else {
              console.log(`Component ${value.package} already installed`);
            }

            // Load component .aux4 profiles
            const aux4File = `${componentDir}/.aux4`;
            if (fs.existsSync(aux4File)) {
              try {
                const pkg = JSON.parse(fs.readFileSync(aux4File, 'utf-8'));
                if (pkg.profiles) {
                  profiles.push(...pkg.profiles);
                }
              } catch {}
            }
          }
        }

        // Merge component profiles into .aux4
        if (profiles.length > 0 && fs.existsSync('.aux4')) {
          const hostAux4 = JSON.parse(fs.readFileSync('.aux4', 'utf-8'));

          // Remove previously merged component profiles (marked with __component)
          hostAux4.profiles = (hostAux4.profiles || []).filter(p => !p.__component);

          // Add component profiles with marker
          for (const profile of profiles) {
            profile.__component = true;
            hostAux4.profiles.push(profile);
          }

          fs.writeFileSync('.aux4', JSON.stringify(hostAux4, null, 2));
          console.log('Merged component profiles into .aux4');
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

    if (args[9]) {
      try {
        config.components = JSON.parse(args[9]);
      } catch (error) {
        config.components = args[9];
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
