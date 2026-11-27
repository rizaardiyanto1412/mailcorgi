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

To serve the app on a second domain, add it as another custom domain and list it in `APP_HOSTS`, for
example `APP_HOSTS=news.example.org`. Both hosts then show the app. Links in emails keep using
`APP_URL`, and you sign in on each host separately. A host that is in neither variable and is not a
verified newsletter website answers 404.

To move to a new domain, set `APP_URL` to the new one and put the old host in `APP_HOSTS`. Then update
the webhook addresses at your providers, because they use `APP_URL`: `/hooks/ses` (the SNS
subscription), `/hooks/resend`, `/hooks/postshiba`, and `/hooks/stripe` or `/hooks/polar` in cloud mode. The old addresses
keep working while the old host is in `APP_HOSTS`.

### Workers Free limits

Workers Free costs nothing and fits a small newsletter. These limits apply per Cloudflare account:

| Limit | Workers Free | What uses it in MailCorgi |
|---|---|---|
| Requests | 100,000 a day | Every page view, open pixel, link click, signup and API call |
| CPU time | 10 ms per request | Each request to the Worker |
| Outbound requests | 50 per request | Each email sent is one; MailCorgi sends at most 40 per run with `WORKERS_PLAN=free` |
| Durable Object rows written | 100,000 a day, shared by every Durable Object app on the account | About 10 per email sent, 4 per first open, 8 per click, 13 per signup, 11 per imported contact; reads write nothing |
| Durable Object rows read | 5 million a day | Lists, reports and sending |
| Durable Object storage | 5 GB in total | Contacts, issues, events and, without R2, images |

When a daily limit runs out, requests fail until 00:00 UTC.

**What list size fits.** The row-write limit is the one that binds, and it is shared by every
Durable Object app on your Cloudflare account, not just MailCorgi. `npm run budget` measures rows
written per operation on `wrangler dev` the way Cloudflare bills them, index entries included
(`docs/performance.md`): about 10 per email sent (9.4 at a send rate of 40 a second or more, a
little over 10 at the default 10 a second because each batch is then smaller), 4 per first open,
8 per click, 13 per signup, 11 per imported contact, 2 per website page view, and 0 for reading the
dashboard, the public website or an already-counted open. A store that has nothing to do writes
about 250 rows a day.

- 100,000 ÷ 10 = 10,000 emails a day with nobody opening or clicking.
- With a typical 40% open rate and 3% click rate, each email costs about 10 + 0.4 × 4 + 0.03 × 8 ≈
  12 rows, so about 8,000 emails a day.
- Importing a list: 100,000 ÷ 11 ≈ 9,000 contacts a day, on a day with nothing else going on. A
  larger file keeps going the next day; the import resumes where it stopped.
- A day with 5,000 emails, 2,000 opens, 150 clicks, 50 signups and 2,000 page views uses about
  50,000 + 8,000 + 1,200 + 650 + 4,000 ≈ 64,000 rows.
- Outbound requests do not bind: each send run makes at most 40 (one settings read, one suppression
  check, one permit call and 36 emails), and runs repeat as often as the alarm fires.

So a Free install sends to about 8,000 subscribers a day, and imports about 9,000 contacts a day.
A larger list still works but a single issue then takes more than a day to go out (a 20,000-subscriber
issue takes about three days), and opens and clicks arriving on top can push a day over the limit.
Move to Workers Paid ($5 a month) when your list passes about 6,000 subscribers, when you send more
than once a day, or when the dashboard shows the daily-limit banner. After you upgrade, delete the `WORKERS_PLAN` line from
`wrangler.jsonc` in your repository so each send run can make up to 900 requests.

