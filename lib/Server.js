const express = require("express");
const cors = require("cors");
const CommandLineMapper = require("./mapper/CommandLineMapper");

class Server {
  constructor(config) {
    this.config = config;
    this.mappers = [CommandLineMapper];
  }

  async start() {
    const app = express();
    app.use(cors());
    app.use(express.json());

    this.mappers.forEach(Mapper => {
      const mapper = new Mapper(app, this.config);
      mapper.build();
    });

    const port = this.config.port || 8080;

    this.server = app.listen(port, () => {
      console.log(`aux4 api started on port ${port}`);
    });
  }

  stop() {
    if (!this.server) return;

    this.server.close();
  }
}

module.exports = Server;
