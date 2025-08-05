const { v7: uuidv7 } = require("uuid");

function uuid() {
  return async (request, reply) => {
    request.uuid = uuidv7();
  };
}

module.exports = { uuid };
