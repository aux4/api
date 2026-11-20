# per-command environment wrapper

```file:wrapper.sh
#!/bin/sh
set -eu
[ "${1:-}" = -- ] && shift
export BINDING_ONLY=child-value
exec "$@"
```

```afterAll
rm -f wrapper.sh
```

## child commands use the fixed wrapper without changing the parent

```execute
chmod 755 wrapper.sh
AUX4_COMMAND_WRAPPER="$PWD/wrapper.sh" node -e 'const C=require("./lib/Command");(async()=>{const r=await C.execute("node -e '\''process.stdout.write(process.env.BINDING_ONLY || \"missing\")'\''",null,2000);if(r.exitCode!==0||r.stdout!=="child-value"||process.env.BINDING_ONLY)process.exit(1)})()'
```

```expect

```

## shell metacharacters remain command data

```execute
AUX4_COMMAND_WRAPPER="$PWD/wrapper.sh" node -e 'const C=require("./lib/Command"),v="quote '\'' ; echo injected"; (async()=>{const r=await C.execute(`node -e "process.stdout.write(process.argv[1])" ${JSON.stringify(v)}`,null,2000);if(r.exitCode!==0||r.stdout!==v)process.exit(1)})()'
```

```expect

```

## malformed wrapper configuration fails closed

```execute
AUX4_COMMAND_WRAPPER='sh -c evil' node -e 'const C=require("./lib/Command");(async()=>{try{await C.execute("true",null,2000);process.exit(1)}catch(error){if(!/Invalid AUX4_COMMAND_WRAPPER/.test(error.message))process.exit(1)}})()'
```

```expect

```
