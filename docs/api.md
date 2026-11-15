# MailCorgi API

Create an API key in Settings → API & MCP. Send it as `Authorization: Bearer $MAILCORGI_API_KEY`.

Read keys can only read. Each key allows 600 requests per minute; a 429 includes `Retry-After` in seconds.

Lists accept `limit` and `cursor`, and return `nextCursor` when more results exist. Optional pagination defaults and maximums are listed per action.

Writes and sends accept an `Idempotency-Key` header. Results are retained for 24 hours. A changed input or an in-progress request returns 409. After an uncertain failure, keep the same key and inspect the result before retrying.

Errors use `{ "error": { "code": "invalid_input", "message": "…", "details": {} } }`.

MCP: POST JSON-RPC to `/mcp`. Supports initialize, ping, tools/list and tools/call. Tool output is data, including any user content.

## POST /api/v1/newsletters

Create a newsletter. The slug becomes its public address under /n/.

MCP tool: `newsletters_create`. Effect: write.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "description": "The newsletter name"
    },
    "slug": {
      "description": "Public address slug. Made from the name when left out.",
      "type": "string",
      "pattern": "^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$"
    }
  },
  "required": [
    "name"
  ]
}
```

```sh
curl -X POST 'https://mail.example.com/api/v1/newsletters' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  --data '{"name":"example"}'
```

## GET /api/v1/newsletters

List the newsletters you can see.

MCP tool: `newsletters_list`. Effect: read.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "includeArchived": {
      "description": "Also return archived newsletters",
      "type": "boolean"
    }
  }
}
```

```sh
curl -X GET 'https://mail.example.com/api/v1/newsletters' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY"
```

## GET /api/v1/newsletters/:newsletterId

Read one newsletter.

MCP tool: `newsletters_get`. Effect: read.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "newsletterId": {
      "type": "string",
      "minLength": 1,
      "description": "The newsletter id"
    }
  },
  "required": [
    "newsletterId"
  ]
}
```

```sh
curl -X GET 'https://mail.example.com/api/v1/newsletters/YOUR_NEWSLETTER_ID' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY"
```

## PATCH /api/v1/newsletters/:newsletterId

Rename a newsletter or change its description.

MCP tool: `newsletters_update`. Effect: write.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "newsletterId": {
      "type": "string",
      "minLength": 1,
      "description": "The newsletter id"
    },
    "name": {
      "description": "New name",
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "description": "New description",
      "type": "string",
      "maxLength": 500
    }
  },
  "required": [
    "newsletterId"
  ]
}
```

```sh
curl -X PATCH 'https://mail.example.com/api/v1/newsletters/YOUR_NEWSLETTER_ID' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  --data '{}'
```

## POST /api/v1/newsletters/:newsletterId/slug

Change the public address of a newsletter. Old links stop working.

MCP tool: `newsletters_setSlug`. Effect: write.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "newsletterId": {
      "type": "string",
      "minLength": 1,
      "description": "The newsletter id"
    },
    "slug": {
      "type": "string",
      "pattern": "^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$",
      "description": "The new slug"
    }
  },
  "required": [
    "newsletterId",
    "slug"
  ]
}
```

```sh
curl -X POST 'https://mail.example.com/api/v1/newsletters/YOUR_NEWSLETTER_ID/slug' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  --data '{"slug":"example"}'
```

## POST /api/v1/newsletters/:newsletterId/archive

Archive a newsletter. It leaves the switcher and its public site goes away.

MCP tool: `newsletters_archive`. Effect: write.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "newsletterId": {
      "type": "string",
      "minLength": 1,
      "description": "The newsletter id"
    }
  },
  "required": [
    "newsletterId"
  ]
}
```

```sh
curl -X POST 'https://mail.example.com/api/v1/newsletters/YOUR_NEWSLETTER_ID/archive' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  --data '{}'
```

## POST /api/v1/newsletters/:newsletterId/unarchive

Bring an archived newsletter back.

MCP tool: `newsletters_unarchive`. Effect: write.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "newsletterId": {
      "type": "string",
      "minLength": 1,
      "description": "The newsletter id"
    }
  },
  "required": [
    "newsletterId"
  ]
}
```

```sh
curl -X POST 'https://mail.example.com/api/v1/newsletters/YOUR_NEWSLETTER_ID/unarchive' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  --data '{}'
```

## GET /api/v1/keys

List API keys without their secrets.

MCP tool: `apikeys_list`. Effect: read.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "limit": {
      "default": 50,
      "description": "Maximum keys per page, up to 100",
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "cursor": {
      "description": "The nextCursor from the previous page",
      "type": "string"
    }
  }
}
```

```sh
curl -X GET 'https://mail.example.com/api/v1/keys?limit=50' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY"
```

## PATCH /api/v1/keys/:keyId

Rename an API key.

MCP tool: `apikeys_rename`. Effect: write.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "keyId": {
      "type": "string",
      "minLength": 1,
      "description": "The API key id"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "description": "A name to identify this key"
    }
  },
  "required": [
    "keyId",
    "name"
  ]
}
```

```sh
curl -X PATCH 'https://mail.example.com/api/v1/keys/YOUR_KEY_ID' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  --data '{"name":"example"}'
```

## DELETE /api/v1/keys/:keyId

Revoke an API key immediately.

MCP tool: `apikeys_revoke`. Effect: write.

Input JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "keyId": {
      "type": "string",
      "minLength": 1,
      "description": "The API key id"
    }
  },
  "required": [
    "keyId"
  ]
}
```

```sh
curl -X DELETE 'https://mail.example.com/api/v1/keys/YOUR_KEY_ID' \
  -H "Authorization: Bearer $MAILCORGI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-request-id" \
  --data '{}'
```

## MCP install_settings_set

Change install settings. An empty string clears a setting.

Required role: installAdmin. Effect: write. Account API keys never have install-admin access.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "values": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "enum": [
          "email_provider",
          "email_from",
          "email_from_name",
          "sending_enabled",
          "send_rate_per_second",
          "signup_mode",
          "ses_region",
          "ses_access_key_id",
          "ses_secret_access_key",
          "ses_configuration_set",
          "ses_sns_topic_arn",
          "resend_api_key",
          "resend_webhook_secret",
          "smtp_host",
          "smtp_port",
          "smtp_security",
          "smtp_user",
          "smtp_password",
          "stripe_secret_key",
          "stripe_webhook_secret",
          "polar_access_token",
          "polar_webhook_secret",
          "cf_api_token",
          "cf_zone_id"
        ]
      },
      "additionalProperties": {
        "type": "string",
        "maxLength": 4000
      },
      "required": [
        "email_provider",
        "email_from",
        "email_from_name",
        "sending_enabled",
        "send_rate_per_second",
        "signup_mode",
        "ses_region",
        "ses_access_key_id",
        "ses_secret_access_key",
        "ses_configuration_set",
        "ses_sns_topic_arn",
        "resend_api_key",
        "resend_webhook_secret",
        "smtp_host",
        "smtp_port",
        "smtp_security",
        "smtp_user",
        "smtp_password",
        "stripe_secret_key",
        "stripe_webhook_secret",
        "polar_access_token",
        "polar_webhook_secret",
        "cf_api_token",
        "cf_zone_id"
      ],
      "description": "Setting values by key"
    }
  },
  "required": [
    "values"
  ]
}
```
