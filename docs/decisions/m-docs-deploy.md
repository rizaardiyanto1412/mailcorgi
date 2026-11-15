# Unit M: docs and deploy

## WORKERS_PLAN defaults to free in wrangler.jsonc

Contract: section 3.2 says `platform.limits.subrequestsPerRun` is 40 on Workers Free and 900
otherwise. The Worker reads the plan from `WORKERS_PLAN` and assumes Workers Paid when it is unset.

Deviation: `wrangler.jsonc` sets `"WORKERS_PLAN": "free"`, and `keep_vars` is on.

Why: Deploy to Cloudflare puts most new installs on Workers Free. Assuming Paid there makes a send run
try 900 outbound requests and fail at the 50-request limit. On Paid, the operator deletes the line, as
the self-hosting guide says. `keep_vars` keeps variables set in the dashboard (such as `ADMIN_EMAILS`)
across deploys from Git.

## Setup checklist reads account stores

Contract: section 6 lists no setup module.

Deviation: a control module `setup` (action `setup.checklist`, install admins only) and an account
module `setup` (RPC `account.setupStatus`) are added. The account RPC reads through new exports
`countVerifiedDomains` (domains) and `providerEventStats` (tracking). `install.email.test` records the
provider of the last successful test in the `_test_email` install setting.

Why: the brief asks for a checklist whose items check real state. Verified domains and provider
events live in account stores, so the control store asks up to 50 of them and stops once it has seen
both.

## Docker Compose host port variable

Contract: section 9 describes compose without naming variables.

Deviation: the host port is `MAILCORGI_PORT` (not `PORT`), and the container always listens on 3000.
Compose also reads `.env` into the app with `env_file`.

Why: `PORT` is the app's own listen port in the environment reference, and `.env` passed into the
container would otherwise move the app off the port that the healthcheck, Caddy and the port mapping
use.

## Backups use a script in the image

Contract: section 9 names no backup tool.

Deviation: `scripts/backup.mjs` ships in the image. It copies each database with `node:sqlite`'s online
backup and copies `secret.key` and `images/`. Restore replaces `DATA_DIR` except `backups/`.

Why: the image has no `sqlite3` binary, and Node 24 has the backup API built in. No dependency added.
