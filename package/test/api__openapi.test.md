# api openapi

```file:config.yaml
config:
  info:
    title: Shop API
    version: 3.0.0
  api:
    "GET /items":
      command: aux4 shop item list
    "GET /items/{id}":
      command: aux4 shop item get
    "POST /items":
      command: aux4 shop item create
    "GET /search":
      command: aux4 shop item search
      openapi:
        summary: Search items
        parameters:
          - name: q
            in: query
            required: true
            schema:
              type: string
        responses:
          "200":
            description: Matching items
          "404":
            description: No matches
```

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "shop",
          "execute": [
            "profile:shop"
          ],
          "help": {
            "text": "Shop fixture"
          }
        }
      ]
    },
    {
      "name": "shop",
      "commands": [
        {
          "name": "item",
          "execute": [
            "profile:shop:item"
          ],
          "help": {
            "text": "Item commands"
          }
        }
      ]
    },
    {
      "name": "shop:item",
      "commands": [
        {
          "name": "list",
          "execute": [
            "log:category is ${query.category}"
          ],
          "help": {
            "text": "List items"
          }
        },
        {
          "name": "get",
          "execute": [
            "log:reading ${params.id}"
          ],
          "help": {
            "text": "Get one item"
          }
        },
        {
          "name": "create",
          "execute": [
            "set:data=json:${body}",
            "set:payload=object(data.name:name, data.price:price)",
            "echo value(payload)"
          ],
          "help": {
            "text": "Create item"
          }
        },
        {
          "name": "search",
          "execute": [
            "log:searching"
          ],
          "help": {
            "text": "Search items"
          }
        }
      ]
    }
  ]
}
```

## document envelope

### should be a valid OpenAPI 3 document with info from config

```execute
aux4 api openapi --configFile config.yaml | jq -c '{openapi, info}'
```

```expect
{"openapi":"3.0.3","info":{"title":"Shop API","version":"3.0.0"}}
```

## routes and paths

### should generate a path item per route key

```execute
aux4 api openapi --configFile config.yaml | jq -r '.paths | keys | sort | join(",")'
```

```expect
/items,/items/{id},/search
```

### should tag operations by first path segment

```execute
aux4 api openapi --configFile config.yaml | jq -r '.paths["/items"].get.tags[0]'
```

```expect
items
```

### should derive operationId from the command

```execute
aux4 api openapi --configFile config.yaml | jq -r '.paths["/items"].get.operationId'
```

```expect
aux4_shop_item_list
```

## path parameters

### should turn {id} into a required string path parameter

```execute
aux4 api openapi --configFile config.yaml | jq -c '.paths["/items/{id}"].get.parameters'
```

```expect:json
[
  {
    "name": "id",
    "in": "path",
    "required": true,
    "schema": {
      "type": "string"
    }
  }
]
```

## best-effort parameter inference

### should infer query params from ${query.X} in the command execute

```execute
aux4 api openapi --configFile config.yaml | jq -c '.paths["/items"].get.parameters'
```

```expect:json
[
  {
    "name": "category",
    "in": "query",
    "required": false,
    "schema": {
      "type": "string"
    }
  }
]
```

### should infer requestBody props from body aliases in the command execute

```execute
aux4 api openapi --configFile config.yaml | jq -r '.paths["/items"].post.requestBody.content["application/json"].schema.properties | keys | sort | join(",")'
```

```expect
name,price
```

## openapi annotation overlay

### should overlay annotation parameters and responses

```execute
aux4 api openapi --configFile config.yaml | jq -c '.paths["/search"].get | {summary, parameters, responses: (.responses | keys)}'
```

```expect:json
{
  "summary": "Search items",
  "parameters": [
    {
      "name": "q",
      "in": "query",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": [
    "200",
    "404"
  ]
}
```

## yaml output

### should emit yaml when format is yaml

```execute
aux4 api openapi --configFile config.yaml --format yaml | head -1
```

```expect
openapi: 3.0.3
```

## errors

### should fail when the config file does not exist

```execute
aux4 api openapi --configFile does-not-exist.yaml
```

```error:partial
Config file not found: does-not-exist.yaml
```
