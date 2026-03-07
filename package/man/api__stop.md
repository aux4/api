#### Description

Stops a running API server by reading the `.pid` file in the current working directory, sending a SIGTERM signal to the process, and removing the `.pid` file.

The `.pid` file is automatically created by `aux4 api start` when the server starts. If the `.pid` file does not exist, the command exits silently.

#### Usage

```bash
aux4 api stop
```

#### Example

```bash
aux4 api start --configFile config.yaml
aux4 api stop
```
