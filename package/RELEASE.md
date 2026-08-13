# aux4/api 2.0.9

## Fixes

### `api handle` forwards `--configFile` to route commands

Route commands frequently need to read the same app config the API was started
with (e.g. `aux4 config get ...` for mail/service settings). They previously
relied on the process working directory containing `config.yaml`, which holds for
`api start` (run from the project directory) but **not** for `api handle` in a
serverless runtime, where the config lives elsewhere (e.g. `/tmp/config.yaml`) and
the CWD does not. Such a command failed with `No config file found`, and the
handler returned a 500.

`api handle` now forwards its `--configFile` to every route command, so
`aux4 config get`/`param(configFile:file)` resolves the shared app config
regardless of the working directory. Commands that don't use it are unaffected.
