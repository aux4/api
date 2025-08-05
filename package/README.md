# Aux4 API Server

A flexible API server built on Fastify that integrates with the Aux4 CLI ecosystem, providing both RESTful API endpoints and server-side rendering capabilities using Handlebars templates.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI Integration](#cli-integration)
- [Template System](#template-system)
- [Static File Serving](#static-file-serving)
- [Error Handling](#error-handling)
- [File Upload](#file-upload)
- [Examples](#examples)
- [API Reference](#api-reference)

## Installation

```bash
npm install @aux4/api
```

## Quick Start

### Basic Usage

Start the server with default settings:

```bash
aux4 api start
```

### With Configuration

Use a custom configuration file:

```bash
aux4 api start --config config.yaml
```

The server will start on port 8080 by default, or use the port specified in your configuration.

## Configuration

Create a `config.yaml` file to customize server behavior:

```yaml
config:
  port: 8080
  server:
    limits:
      files: 2          # Maximum number of files in multipart uploads
      fileSize: 10485760 # Maximum file size in bytes (10MB)
      fieldSize: 1048576 # Maximum field size in bytes (1MB)
  api:
    "GET /me":
      output:
        base64: true
      response:
        status: 201
        headers:
          Content-Type: image/png
  cors:
    origin: "*"
    methods: ["GET", "POST", "PUT", "DELETE"]
```

### Configuration Options

- **port**: Server port (default: 8080)
- **server.limits**: File upload limits
  - **files**: Maximum number of files per upload
  - **fileSize**: Maximum individual file size
  - **fieldSize**: Maximum form field size
- **api**: Endpoint-specific configurations
- **cors**: CORS configuration

## CLI Integration

The API server exposes Aux4 CLI commands through HTTP endpoints using the pattern `/api/{command}`.

### How It Works

API endpoints map directly to CLI commands:

- **Endpoint**: `/api/user/profile`
- **Executes**: `aux4 user profile`

### Example API Calls

```bash
# Execute: aux4 user info --name 'Alice' --age '30'
curl "http://localhost:8080/api/user/info?name=Alice&age=30"

# Execute: aux4 database query --table 'users'
curl "http://localhost:8080/api/database/query?table=users"

# Execute: aux4 system status
curl "http://localhost:8080/api/system/status"
```

### HTTP Methods

All HTTP methods are supported:

```bash
# GET request
curl "http://localhost:8080/api/user/list"

# POST request with JSON body
curl -X POST "http://localhost:8080/api/user/create" \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'

# PUT request
curl -X PUT "http://localhost:8080/api/user/update?id=123" \
  -H "Content-Type: application/json" \
  -d '{"name": "Jane"}'
```

### Response Formats

Responses are returned as JSON by default. For binary data, configure `base64` output:

```yaml
api:
  "GET /image/generate":
    output:
      base64: true
    response:
      headers:
        Content-Type: image/png
```

## Template System

The server includes a powerful Handlebars-based templating system for server-side rendering.

### Directory Structure

```
views/
├── layouts/
│   └── main.hbs           # Main layout template
├── partials/
│   └── header.hbs         # Reusable partial templates
├── pages/
│   ├── home.hbs           # Page templates
│   └── dashboard.hbs
└── error.p.hbs            # Error page template
```

### Layout Templates

Create a main layout in `views/layouts/main.hbs`:

```html
<!DOCTYPE html>
<html>
<head>
    <title>{{title}}</title>
    <script src="https://unpkg.com/htmx.org@1.9.9"></script>
</head>
<body>
    {{> header}}
    <main>
        {{{body}}}
    </main>
</body>
</html>
```

### Partial Templates

Partials are reusable template components. Files ending with `.p.hbs` are automatically registered as partials.

Create `views/partials/header.hbs`:

```html
<header>
    <nav>
        <a href="/">Home</a>
        <a href="/dashboard">Dashboard</a>
        <a href="/profile">Profile</a>
    </nav>
</header>
```

Use partials in templates:

```html
{{> header}}
<div class="content">
    <h1>Welcome {{user.name}}</h1>
</div>
```

### Dynamic Templates for API Endpoints

API endpoints can render templates by creating corresponding `.p.hbs` files:

**Example**: `/api/user/profile` → `views/user/profile.p.hbs`

```html
<!-- views/user/profile.p.hbs -->
<div class="profile">
    <h2>{{name}}</h2>
    <p>Email: {{email}}</p>
    <p>Role: {{role}}</p>
</div>
```

When an API endpoint has a corresponding template, it will render the template instead of returning JSON.

### Template Data

Templates receive data from CLI command output. If the output is JSON, it's parsed and made available as template variables:

```bash
# CLI command returns: {"name": "John", "email": "john@example.com", "posts": 42}
aux4 user info --id 123
```

Template can access:

```html
<h1>{{name}}</h1>
<p>{{email}}</p>
<p>Posts: {{posts}}</p>
```

## Static File Serving

Static files are served from the `static/` directory at the `/static/` URL prefix.

### Setup

1. Create a `static/` directory in your project root
2. Add your static assets (CSS, JS, images, etc.)

### Directory Structure

```
static/
├── css/
│   └── styles.css
├── js/
│   └── app.js
├── images/
│   └── logo.png
└── uploads/
    └── documents/
```

### Accessing Static Files

```html
<!-- In your templates -->
<link rel="stylesheet" href="/static/css/styles.css">
<script src="/static/js/app.js"></script>
<img src="/static/images/logo.png" alt="Logo">
```

## Error Handling

### Custom Error Pages

Create `views/error.p.hbs` to customize error pages:

```html
<div class="error-container">
    <h1>Error {{statusCode}}</h1>
    <p class="error-message">{{message}}</p>
    <a href="/" class="back-link">Go Home</a>
</div>
```

### Error Template Data

Error templates receive:
- `statusCode`: HTTP status code
- `message`: Error message
- `error`: Error type

### API vs Template Errors

- **API requests** (with `Accept: application/json`): Return JSON error responses
- **Browser requests**: Render the error template if available

### Example Error Response

**JSON Response**:
```json
{
  "error": {
    "message": "User not found",
    "status": 404
  }
}
```

**Template Response**: Renders `error.p.hbs` with error data

## File Upload

The server supports multipart file uploads with configurable limits.

### Configuration

```yaml
server:
  limits:
    files: 5           # Max files per request
    fileSize: 10485760 # 10MB per file
    fieldSize: 1048576 # 1MB field size
```

### Upload Examples

**HTML Form**:
```html
<form action="/api/file/upload" method="POST" enctype="multipart/form-data">
    <input type="file" name="document" multiple>
    <input type="text" name="category" value="reports">
    <button type="submit">Upload</button>
</form>
```

**JavaScript/Fetch**:
```javascript
const formData = new FormData();
formData.append('document', file);
formData.append('category', 'reports');

fetch('/api/file/upload', {
    method: 'POST',
    body: formData
});
```

### File Processing

Uploaded files are accessible in CLI commands via the `--tmpDir` parameter:

```bash
# Files saved to temporary directory passed as --tmpDir
aux4 file process --category "reports" --tmpDir "/tmp/upload-xyz"
```

## Examples

### Basic Web Application

**Structure**:
```
project/
├── config.yaml
├── static/
│   └── css/
│       └── app.css
└── views/
    ├── layouts/
    │   └── main.hbs
    ├── partials/
    │   └── navigation.hbs
    ├── home.hbs
    └── error.p.hbs
```

**config.yaml**:
```yaml
config:
  port: 3000
  cors:
    origin: "*"
```

**Start server**:
```bash
aux4 api start --config config.yaml
```

### API with Templates

**Create user info endpoint template** (`views/user/info.p.hbs`):
```html
<div class="user-card">
    <h2>{{name}}</h2>
    <div class="details">
        <p><strong>Email:</strong> {{email}}</p>
        <p><strong>Department:</strong> {{department}}</p>
        <p><strong>Status:</strong> {{status}}</p>
    </div>
</div>
```

**API calls**:
```bash
# JSON response
curl -H "Accept: application/json" "http://localhost:3000/api/user/info?id=123"

# HTML template response
curl -H "Accept: text/html" "http://localhost:3000/api/user/info?id=123"
```

### File Upload with Processing

**Upload form template** (`views/upload.hbs`):
```html
<form action="/api/document/process" method="POST" enctype="multipart/form-data">
    <div class="upload-area">
        <input type="file" name="documents" multiple accept=".pdf,.doc,.docx">
        <input type="text" name="project" placeholder="Project name">
    </div>
    <button type="submit">Process Documents</button>
</form>
```

**Backend CLI command**:
```bash
# Processes uploaded files from tmpDir
aux4 document process --project "ProjectX" --tmpDir "/tmp/upload-abc"
```

## API Reference

### Endpoints

| Pattern | Description | CLI Mapping |
|---------|-------------|-------------|
| `GET /api/{path}` | Execute CLI command | `aux4 {path}` |
| `POST /api/{path}` | Execute with body data | `aux4 {path}` + body |
| `PUT /api/{path}` | Update operation | `aux4 {path}` + body |
| `DELETE /api/{path}` | Delete operation | `aux4 {path}` |

### Query Parameters

All query parameters are passed as CLI flags:
- `?name=John&age=30` → `--name "John" --age "30"`

### Response Status Codes

- **200**: Successful execution (exit code 0)
- **403**: Permission denied (exit code 126)
- **404**: Command not found (exit code 127)
- **413**: Payload too large (file upload limit exceeded)
- **500**: Execution error (exit code 1)

### Special Headers

**Request**:
- `Accept: application/json` - Force JSON response
- `Accept: text/html` - Force template rendering
- `Content-Type: multipart/form-data` - File upload

**Response**:
- `Content-Type: application/json` - JSON response
- `Content-Type: text/html` - Template response
- `Content-Encoding: base64` - Base64 encoded response

### Environment Variables

- `AUX4_API_PORT`: Override default port
- `AUX4_API_HOST`: Override default host (0.0.0.0)

This comprehensive API server provides a powerful bridge between your Aux4 CLI commands and web interfaces, supporting both programmatic API access and rich web applications with server-side rendering.
