const { Stream } = require("stream");
const childProcess = require("child_process");

const PARAM_REGEX = /\${?(\w+)}?/g;
const VARIABLE_REGEX = /\${?(\w+)}?/;

class Command {
  static async replaceVariables(command, parameters) {
    let result = command;

    const variables = variableList(result);
    for (const name of variables) {
      const value = await parameters[name];
      if (value) {
        result = variableReplace(result, name, value);
      }
    }

    return result;
  }

  static async execute(command, input, options = {}) {
    return new Promise((resolve, reject) => {
      const out = {};

      const child = childProcess.exec(command, { maxBuffer: Infinity, ...options }, (err, stdout, stderr) => {
        if (err) {
          reject(new ExecutorError(err.message, err, out.exitCode, stdout, stderr));
        } else {
          resolve({ exitCode: out.exitCode, stdout, stderr });
        }
      });

      child.on("exit", exitCode => {
        out.exitCode = exitCode;
      });

      writeStdIn(child, input);
    });
  }
}

function variableList(action) {
  if (typeof action !== "string") {
    return [];
  }

  const variables = {};
  const vars = action.match(PARAM_REGEX);
  if (vars) {
    vars.forEach(variable => {
      const key = variable.match(VARIABLE_REGEX)[1];
      variables[key] = true;
    });
  }
  return Object.keys(variables);
}

function variableReplace(action, key, value) {
  let responseAction = action;
  const regex = new RegExp(`\\$\{?(${key}[^}\\s]*)}?`, "g");
  const results = responseAction.match(regex);
  results.forEach(keyResult => {
    const variable = keyResult.replace(/\${?([^}\s]+)}?/, "$1");
    let result = value;

    if (variable.indexOf(".") > -1) {
      variable
        .split(".")
        .splice(1)
        .forEach(name => {
          if (result === undefined) {
            return;
          }

          if (name.indexOf("[") > -1) {
            const index = name.replace(VARIABLE_WITH_INDEX_REGEX, "$2");
            name = name.replace(VARIABLE_WITH_INDEX_REGEX, "$1");
            result = result[name][index];
            return;
          }

          result = result[name];
        });
    } else if (variable.indexOf("[") > -1) {
      const index = variable.replace(VARIABLE_WITH_INDEX_REGEX, "$2");
      result = value[index];
    }

    if (result === undefined) {
      result = "";
    }

    if (responseAction === keyResult) {
      responseAction = result;
      return;
    }

    responseAction = responseAction.replace(keyResult, result);
  });
  return responseAction;
}

function writeStdIn(child, input) {
  if (input) {
    if (input instanceof Stream) {
      input.pipe(child.stdin);
    } else if (typeof input === "string") {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  } else {
    child.stdin.end();
  }
}

class ExecutorError extends Error {
  constructor(message, cause, exitCode, stdout, stderr) {
    super(message);
    this.cause = cause;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

module.exports = Command;
