# Self-hosting MailCorgi

This guide takes you from nothing to a MailCorgi install that sends newsletters from your own domain.
Pick a platform first:

- **Cloudflare Workers.** One click, no server to look after, and free for small lists. Every
  feature works except the SMTP provider.
- **Docker on a server.** Any Linux machine with 1 GB of memory. Works with every provider, including
  SMTP.

Both run the same code and offer the same features. To run MailCorgi as a paid service for other
people, read [Cloud mode](cloud-mode.md) after this guide.

## Run on Cloudflare

### Deploy

1. If you plan to upload images, enable R2 on your Cloudflare account once: open **R2 Object Storage**
   in the dashboard and finish the sign-up. R2 includes 10 GB of storage each month at no charge. To
   skip R2, deploy first, then delete the `r2_buckets` block from `wrangler.jsonc` in your new
   repository. Without R2, images are stored in chunks inside each account's Durable Object.
2. Click the **Deploy to Cloudflare** button in the [README](../README.md). Cloudflare copies the
   repository to your GitHub or GitLab account and creates the two Durable Object classes and the
   `mailcorgi-images` bucket.
3. Keep the build settings that Cloudflare fills in: build command `npm run build`, deploy command
   `npm run deploy`. No secrets are needed.
4. When the build finishes, open the `https://mailcorgi.<your-subdomain>.workers.dev` address and
   continue with [First run](#first-run).

Every push to your repository's main branch deploys again through Workers Builds.

To deploy from your own machine instead, clone the repository and run:

```sh
npm ci
npx wrangler login
npm run deploy
```

### Set variables

Open **Workers & Pages → mailcorgi → Settings → Variables and Secrets**. Add `ADMIN_EMAILS` with your
address. Add provider keys as secrets if you prefer them there over the admin console. The
[environment variable reference](#environment-variables) lists every name.

`wrangler.jsonc` sets `keep_vars`, so variables you add in the dashboard survive later deploys. Values
written in `wrangler.jsonc` itself win over the dashboard.

### Use your own domain for the app

1. In **Workers & Pages → mailcorgi → Settings → Domains & Routes**, add a **Custom domain** such as
   `news.example.com`. The domain's zone must be on the same Cloudflare account.
2. Add the variable `APP_URL=https://news.example.com`.

Without `APP_URL`, MailCorgi uses the address of the first sign-in.

### Workers Free limits

Workers Free costs nothing and fits a small newsletter. These limits apply per Cloudflare account:

| Limit | Workers Free | What uses it in MailCorgi |
|---|---|---|
| Requests | 100,000 a day | Every page view, open pixel, link click, signup and API call |
| CPU time | 10 ms per request | Each request to the Worker |
| Outbound requests | 50 per request | Each email sent is one; MailCorgi sends at most 40 per run with `WORKERS_PLAN=free` |
| Durable Object rows written | 100,000 a day | Each email writes several rows: queue, delivery, status, stats, opens and clicks |
| Durable Object rows read | 5 million a day | Lists, reports and sending |
| Durable Object storage | 5 GB in total | Contacts, issues, events and, without R2, images |

When a daily limit runs out, requests fail until 00:00 UTC.

**What list size fits.** The row-write limit is the one that binds. Measured on the Node build
(`npm run test:slow`), one sent email changes 11 rows (the queued delivery, its two status
updates, the contact, the event, the daily and campaign counters, usage, and the job rows); one
open changes 7, one click 8, one signup 6. Cloudflare also counts every index entry a write
touches, which roughly doubles those numbers, so budget about 22 row writes per email, 14 per open
and 16 per click:

- 100,000 ÷ 22 ≈ 4,500 emails a day with nobody opening.
- With a typical 40% open rate and 5% click rate, each email costs about 22 + 0.4 × 14 + 0.05 × 16 ≈ 28
  row writes, so about 3,500 emails a day.
- Outbound requests do not bind: each send run makes at most 40 (one settings read, one suppression
  check, one permit call and 37 emails), and runs repeat as often as the alarm fires.

So a Free install sends to about 3,500 subscribers a day. A larger list still works but a single
issue then takes several days to go out (a 10,000-subscriber issue takes three), and opens and
clicks arriving on top can push a day over the limit. Move to Workers Paid ($5 a month) when your
list passes about 3,000 subscribers, when you send more than once a day, or when the dashboard
shows errors about daily limits. After you upgrade, delete the `WORKERS_PLAN` line from
`wrangler.jsonc` in your repository so each send run can make up to 900 requests.

## Run with Docker

You need Docker Engine with the Compose plugin.

### Try it on your machine

```sh
git clone https://github.com/rizaardiyanto1412/mailcorgi.git
cd mailcorgi
docker compose up -d
```

Open <http://localhost:3000>. If port 3000 is taken, set `MAILCORGI_PORT=3080` in `.env` and run
`docker compose up -d` again.

### Run it on a server with HTTPS

1. Point an A record (and AAAA, if the server has IPv6) for your domain at the server.
2. Open ports 80 and 443 in the server's firewall.
3. Run the installer:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/rizaardiyanto1412/mailcorgi/main/scripts/install.sh | sh
   ```

   It checks for Docker, clones the repository into `./mailcorgi`, asks for your domain and your email
   address, writes `.env`, and starts the stack with the `https` profile.

To do the same by hand, create `.env` from [.env.example](../.env.example) with at least:

```sh
DOMAIN=news.example.com
APP_URL=https://news.example.com
ADMIN_EMAILS=you@example.com
```

Then start the app and Caddy:

```sh
docker compose --profile https up -d
```

Caddy gets a Let's Encrypt certificate for `DOMAIN` and redirects HTTP to HTTPS. It also gets
certificates on demand for custom website domains: before it asks Let's Encrypt, it calls
`/api/public/tls-check`, which approves only the app host and verified website hosts.

All data lives in the `mailcorgi-data` volume, mounted at `/data`: `control.db`, one database per
account in `accounts/`, uploaded images in `images/`, and `secret.key`. Every variable in `.env` is
passed to the app, so provider keys can live there too.

### Run without Docker

Node.js 22.13 or later works too:

```sh
npm ci
npm run build
DATA_DIR=/var/lib/mailcorgi APP_URL=https://news.example.com npm start
```

Put a reverse proxy with HTTPS in front of port 3000. The included `Caddyfile` works with
`mailcorgi:3000` replaced by `127.0.0.1:3000`.

## First run

1. Open your install's address. The first visitor creates the install admin with an email and a
   password. No email is sent, so this works before you set up a provider.
2. Create your first newsletter.
3. Open **Admin → Setup**. The checklist reads the live state of your install:
   - **Email provider configured**: Amazon SES, Resend or SMTP, with its keys.
   - **Test email sent**: a test through that provider succeeded.
   - **Delivery events received**: the provider's webhook reached MailCorgi. Not needed for SMTP.
   - **Sending turned on**: outbound email is not paused.
   - **Sending domain verified**: at least one domain passed its DNS check.

To let other people sign up, add their addresses to `ALLOWED_EMAILS` or to **Admin → Settings**, or
invite them to a newsletter from **Settings → Team**. Each person gets their own account. Outside
first-run setup, a new user proves their address: with the 6-digit code MailCorgi emails them, or with
the invite link. So configure an email provider before you let other people sign up. The same goes for
`ADMIN_EMAILS`: an address there gets admin rights only after it is confirmed this way.

Until you configure a provider, MailCorgi uses the `test` provider. It stores emails in the database
and sends nothing.

## Choose an email provider

| Provider | Cost | Bounce and complaint tracking | Platforms | Setup effort |
|---|---|---|---|---|
| Amazon SES | About $0.10 per 1,000 emails | Yes, through SNS | Both | Most steps, and AWS reviews your account before you can send to anyone |
| Resend | Free for 3,000 emails a month, then a monthly plan | Yes, through a webhook | Both | A few minutes |
| SMTP | Depends on the server | No | Docker and Node only | A few minutes |

Without bounce and complaint tracking, MailCorgi cannot remove bad addresses on its own, and your
sender reputation suffers sooner. Use SMTP only for small lists or for testing.

### Amazon SES

1. **Pick a region.** In the AWS console, choose the SES region closest to your readers, for example
   `eu-west-1`. Use the same region in every step.
2. **Create an IAM user.** In IAM, create a user for MailCorgi with this policy, then create an access
   key for it:

   ```json
   {
   	"Version": "2012-10-17",
   	"Statement": [{
   		"Effect": "Allow",
   		"Action": [
   			"ses:SendEmail",
   			"ses:SendRawEmail",
   			"ses:CreateEmailIdentity",
   			"ses:GetEmailIdentity",
   			"ses:DeleteEmailIdentity",
   			"ses:PutEmailIdentityMailFromAttributes"
   		],
   		"Resource": "*"
   	}]
   }
   ```

3. **Create an SNS topic.** In SNS, create a **Standard** topic, for example `mailcorgi-events`. Copy
   its ARN.
4. **Save the settings in MailCorgi.** In **Admin → Email**, choose **Amazon SES** and enter the
   region, the access key ID, the secret access key, the topic ARN, and a configuration set name you
   will create next, for example `mailcorgi`. Save. MailCorgi accepts notifications only from the
   saved topic, so save the ARN before the next steps.
5. **Subscribe MailCorgi to the topic.** In SNS, create a subscription on the topic. Choose the
   **HTTPS** protocol and use the SES webhook URL shown in **Admin → Email**, for example
   `https://news.example.com/hooks/ses`. MailCorgi confirms the subscription by itself. The
   subscription status changes to **Confirmed** within a minute.
6. **Create the configuration set.** In SES, create a configuration set with the name you saved. Add
   an event destination of type **Amazon SNS** that points at your topic, with these event types:
   **Deliveries**, **Hard bounces**, **Complaints** and **Delivery delays**.
7. **Ask for production access.** A new SES account is in the sandbox: it sends only to addresses you
   verified, and at most 200 a day. In SES, open **Account dashboard → Request production access** and
   describe your newsletter and how people sign up. AWS usually answers within a day.
8. **Send a test email** from **Admin → Email**. In the sandbox, send it to an address you verified in
   SES.

The SNS subscription needs a public HTTPS address. An install on `localhost` gets no events.

### Resend

1. In Resend, create an API key with **Full access**. MailCorgi needs it to add your sending domains.
2. In **Admin → Email**, choose **Resend**, paste the key and save.
3. In Resend, open **Webhooks** and add an endpoint with the Resend URL shown in **Admin → Email**, for
   example `https://news.example.com/hooks/resend`. Select the events `email.delivered`,
   `email.bounced`, `email.complained` and `email.delivery_delayed`.
4. Copy the webhook's signing secret into **Webhook signing secret** in **Admin → Email** and save.
5. Send a test email.

### SMTP

In **Admin → Email**, choose **SMTP** and enter the host, port, security mode (`tls` for port 465,
`starttls` for 587), user name and password. Send a test email. SMTP is not available on Cloudflare
Workers.

### System sender

Sign-in codes, invitations and alerts come from **System sender address** in **Admin → Email**. Use
an address on a domain your provider can send from. Without one, MailCorgi uses `mailcorgi@` plus your
app's host name.

## Verify a sending domain

Newsletters send only from a verified domain.

1. In **Settings → Sending domains**, add the domain you send from, for example `example.com`.
2. MailCorgi lists the DNS records to publish:
   - **Amazon SES**: three DKIM CNAME records, and an MX and an SPF TXT record for `mail.example.com`,
     the bounce domain.
   - **Resend**: the DKIM, SPF and return-path records Resend asks for.
   - **SMTP**: an SPF TXT record and a DMARC TXT record.

   MailCorgi also suggests a DMARC record when the domain has none. Publish it: Gmail and Yahoo expect
   one from bulk senders.
3. Add the records at your DNS host, then click **Check**. DNS changes can take up to an hour to show.
4. In **Settings → Newsletter**, choose the verified domain as the **Sender domain** and set the
   sender name and local part.

MailCorgi checks every domain again once a day. If a record disappears, the domain fails, sending
from it stops, and you get a notification.

## Turn sending on

Sending is on by default. **Admin → Email** has a **Sending enabled** switch that pauses all
outbound email for the install, and **Emails per second**, which sets the pace for the whole install.
Set it at or below your provider's limit. A new SES account allows 1 email per second until AWS
raises it.

## Custom website domains

A newsletter's website lives at `/n/<slug>` on the app host. Its owner can move it to a domain such as
`blog.example.com` with **Custom hostname** on the **Website** page. MailCorgi then shows two records:

- a CNAME from `blog.example.com` to the app host (or `WEBSITE_CNAME_TARGET` when set), and
- a TXT record at `_mailcorgi.blog.example.com` that proves ownership.

After the check passes, the platform must serve HTTPS for the new host.

- **Docker with the `https` profile**: nothing more to do. Caddy gets the certificate on the first
  visit.
- **Docker behind your own proxy**: route the host to MailCorgi and get a certificate for it. Caddy
  users can copy the `on_demand_tls` block from the included `Caddyfile`.
- **Cloudflare, host on your own Cloudflare account**: add the host as a **Custom domain** on the
  Worker, as in [Use your own domain for the app](#use-your-own-domain-for-the-app).
- **Cloudflare, hosts that belong to other people**: set up
  [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/)
  on your app's zone with the Worker as the fallback origin. Then set `CF_ZONE_ID` and `CF_API_TOKEN`
  (with **SSL and Certificates: Edit** on that zone). MailCorgi adds each verified host as a custom
  hostname and removes it when the owner changes it.

## Back up and restore

### Docker

Back up while MailCorgi runs. The script uses SQLite's online backup, so the copy is consistent:

```sh
docker compose exec mailcorgi node scripts/backup.mjs
```

It prints a folder such as `/data/backups/mailcorgi-2026-11-15T10-00-00-000Z` with every database,
`secret.key` and the images. Copy it off the server:

```sh
docker compose cp mailcorgi:/data/backups/mailcorgi-2026-11-15T10-00-00-000Z ./backups/
```

Keep `secret.key` with the databases. Saved provider keys are encrypted with it, and a backup without
it cannot read them.

To restore, stop the app, replace the data with the backup, and start it again:

```sh
docker compose stop mailcorgi
docker compose run --rm --no-deps -v "$PWD/backups/mailcorgi-2026-11-15T10-00-00-000Z:/restore:ro" \
	mailcorgi node scripts/backup.mjs restore /restore
docker compose start mailcorgi
```

The restore deletes everything in `/data` except earlier backups. Old backups stay in
`/data/backups`. Delete the ones you no longer need.

### Node without Docker

Run `DATA_DIR=/var/lib/mailcorgi node scripts/backup.mjs` for a backup, and
`node scripts/backup.mjs restore <folder>` with the app stopped to restore one.

### Cloudflare

Durable Objects keep their own history, and MailCorgi has no export for them yet. Cloudflare keeps
point-in-time recovery for SQLite Durable Objects for 30 days.

## Upgrade

### Docker

Back up first, then:

```sh
git pull
docker compose up -d --build
```

MailCorgi migrates its databases when it starts. Check `docker compose logs -f mailcorgi` for errors.

### Cloudflare

Your install runs from your own copy of the repository. To upgrade, pull the new MailCorgi version into
that copy, for example with **Sync fork** on GitHub, or:

```sh
git remote add upstream https://github.com/rizaardiyanto1412/mailcorgi.git
git pull upstream main
git push
```

Workers Builds deploys the push. Each Durable Object migrates its database the next time it starts.

## Environment variables

Every setting is optional. Variables marked **Both** work on Docker, Node and Cloudflare. Email and
billing variables override what **Admin → Email** and **Admin → Settings** store, and the admin
console shows those fields as set by the environment. On Cloudflare, add secrets with
`npx wrangler secret put NAME` or in the dashboard.

This table is generated from the code by `scripts/env-reference.ts`. A test fails when the code reads
a variable that is missing here.

<!-- env-reference:start (generated by scripts/env-reference.ts) -->

### Core

| Variable | Platform | Default | Description |
|---|---|---|---|
| `APP_URL` | Both | learned from the first sign-in | Public address of the install, for example `https://news.example.com`. Links in emails and secure cookies use it. |
| `CLOUD` | Both | off | `true` turns on cloud mode: open sign-up with emailed codes, plans, limits and billing. |
| `ADMIN_EMAILS` | Both |  | Comma-separated install admins. They may always sign up, see `/admin` and get admin alerts by email. Admin rights start only after the address is confirmed with an emailed code or an invite link. |
| `ALLOWED_EMAILS` | Both |  | Comma-separated addresses that may sign up on a self-hosted install with an emailed code. Adds to the list in **Admin → Settings**. |
| `SIGNUP_MODE` | Both | open in cloud mode, allowlist otherwise | `closed`, `allowlist` or `open`. Overrides the setting in **Admin → Settings**. |
| `APP_SECRET` (secret) | Both | generated on first boot | Master key, at least 16 characters. Leave unset unless you must move the key: changing it signs everyone out and makes stored credentials unreadable. |
| `IMAGES_PUBLIC_URL` | Both | `APP_URL/img` | Origin that serves uploaded images, when you put a CDN or a public R2 domain in front of them. |
| `SEND_BATCH_SIZE` | Both | 100 | Most emails one send run claims. The platform limit can lower it. |
| `TURNSTILE_SITE_KEY` | Both |  | Cloudflare Turnstile site key for signup forms. Needs `TURNSTILE_SECRET_KEY` too. |
| `TURNSTILE_SECRET_KEY` (secret) | Both |  | Cloudflare Turnstile secret key for signup forms. |

### Email

| Variable | Platform | Default | Description |
|---|---|---|---|
| `EMAIL_PROVIDER` | Both | test | `ses`, `resend`, `smtp` or `test`. `test` keeps every email in a local outbox. `smtp` works on Node only. |
| `EMAIL_FROM` | Both | `mailcorgi@` + the app host | Sender address for system emails: sign-in codes, invitations, alerts and test emails. |
| `EMAIL_FROM_NAME` | Both | MailCorgi | Sender name for system emails. |
| `SENDING_ENABLED` | Both | true | `false` pauses all outbound email for the install. |
| `SEND_RATE_PER_SECOND` | Both | 10 | Install-wide sending rate. Match it to your provider quota. |
| `SES_REGION` | Both |  | AWS region of your SES account, for example `eu-west-1`. |
| `SES_ACCESS_KEY_ID` (secret) | Both |  | Access key ID of the IAM user that sends through SES. |
| `SES_SECRET_ACCESS_KEY` (secret) | Both |  | Secret access key of that IAM user. |
| `SES_CONFIGURATION_SET` | Both |  | SES configuration set that publishes delivery events to SNS. |
| `SES_SNS_TOPIC_ARN` | Both |  | The only SNS topic whose notifications `/hooks/ses` accepts. |
| `RESEND_API_KEY` (secret) | Both |  | Resend API key with sending and domain access. |
| `RESEND_WEBHOOK_SECRET` (secret) | Both |  | Signing secret of the Resend webhook that points at `/hooks/resend`. |
| `SMTP_HOST` | Node |  | SMTP server host name. |
| `SMTP_PORT` | Node |  | SMTP port, usually 465 (`tls`) or 587 (`starttls`). |
| `SMTP_SECURITY` | Node |  | `tls`, `starttls` or `none`. |
| `SMTP_USER` (secret) | Node |  | SMTP user name. |
| `SMTP_PASSWORD` (secret) | Node |  | SMTP password. |

### Billing (cloud mode)

| Variable | Platform | Default | Description |
|---|---|---|---|
| `BILLING_PROVIDER` | Both |  | `stripe` or `polar`. |
| `STRIPE_SECRET_KEY` (secret) | Both |  | Stripe secret or restricted key. |
| `STRIPE_WEBHOOK_SECRET` (secret) | Both |  | Signing secret of the Stripe webhook that points at `/hooks/stripe`. |
| `POLAR_ACCESS_TOKEN` (secret) | Both |  | Polar organization access token. |
| `POLAR_WEBHOOK_SECRET` (secret) | Both |  | Secret of the Polar webhook that points at `/hooks/polar`. |
| `POLAR_PRODUCTS` | Both |  | JSON object from `<plan>_<monthly\|yearly>` to Polar product IDs. |

### Websites

| Variable | Platform | Default | Description |
|---|---|---|---|
| `WEBSITE_CNAME_TARGET` | Both | the `APP_URL` host | Host name that custom website domains point their CNAME at. |
| `CF_API_TOKEN` (secret) | Cloudflare |  | Cloudflare API token with SSL and Certificates edit access. With `CF_ZONE_ID`, MailCorgi adds verified website hosts to Cloudflare for SaaS itself. |
| `CF_ZONE_ID` | Cloudflare |  | ID of the zone that holds your Cloudflare for SaaS setup. |

### Platform

| Variable | Platform | Default | Description |
|---|---|---|---|
| `WORKERS_PLAN` | Cloudflare | free in `wrangler.jsonc` | `free` keeps each run under 40 outbound requests, inside the Workers Free limit of 50. On Workers Paid, delete the line from `wrangler.jsonc` to allow 900 per run. |
| `PORT` | Node | 3000 | HTTP port. |
| `HOST` | Node | 0.0.0.0 | Interface to listen on. |
| `DATA_DIR` | Node | `./data` (`/data` in Docker) | Folder for `control.db`, `accounts/*.db`, `images/` and `secret.key`. |
| `WEB_DIR` | Node | `web/dist` | Folder with the built web app. |
| `NODE_ENV` | Node | `production` in Docker | `production` turns off every development-only switch, such as `MC_TEST_DNS`. |
| `MC_TEST_DNS` | Both |  | Development and tests only: a JSON object of canned DNS answers keyed `TYPE:name`, such as `{"TXT:example.com":["v=spf1 mx ~all"]}`. It replaces real lookups, turns on the dev outbox endpoints for install admins, and is ignored when `NODE_ENV` is `production` or the Worker is deployed. Never set it on a real install. |

<!-- env-reference:end -->

## Troubleshooting

**Port 3000 is already in use.** Set `MAILCORGI_PORT` in `.env` to a free port and run
`docker compose up -d`.

**Caddy cannot get a certificate.** Check that the domain's A record points at the server, that ports
80 and 443 are open, and that `DOMAIN` in `.env` has no `https://` prefix. Run
`docker compose logs caddy` for the reason.

**The SNS subscription stays pending.** Save the topic ARN in **Admin → Email** first, then ask SNS to
resend the confirmation (**Request confirmation** on the subscription). The webhook URL must be public
HTTPS.

**The test email fails with SES.** In the sandbox, the recipient must be verified in SES. Check that
the access key belongs to the region you entered.

**Campaigns do not send.** Open **Admin → Setup**. Sending must be turned on, the newsletter must use a
verified domain, and the account must not be blocked. MailCorgi pauses a campaign whose bounces or
complaints cross the safe rate. Check its report and clean the list before you resume it.

**Cloudflare deploy fails with an R2 error.** Enable R2 on the account, or delete the `r2_buckets`
block from `wrangler.jsonc` and push again.

**Cloudflare requests fail late in the day.** You reached a Workers Free daily limit. It resets at
00:00 UTC. Move to Workers Paid if it happens often.

**Saved provider keys stopped working after a move.** The new install has a different `secret.key` or
`APP_SECRET`. Restore the old one, or enter the keys again in **Admin → Email**.
