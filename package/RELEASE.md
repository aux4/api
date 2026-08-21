# aux4/api 2.0.13

## Fixes

### Per-request temp directory now uses the OS temp dir (fixes AWS Lambda)

The per-request temporary folder (used for multipart upload parts) was created
under the process **working directory** (`./.tmp/<uuid>`). On AWS Lambda the
working directory (`/var/task`) is **read-only**, so every request failed with
`ENOENT: no such file or directory, mkdir '.../.tmp/...'` — a `500` on all routes,
including plain REST and downloads that never touch uploads.

It now roots that folder at the OS temp dir (`os.tmpdir()/aux4-api/<uuid>`), which
is writable everywhere — including Lambda (`/tmp`). No behavior change off Lambda;
`request.tmpDir` remains an absolute path and is still cleaned up when the response
finishes. This makes `api lambda` (and any containerized `api start`) serve
correctly behind API Gateway.
