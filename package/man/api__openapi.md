#### Description

The `openapi` command reads an aux4/api `config.yaml` and emits an **OpenAPI 3.0.3** document derived from `config.api` (plus any component routes). It prints JSON to stdout by default, or YAML with `--format yaml`.

For every route key in `config.api` — of the form `"METHOD /path"` — it generates a path item and operation:

- **Paths & operations** — each `"METHOD /path"` becomes an OpenAPI path item with the method as the operation. `{name}` segments in the path become required `string` path parameters.
- **operationId / summary** — derived from the route's `command` (e.g. `aux4 auth signin` → `aux4_auth_signin`). Routes without a command fall back to `METHOD /path`.
- **Tags** — each operation is tagged by the first path segment (e.g. `/contacts/{id}` → `contacts`).
- **Component routes** — if `config.components` is present, each component's `components/<scope>/<name>/config.yaml` `api` block is merged under its mount path, exactly as the running server does. So a `aux4/contacts` component mounted at `/contacts` contributes `/contacts`, `/contacts/{id}`, etc.
- **Best-effort parameter inference** — the target command's `execute[]` (looked up in the app `.aux4` next to the config file) is statically scanned for `query.X` references (→ query params on GET/DELETE) and body-field references (→ `requestBody` properties on POST/PUT/PATCH). Body fields are found through `${body.X}` and through aliases created with `set:alias=json:${body}` (e.g. `object(data.firstName:firstName, ...)`). All inferred fields are typed `string`. This is a heuristic; anything it cannot see is best supplied via the `openapi:` annotation below.

##### The `openapi:` annotation (escape hatch)

Any route entry in `config.api` (or a component's `config.api`) may carry an `openapi:` block that is overlaid onto the generated operation. This is the reliable way to document parameters, bodies, and responses that static analysis cannot infer.

```yaml
config:
  api:
    "GET /search":
      command: aux4 search run
      openapi:
        summary: Search records
        tags:
          - search
        parameters:
          - name: q
            in: query
            required: true
            schema:
              type: string
        responses:
          "200":
            description: Matching records
          "400":
            description: Bad query
    "POST /widgets":
      command: aux4 widget create
      openapi:
        requestBody:
          required: true
          content:
            application/json:
              schema:
                type: object
                properties:
                  name:
                    type: string
```

Overlay rules:

- `summary`, `description`, `operationId`, `deprecated`, `tags` — **replace** the generated value.
- `parameters` — **merged by** `in`+`name` (annotation wins on conflict, new ones are appended).
- `requestBody` — **replaces** the generated request body.
- `responses` — **shallow-merged** onto the generated `200`.

##### Info block

`config.info` (`title`, `version`, `description`) populates the OpenAPI `info` object. Defaults: title `aux4 API`, version `1.0.0`.

#### Usage

```bash
aux4 api openapi [--configFile <path>] [--format <json|yaml>]
```

--configFile  Path to the API config file (default: `config.yaml`)
--format      Output format, `json` or `yaml` (default: `json`)

#### Example

```bash
aux4 api openapi --configFile config.yaml
```

```json
{
  "openapi": "3.0.3",
  "info": {
    "title": "aux4 API",
    "version": "1.0.0"
  },
  "paths": {
    "/contacts/{id}": {
      "get": {
        "tags": [
          "contacts"
        ],
        "operationId": "aux4_api_module_contacts_get",
        "summary": "aux4 api module contacts get",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Successful response"
          }
        }
      }
    }
  }
}
```

Emit YAML instead:

```bash
aux4 api openapi --configFile config.yaml --format yaml
```
