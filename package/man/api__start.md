Start the Aux4 API server with optional configuration.

### Synopsis

```bash
aux4 api start [--configFile <file>] [--config <config>] [--port <number>] [options...]
```

### Description

The `aux4 api start` command launches a Fastify-based HTTP server that exposes Aux4 CLI commands through REST API endpoints and provides server-side rendering capabilities using Handlebars templates.

The server automatically:

- Maps API endpoints to CLI commands (`/api/command/subcommand` → `aux4 command subcommand`)
- Serves static files from the `static/` directory
- Renders Handlebars templates from the `views/` directory
- Handles file uploads with configurable limits
- Provides error handling with custom error pages

### Options

#### `--config <file>`

Path to a YAML configuration file. If not specified, the server uses default settings.

**Example:**

```bash
aux4 api start --config config.yaml
aux4 api start --config /path/to/server-config.yaml
```

#### `--port <number>`

Override the server port. Defaults to 8080 if not specified in configuration.

**Example:**

```bash
aux4 api start --port 3000
```

### Configuration File

The configuration file uses YAML format and supports the following structure:

```yaml
config:
  port: 8080
  server:
    limits:
      files: 5
      fileSize: 10485760
      fieldSize: 1048576
      parts: 10
  api:
    "GET /endpoint":
      output:
        base64: false
      response:
        status: 200
        headers:
          Content-Type: "application/json"
  cors:
    origin: "*"
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    credentials: false
```

### Configuration Options

#### `config.port`

- **Type:** Number
- **Default:** 8080
- **Description:** Port number for the HTTP server

**Example:**

```yaml
config:
  port: 3000
```

#### `config.server.limits`

File upload and request limits configuration.

##### `config.server.limits.files`

- **Type:** Number
- **Default:** 5
- **Description:** Maximum number of files allowed in multipart uploads

##### `config.server.limits.fileSize`

- **Type:** Number (bytes)
- **Default:** 10485760 (10MB)
- **Description:** Maximum size per uploaded file

##### `config.server.limits.fieldSize`

- **Type:** Number (bytes)
- **Default:** 1048576 (1MB)
- **Description:** Maximum size for form field values

##### `config.server.limits.parts`

- **Type:** Number
- **Default:** 10
- **Description:** Maximum number of multipart parts allowed

**Example:**

```yaml
config:
  server:
    limits:
      files: 3 # Allow max 3 files
      fileSize: 5242880 # 5MB per file
      fieldSize: 524288 # 512KB per field
      parts: 8 # Max 8 multipart parts
```

#### `config.api`

Endpoint-specific configuration mapping. Keys use the format `"METHOD /path"`.

##### `config.api.<endpoint>.output`

Controls output formatting for specific endpoints.

###### `config.api.<endpoint>.output.base64`

- **Type:** Boolean
- **Default:** false
- **Description:** Return response as base64 encoded data (useful for binary content)

##### `config.api.<endpoint>.response`

Customize HTTP response for specific endpoints.

###### `config.api.<endpoint>.response.status`

- **Type:** Number or Object
- **Default:** 200
- **Description:** HTTP status code or mapping based on CLI exit codes

###### `config.api.<endpoint>.response.headers`

- **Type:** Object
- **Description:** Custom HTTP headers to set in the response

**Example:**

```yaml
config:
  api:
    "GET /user/avatar":
      output:
        base64: true
      response:
        status: 200
        headers:
          Content-Type: "image/png"
          Cache-Control: "public, max-age=3600"

    "POST /data/process":
      response:
        status:
          0: 200 # Success
          1: 500 # General error
          2: 400 # Invalid input
        headers:
          Content-Type: "application/json"
```

#### `config.cors`

Cross-Origin Resource Sharing (CORS) configuration.

##### `config.cors.origin`

- **Type:** String, Array, or Boolean
- **Default:** Not set
- **Description:** Allowed origins for CORS requests

##### `config.cors.methods`

- **Type:** Array of strings
- **Default:** ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
- **Description:** Allowed HTTP methods

##### `config.cors.credentials`

- **Type:** Boolean
- **Default:** false
- **Description:** Allow credentials in CORS requests

**Example:**

```yaml
config:
  cors:
    origin:
      - "https://app.example.com"
      - "https://admin.example.com"
    methods: ["GET", "POST", "PUT", "DELETE"]
    credentials: true
```

### Environment Variables

The server respects the following environment variables:

- **`AUX4_API_PORT`**: Override the port (takes precedence over config file)
- **`AUX4_API_HOST`**: Override the host (default: 0.0.0.0)

### Examples

#### Basic Server Start

```bash
# Start with defaults (port 8080)
aux4 api start
```

#### With Configuration File

```bash
# Start with custom configuration
aux4 api start --config server.yaml
```

#### Override Port

```bash
# Start on port 3000
aux4 api start --port 3000

# With config file and port override
aux4 api start --config config.yaml --port 9000
```

#### Full Configuration Example

**config.yaml:**

```yaml
config:
  port: 8080

  # Server limits for file uploads
  server:
    limits:
      files: 3 # Max 3 files per upload
      fileSize: 5242880 # 5MB per file
      fieldSize: 262144 # 256KB per field
      parts: 6 # Max 6 multipart parts

  # Endpoint-specific configuration
  api:
    # Image endpoint returning base64
    "GET /image/generate":
      output:
        base64: true
      response:
        status: 201
        headers:
          Content-Type: "image/png"
          Cache-Control: "no-cache"

    # Data processing with custom status mapping
    "POST /data/validate":
      response:
        status:
          0: 200 # Valid data
          1: 422 # Validation failed
          2: 400 # Bad request
        headers:
          Content-Type: "application/json"

  # CORS configuration
  cors:
    origin: "*"
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    credentials: false
```

**Start command:**

```bash
aux4 api start --config config.yaml
```

### Server Behavior

#### API Endpoint Mapping

- `/api/user/info` → `aux4 user info`
- `/api/database/query?table=users` → `aux4 database query --table "users"`
- `/api/file/process` (POST with body) → `aux4 file process` + request body

#### Template Rendering

- If `views/user/info.p.hbs` exists, `/api/user/info` returns rendered HTML
- Otherwise returns JSON response from CLI command

#### Static File Serving

- Files in `static/` directory served at `/static/` URL prefix
- Example: `static/css/app.css` → `http://localhost:8080/static/css/app.css`

#### File Upload Processing

- Uploaded files saved to temporary directory
- Temporary directory path passed to CLI command via `--tmpDir` parameter
- Upload limits enforced based on configuration

### Exit Codes

- **0**: Server started successfully
- **1**: General error (configuration, port binding, etc.)
