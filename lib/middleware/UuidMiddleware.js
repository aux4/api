const { v4: uuidv4 } = require("uuid");

function uuid() {
  return (req, res, next) => {
    req.uuid = uuidv4();
    next();
  };
}

module.exports = { uuid };
