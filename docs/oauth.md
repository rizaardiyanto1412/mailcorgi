# OAuth for MCP clients

MCP clients such as Claude, Cursor and VS Code can connect to MailCorgi with only the server URL. The
client opens MailCorgi in a browser, you sign in and approve it, and the client gets a token. No API key
is pasted. MailCorgi follows the MCP Authorization specification (2025-06-18).

API keys keep working on `/mcp` and the REST API. OAuth tokens work on `/mcp` only.

## Connect a client

1. In the client, add the MCP server `https://<your app host>/mcp`.
2. The client opens MailCorgi. Sign in if you need to.
3. Pick the account and the access, then click **Approve**.

Only an account owner can approve. **Settings → Connected apps** lists approved clients and disconnects
them.

## Endpoints

Every app host is its own authorization server: the `APP_URL` host and each `APP_HOSTS` alias. The issuer
is the host's public origin. A token works only on the host that issued it.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (also `…/mcp`) | Protected resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic client registration (RFC 7591), JSON |
| `GET /oauth/authorize` | Sign-in and consent page |
| `POST /oauth/token` | Code and refresh token exchange, form-encoded or JSON |
| `POST /oauth/revoke` | Token revocation (RFC 7009) |

`/mcp` without a valid token answers 401 with
`WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.
The discovery, registration, token and revocation endpoints send `Access-Control-Allow-Origin: *`.

## Scopes

| Scope | Same as | Allows |
|---|---|---|
| `mail:read` | a read-only API key | Every MCP tool that only reads |
| `mail:full` | a full API key | Every MCP tool, including changes and sending |

A request without a scope lets you choose on the consent screen; read-only is the default. A client that
asks for `mail:read` cannot get `mail:full`.

## Rules

- Authorization code flow only, with PKCE `S256`. `plain` and the implicit flow are refused.
- Redirect URIs: https, http on `localhost`, `127.0.0.1` or `[::1]` (any port at request time), or an
  app scheme such as `cursor://`. Exact match otherwise.
- `resource` (RFC 8707), when sent, must be the host's `/mcp` URL.
- Codes are single use and last 10 minutes. Using a code twice revokes what it issued.
- Access tokens last one hour. Refresh tokens last 30 days and rotate on every use. Reusing an old
  refresh token ends the whole connection.
- Public clients (`token_endpoint_auth_method: none`) are the normal case. A client that registers with
  `client_secret_post` must send its secret to the token and revocation endpoints.
- Each connection allows 600 requests a minute on `/mcp`, like an API key.
- MailCorgi stores only SHA-256 hashes of codes, tokens and client secrets, and never logs them.

## Why not `@cloudflare/workers-oauth-provider`

MailCorgi also runs on Node and Docker, and keeps all state in its SQLite stores. That library wraps the
whole Worker and keeps its state in Workers KV, so it would work on one platform only. The flow here
lives in the control store (clients, consent) and the account stores (codes and tokens), on both platforms.