**When the writes run out.** Cloudflare refuses every database write until 00:00 UTC. MailCorgi
keeps reading: the dashboard, sign-in state, the public website and feeds all work, a tracked link
still redirects (the click is not counted), the open pixel still answers, and an unsubscribe page
says it could not be recorded and asks the reader to try again later. Anything that writes answers
`503 storage_write_limit` with that explanation, the dashboard shows one banner, and sending pauses
without spending retries. A cron trigger in `wrangler.jsonc` wakes every store at 00:05 UTC so
queued sends resume by themselves.

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
`mailcorgi:3000` replaced by `127.0.0.1:3000`. Set `TRUST_PROXY=127.0.0.1` (the proxy's address) so
rate limits see each visitor's address, and keep port 3000 closed to everyone but the proxy.
MailCorgi ignores `X-Forwarded-*` headers from any other address.

The bundled `docker-compose.yml` does this for you: Caddy has a fixed address on the app's own
network, and `TRUST_PROXY` names only that address. A client that reaches a published port 3000
directly is never taken for the proxy.

## First run

1. Open your install's address. The first visitor creates the install admin with an email and a
   password. No email is sent, so this works before you set up a provider.
2. Create your first newsletter.
3. Open **Admin → Setup**. The checklist reads the live state of your install:
   - **Email provider configured**: Amazon SES, Resend, PostShiba or SMTP, with its keys.
   - **Test email sent**: a test through that provider succeeded.
   - **Delivery events received**: the provider's webhook reached MailCorgi. Not needed for SMTP.
   - **Sending turned on**: outbound email is not paused.
   - **Sending domain verified**: at least one domain passed its DNS check.

To let other people sign up, add their addresses to `ALLOWED_EMAILS` or to **Admin → Settings**, or
invite them to a newsletter from **Settings → Team**. A self-hosted install has no limit on how many
people a newsletter can have. Each person gets their own account. Outside
first-run setup, a new user proves their address: with the 6-digit code MailCorgi emails them, or with
the invite link. So configure an email provider before you let other people sign up. The same goes for
`ADMIN_EMAILS`: an address there gets admin rights only after it is confirmed this way.

Until you configure a provider, MailCorgi uses the `test` provider. It stores emails in the database
and sends nothing.

## Check your deployment

`npm run live:check` tests a running install over HTTPS, the way a reader and an editor use it. It
works on Cloudflare and on Docker or Node, and needs no dev-only settings. Run it from a clone of the
repository after `npm ci`:

```sh
npm run live:check -- --url https://news.example.com --email you@example.com --password 'your password'
```

Use the install admin's email and password. On a fresh install, the check runs first-run setup with
them (add `--name` to set the admin's name).

The check creates a newsletter named "Live check" with a random suffix, then:

1. Reads `/healthz`, the app page and a built JavaScript file, and checks the security headers.
2. Signs in, checks that a request without the CSRF token is refused, and times three sign-ins.
3. Uploads an image and reads it back byte for byte. On Cloudflare this tests R2.
4. Imports 1,000 contacts (`@example.com`) in two chunks and waits for the background job to finish.
   On Cloudflare this tests Durable Object alarms. Then it counts a segment.
5. Writes a campaign draft with every block type, autosaves it and renders the preview. The review
   must show one blocking check: no verified sending domain.
6. Publishes a web post and reads the newsletter's website, feed, sitemap and hosted signup form.
   Then it subscribes through the public form twice and checks that a new and a known address get
   the same answer.
7. Creates two API keys and reads every contact page through the REST API, calls MCP, and checks that
   the read-only key cannot write.
8. Checks that the notification for the finished import is there.
9. Deletes the draft, the author, every contact, and both API keys, and archives the newsletter.
   It also archives a "Live check" newsletter left by an earlier run that stopped early.

It prints each step's time and flags any request slower than 5 seconds and any server error. On
Workers Free, a request that runs out of CPU time fails with Cloudflare error 1102. The check prints
the response body for any server error.

Two things remain after the check. The archived newsletter stays under **Settings → Newsletter → Archived newsletters**, because
newsletters can be archived but not deleted. The uploaded test image (about 100 bytes) stays in
storage, because MailCorgi has no action to delete uploads.

The check cannot test these on a live install:

- **Sending.** It needs a sending domain with real DNS records. Follow
  [Verify a sending domain](#verify-a-sending-domain), then send yourself a test from a campaign.
- **Confirm, welcome and delivery emails.** They need a real email provider. With the `test`
  provider nothing leaves the install.
- **Opens, clicks, unsubscribes and provider webhooks.** They follow a real send.
- **CPU time per request.** Cloudflare does not report it in the response. Open
  **Workers & Pages → mailcorgi → Observability** to see it.

## Choose an email provider

| Provider | Cost | Bounce and complaint tracking | Platforms | Setup effort |
|---|---|---|---|---|
| Amazon SES | About $0.10 per 1,000 emails | Yes, through SNS | Both | Most steps, and AWS reviews your account before you can send to anyone |
| Resend | Free for 3,000 emails a month, then a monthly plan | Yes, through a webhook | Both | A few minutes |
| PostShiba | A monthly plan with an hourly and a 24-hour cap | Yes, through a webhook | Both | A few minutes |
| SMTP | Depends on the server | No | Docker and Node only | A few minutes |

Without bounce and complaint tracking, MailCorgi cannot remove bad addresses on its own, and your
sender reputation suffers sooner. Use SMTP only for small lists or for testing.

A campaign, welcome email or sequence step set to send as plain text (`sendFormat: "plain"`) goes out as
a single `text/plain` message through every provider: SES, Resend, PostShiba and SMTP. The details are in
[decisions/plain-text-send.md](decisions/plain-text-send.md). `hideUnsubscribeFooter` drops the closing
`--` / `Unsubscribe:` lines of a plain campaign or step; the `List-Unsubscribe` headers are still sent.

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

### PostShiba setup

MailCorgi sends through PostShiba's HTTP inject address with an SMTP credential, so it works on
Cloudflare Workers too.

1. In PostShiba, create a cluster and wait until it shows `sending_ready`. Add your sending domain and
   verify its DNS records.
2. On the cluster, issue an SMTP credential. Copy the user name (`smtp_…`) and the password. PostShiba
   shows the password once.
3. In **Admin → Email**, choose **PostShiba**, enter the user name and the password, and save. Leave
   **HTTP endpoint** blank when your cluster uses the shared inject host: a blank value means
   `https://inject.postshiba.com`. If the cluster page (the Sending Guide, or `http_endpoint` in the
   cluster API) shows a different HTTP inject host, set `postshiba_endpoint` to `https://<that host>`.
   The value must be an https URL without a path.
4. In PostShiba, open **Webhooks** and add an endpoint with the PostShiba URL shown in
   **Admin → Email**, for example `https://news.example.com/hooks/postshiba`. Keep all event types.
5. Copy the endpoint's **Signing secret** into **Webhook signing secret** in **Admin → Email** and save.
6. Set **Emails per hour** a little under your plan's hourly cap, for example `90` on a plan that
   allows 100 an hour. See [Turn sending on](#turn-sending-on).
7. Send a test email.

The same settings through the API or an MCP client, with `install_settings_set`:

```json
{
  "values": {
    "email_provider": "postshiba",
    "postshiba_user": "smtp_<id>",
    "postshiba_password": "<password>",
    "postshiba_webhook_secret": "<signing secret>",
    "send_rate_per_hour": "90"
  }
}
```

If a send fails, the app shows a short message, and the cause goes to the server log (Workers Logs
on Cloudflare) as one line that starts with `email provider failed`. The line names the provider and
the stage (`fetch`, `timeout`, `redirect`, `status` or `parse`), with the HTTP status when there is
one. It never contains credentials, the message or email addresses. A `redirect` stage means the
endpoint answered with a redirect, which MailCorgi never follows: check `postshiba_endpoint`. SES,
Resend and SMTP sends are logged the same way.

How MailCorgi reads PostShiba's events: a hard `bounce` marks the contact bounced. A `blocked` bounce
and a `dropped` message (PostShiba did not send it, for example because the address is on PostShiba's
own suppression list) count as soft bounces, and three of them mark the contact bounced. A
`spamreport` marks the contact as complained. PostShiba's **Send test event** is acknowledged and
changes nothing.

### SMTP

In **Admin → Email**, choose **SMTP** and enter the host, port, security mode (`tls` for port 465,
`starttls` for 587), user name and password. Send a test email. SMTP is not available on Cloudflare
Workers.

MailCorgi does not save a provider without the settings it needs to send: the region, access key ID
and secret access key for Amazon SES, the API key for Resend, the SMTP user name and password for PostShiba, and the host for SMTP (plus the password
when you enter a user name). A value set by an environment variable counts. **Admin → Email** marks
each missing field, and nothing is saved until they are filled in.

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
   - **PostShiba**: an SPF TXT record and a DMARC TXT record. MailCorgi does not create the domain in
     PostShiba: add and verify it there too, with the DKIM and return-path records PostShiba lists.
   - **SMTP**: an SPF TXT record and a DMARC TXT record.

   MailCorgi also suggests a DMARC record when the domain has none. Publish it: Gmail and Yahoo expect
   one from bulk senders.
3. Add the records at your DNS host, then click **Check**. DNS changes can take up to an hour to show.
4. In **Settings → Newsletter**, choose the verified domain as the **Sender domain** and set the
   sender name and local part.

A single campaign, the welcome email or a sequence step can send from another verified domain or address
with the optional sender override (`fromDomainId`, `fromLocal`, `fromName`; Reply-To stays the newsletter's).
Each field left empty uses the newsletter's. The override domain must be added and verified in MailCorgi,
**and the exact domain verified with your provider**: a verified `mail.example.com` does not allow sending
from `example.com`. With SES and Resend, adding the domain here creates it at the provider. With
PostShiba, MailCorgi does not: add and verify it in PostShiba first. PostShiba's envelope sender follows
the From address. Details in [the decision](decisions/campaign-sender-override.md).

MailCorgi checks every domain again once a day. If a record disappears, the domain fails, sending
from it stops, and you get a notification.

## Turn sending on

Sending is on by default. **Admin → Email** has a **Sending enabled** switch that pauses all
outbound email for the install, and **Emails per second**, which sets the pace for the whole install.
Set it at or below your provider's limit. A new SES account allows 1 email per second until AWS
raises it.

**Emails per hour** caps how many campaign emails the whole install sends in any 60 minutes, across
all accounts and with any provider. Leave it blank for no cap. A send that reaches the cap is not
failed: it waits and continues as room frees up, so a large issue goes out over several hours. Use it
when your provider plan has an hourly cap, as PostShiba plans do. Sign-in codes, invitations and test
emails are not held back and are not counted, so set the cap a little under the plan's limit. If
PostShiba still answers that its hourly or 24-hour limit is reached, MailCorgi keeps the email queued
and tries again after about 10 minutes or an hour.

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

## Send content copies

MailCorgi can keep one copy of each campaign and sequence email for 30 days. The copy is the subject,
HTML and plain text exactly as MailCorgi handed them to the email provider. It is off by default.

### Turn it on

Set `DELIVERY_CONTENT_CAPTURE=true` on Node, or as a variable on the Worker. Nothing else changes. From
then on, MailCorgi tries to keep a copy of each campaign or sequence email that the provider accepts on its
first attempt. Only the exact value `true` turns it on. The welcome email and re-engagement emails get none.

A copy is best effort. MailCorgi skips it, and the send still succeeds, when:

- the copy is larger than about 1 MB (subject, HTML and text together);
- the write fails, for example when a Cloudflare write quota is used up;
- the contact or newsletter was deleted while the provider call was running.

MailCorgi writes the copy in a separate step after it records the accepted send. If the process stops
between the two steps, the send stays accepted and has no copy. MailCorgi does not retry a skipped copy.

**Storage budget.** Each copy takes up to about 1 MB, and each contact gets one per email. Plan for
`contacts x emails per 30 days x average email size`. A Durable Object holds 10 GB, so the operator
must size the volume or watch usage. A 20 KB email to 100,000 contacts is about 2 GB for 30 days.

A copy is one recipient's email. It holds that recipient's unsubscribe and preferences links, their
tracked links and their open-tracking pixel. Treat it like the recipient's data.

### Read a copy

`GET /api/v1/newsletters/:newsletterId/sends/:deliveryId` returns `{ id, sentAt, content }`. The
`deliveryId` is the numeric `items[].id` of `sends.list`. The call is REST only: there is no MCP tool
and no web-session route.

- **Who may read.** The same callers as `sends.list` on `/api/v1`: an API key of the account, full or
  read-only. A key acts for the account owner, so it reaches every newsletter of that account. A key of
  another account is refused. OAuth tokens are accepted on `/mcp` only, as for every REST call today.
  The newsletter must be readable by the key, which needs at least the member role.
- **Wrong ids.** A newsletter you cannot read answers as for any other call. After that check, an unknown
  id, a malformed id and an id from another newsletter all answer `404 not_found`.
- **Caching.** Every answer on this path, errors included, carries `Cache-Control: private, no-store`.
  Do not cache it in a proxy or a CDN, and do not write it to logs.
- **`content` is `null`** when no exact copy exists: the feature is off, the email was not accepted,
  it went out before copies existed, an earlier attempt made the accepted content or time uncertain,
  or the copy is past its cutoff. MailCorgi never rebuilds an email from the current campaign. `html` is
  `null` for a plain-text send.

### Cutoff and old rows

A copy expires 30 days after the provider accepted the email. At that exact moment the API answers
`content: null`, even if the row is still in the database. A job then deletes expired rows in small
batches. It runs from the account's own job alarm, so it needs no traffic, and it runs whether or not
the feature is on. Rows from before the cutoff stay readable until it.

### Show a copy safely

MailCorgi has no preview page for copies. If you build one, make it inert. The HTML is untrusted
newsletter content, and loading it can change real data.

- **Never put the raw content in your app DOM.** Do not use `innerHTML`, or a template that inserts it.
- **Strip or disable navigation before you insert it into a frame.** Remove or neutralise every `a`,
  `area` and `form` element, every `href` and `action` attribute, `base`, and `meta http-equiv="refresh"`.
  An iframe with `sandbox=""` and a Content-Security-Policy of `default-src 'none'` still lets a link
  navigate its own iframe. The sandbox and the policy do not stop that.
- Run no scripts and load no remote resources. Do not load the tracking pixel: it records an open.
- Do not follow its links. A tracked link records a click. The unsubscribe and preferences links belong
  to the recipient and act for them.
- Do not cache the response, and do not log it.

### Where copies live

Copies live in the account database only, in the `delivery_content` table. They go away with their
delivery, with the contact (deleting a contact erases that contact's copies even though the delivery
record stays), with the newsletter and with the account.

Copies also exist in places MailCorgi cannot erase:

- **Your email provider** keeps its own record of what you sent, under its own retention.
- **Node backups** hold every copy that existed at backup time. You set how long you keep them.
  `scripts/backup.mjs` does not remove old backups.
- **Cloudflare** point-in-time recovery holds them for its 30-day window.

A recovery copy (a backup, or a point-in-time recovery) can hold a copy that you erased or that is past
its cutoff. Such rows stay unreadable only while `DELIVERY_CONTENT_CAPTURE` is not `true`. After a
recovery, treat them as unreadable until you scrub them or they are past retention.

### Turn it off

Remove the variable, or set it to any value other than `true`. The endpoint still works and answers
`content: null`, and no new copies are made. **Turning it off does not erase copies already stored.**
They stay in the database until their 30 days end, and the purge job then removes them. To erase them
sooner, run `DELETE FROM delivery_content` in each account database with the app stopped.

### After a restore

A restored database can hold copies that were already past their cutoff, or that you meant to erase.
Keep the flag off until you have scrubbed them or they are past retention:

1. Restore with `DELIVERY_CONTENT_CAPTURE` unset. With the flag off, no copy is readable.
2. Scrub the restored copies with `DELETE FROM delivery_content` in each account database. On Node, do
   this after the restore and before you start the app.
3. On Cloudflare, use SQL access to the account's Durable Object if you have it, and run the same
   statement. If Worker SQL access is not available, you cannot scrub. Keep the flag unset until the
   newest restored copy is past its 30 days. The purge job deletes the expired rows.
4. Only when the copies are scrubbed or past retention, set `DELIVERY_CONTENT_CAPTURE=true`.

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
| `APP_HOSTS` | Both |  | Comma-separated extra host names that serve the same app as `APP_URL`, for example `news.example.org`. Use it to add a second domain or move to a new one without breaking the old one. Links in emails, webhook addresses and billing return pages keep using `APP_URL`. Each host has its own sign-in: cookies are not shared between hosts. Serve every alias over the same scheme as `APP_URL`. Not for newsletter website domains: set those in **Website → Custom domain**. |
| `CLOUD` | Both | off | `true` turns on cloud mode: open sign-up with emailed codes, plans, limits and billing. |
| `ADMIN_EMAILS` | Both |  | Comma-separated install admins. They may always sign up, see `/admin` and get admin alerts by email. Admin rights start only after the address is confirmed with an emailed code or an invite link. |
| `ALLOWED_EMAILS` | Both |  | Comma-separated addresses that may sign up on a self-hosted install with an emailed code. Adds to the list in **Admin → Settings**. |
| `SIGNUP_MODE` | Both | open in cloud mode, allowlist otherwise | `closed`, `allowlist` or `open`. Overrides the setting in **Admin → Settings**. |
| `APP_SECRET` (secret) | Both | generated on first boot | Master key, at least 16 characters. Leave unset unless you must move the key: changing it signs everyone out and makes stored credentials unreadable. |
| `IMAGES_PUBLIC_URL` | Both | `APP_URL/img` | Origin that serves uploaded images, when you put a CDN or a public R2 domain in front of them. |
| `SEND_BATCH_SIZE` | Both | 100 | Most emails one send run claims. The platform limit can lower it. |
| `DELIVERY_CONTENT_CAPTURE` | Both | off | `true` keeps a copy of the subject, HTML and text of each campaign and sequence email as handed to the provider, for 30 days, and lets `GET /api/v1/newsletters/:newsletterId/sends/:deliveryId` return it. Off, no copy is made and the endpoint returns `content: null`. Turning it off does not erase copies already stored: they stay in the database until they expire. See [Send content copies](#send-content-copies). |
| `TURNSTILE_SITE_KEY` | Both |  | Cloudflare Turnstile site key for signup forms. Needs `TURNSTILE_SECRET_KEY` too. |
| `TURNSTILE_SECRET_KEY` (secret) | Both |  | Cloudflare Turnstile secret key for signup forms. |

### Email

| Variable | Platform | Default | Description |
|---|---|---|---|
| `EMAIL_PROVIDER` | Both | test | `ses`, `resend`, `postshiba`, `smtp` or `test`. `test` keeps every email in a local outbox. `smtp` works on Node only. |
| `EMAIL_FROM` | Both | `mailcorgi@` + the app host | Sender address for system emails: sign-in codes, invitations, alerts and test emails. |
| `EMAIL_FROM_NAME` | Both | MailCorgi | Sender name for system emails. |
| `SENDING_ENABLED` | Both | true | `false` pauses all outbound email for the install. |
| `SEND_RATE_PER_SECOND` | Both | 10 | Install-wide sending rate. Match it to your provider quota. |
| `SEND_RATE_PER_HOUR` | Both | no cap | Most campaign emails the install sends in any 60 minutes, across all accounts. A send that reaches it waits for room. Set it a little under your provider plan's hourly cap. |
| `SES_REGION` | Both |  | AWS region of your SES account, for example `eu-west-1`. |
| `SES_ACCESS_KEY_ID` (secret) | Both |  | Access key ID of the IAM user that sends through SES. |
| `SES_SECRET_ACCESS_KEY` (secret) | Both |  | Secret access key of that IAM user. |
| `SES_CONFIGURATION_SET` | Both |  | SES configuration set that publishes delivery events to SNS. |
| `SES_SNS_TOPIC_ARN` | Both |  | The only SNS topic whose notifications `/hooks/ses` accepts. |
| `RESEND_API_KEY` (secret) | Both |  | Resend API key with sending and domain access. |
| `RESEND_WEBHOOK_SECRET` (secret) | Both |  | Signing secret of the Resend webhook that points at `/hooks/resend`. |
| `POSTSHIBA_USER` | Both |  | User name of the PostShiba SMTP credential, shown as `smtp_…`. |
| `POSTSHIBA_PASSWORD` (secret) | Both |  | Password of that SMTP credential. |
| `POSTSHIBA_WEBHOOK_SECRET` (secret) | Both |  | Signing secret of the PostShiba webhook that points at `/hooks/postshiba`. |
| `POSTSHIBA_ENDPOINT` | Both | `https://inject.postshiba.com` | HTTP inject address of your PostShiba cluster, when it has its own. |
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
| `TRUST_PROXY` | Node | unset (Caddy's fixed address in `docker-compose.yml`) | Reverse proxies whose `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` count: a comma-separated list of their addresses, or `true` for any loopback or private peer. Unset, MailCorgi uses the socket address and ignores forwarding headers. Set it only when every request reaches MailCorgi through that proxy. |
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

**Cloudflare requests fail late in the day, or the dashboard shows the daily-limit banner.** You
reached a Workers Free daily limit, usually the 100,000 database writes shared by the whole
account. It resets at 00:00 UTC; reading keeps working until then. Move to Workers Paid if it
happens often.

**Saved provider keys stopped working after a move.** The new install has a different `secret.key` or
`APP_SECRET`. Restore the old one, or enter the keys again in **Admin → Email**.
