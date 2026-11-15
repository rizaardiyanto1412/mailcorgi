# MailCorgi

MailCorgi is a newsletter app you run yourself. Write an issue, send it to your list, and publish it on
your own website. It runs on Cloudflare Workers with one click, or on any server with Docker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rizaardiyanto1412/mailcorgi)

You bring the email provider (Amazon SES, Resend or any SMTP server) and pay it directly. MailCorgi
keeps your list, your issues and your stats in SQLite databases that you own.

## Features

**Writing and sending**

- A block editor with headings, lists, quotes, code, images, buttons, callouts, dividers and link cards.
  The API and MCP also accept Markdown and HTML.
- Merge fields such as `{{first_name|there}}`, a send preview and test emails to up to 5 addresses.
- A review step that checks the subject, preview text, unsubscribe link, size against Gmail's clipping
  limit, postal address, sender domain, image alt text and links.
- Schedule, pause and resume a send, cancel a scheduled one, or stop a paused one and skip the rest.
  Gradual sending for addresses you never emailed before, with an automatic pause when hard bounces pass
  2.5% or complaints pass 0.08%. "Send to more now" and resuming a paused send follow the same check,
  and the send page says when the next step is held and why. Send to the most engaged readers first.
- One-click unsubscribe headers (RFC 8058) on every email.

**Your list**

- Contacts with search, filters, tags, custom fields, a timeline per contact and CSV export.
- Segments built from status, tags, fields, dates, source, engagement and inbox provider.
- Signup forms: a hosted page, an embed script and a JSON endpoint. Double opt-in by default, a
  welcome email, and spam limits per visitor (honeypot, rate limits, optional Cloudflare Turnstile).
- CSV imports with presets for beehiiv, Substack, Mailchimp, Kit, MailerLite, Buttondown, Ghost,
  EmailOctopus and listmonk. Imports leave out invalid, misspelled, role, disposable, duplicate and
  suppressed addresses, and report each reason. Rows without a subscribed status and confirmed consent
  are added as unconfirmed and get no email; the import says so before it starts and in its report.
  Importing them again with consent confirmed subscribes them. No import brings back an address that
  unsubscribed, bounced, complained or was deleted.
- List hygiene: readers who ignore 8 issues in a row (you can change the number) get one "still interested?" email. If they do not
  click within 14 days, they stop getting issues.

**Delivery and tracking**

- Sending domains with the DNS records to publish and a daily recheck. SES and Resend identities are
  created for you.
- Bounce and complaint webhooks from SES and Resend update contacts and suppressions on their own.
- Open and click tracking that leaves out link scanners and security bots.
- Campaign reports and an overview of subscribers over time, growth by source and website views.
- Notifications in the app, and alerts for install admins.

**Website**

- A public site for each newsletter at `/n/<slug>` or on your own domain: home page with a signup form,
  issue pages, author pages, RSS, sitemap, Open Graph tags and JSON-LD.
- Page view counts without cookies, plus Plausible, Google Analytics, Fathom or Umami if you want them.

**Teams and automation**

- Invite people to each newsletter as admins or members. A self-hosted install has no limits on
  newsletters, contacts, team size or emails. In cloud mode the plan sets each limit, including how
  many people a newsletter can have (2 on the free plan).
- API keys with full or read-only access, a REST API with OpenAPI docs at `/docs/api`, and an MCP
  server at `/mcp` so AI assistants can draft and send through the same rules as the dashboard.

**Running it**

- An admin console with a setup checklist, email provider settings, accounts, alerts, failed jobs and
  global suppressions.
- Cloud mode (`CLOUD=true`) turns an install into a hosted service: open sign-up with emailed codes,
  plans with limits, and billing through Stripe or Polar.

## Screenshots

| | |
| --- | --- |
| ![Overview with subscriber growth and recent campaigns](docs/screenshots/light/desktop/overview.png) | ![The campaign editor](docs/screenshots/light/desktop/campaign-write.png) |
| ![A campaign report with opens, clicks and bounces](docs/screenshots/light/desktop/campaign-report.png) | ![Contacts with status, tags and filters](docs/screenshots/light/desktop/contacts.png) |
| ![The public website home page](docs/screenshots/light/desktop/site-home.png) | ![The public issue page](docs/screenshots/light/desktop/site-issue.png) |

`npm run ui:pass` captures every page in light and dark, at desktop and phone width (see [docs/development.md](docs/development.md#browser-pass-and-screenshots)).

## Install

### Cloudflare (one click)

1. Click **Deploy to Cloudflare** above. Cloudflare copies the repository to your GitHub or GitLab
   account, creates the Durable Objects and the R2 bucket, then builds and deploys the Worker.
2. Open the `*.workers.dev` address that Cloudflare shows and create the first account. It becomes the
   install admin.
3. Go to **Admin → Setup** and work through the checklist.

No secrets are needed to deploy. R2 must be enabled on your Cloudflare account once. If you do not want
R2, delete the `r2_buckets` block in `wrangler.jsonc` and images are stored inside the Durable Objects.
Workers Free fits a small list: its 100,000 database writes a day (shared by everything on your
Cloudflare account) cover about 8,000 emails a day with typical opens and clicks (about 10 rows per
email, 4 per open, 8 per click), or an import of about 9,000 contacts (11 rows each), and when they
run out the app keeps reading until 00:00 UTC. The [Cloudflare section of the self-hosting
guide](docs/self-hosting.md#run-on-cloudflare) has the arithmetic, custom domains and when to move to
Workers Paid.

### Docker

```sh
git clone https://github.com/rizaardiyanto1412/mailcorgi.git
cd mailcorgi
docker compose up -d
```

Open <http://localhost:3000> and create the first account. The port listens on this machine only; set
`MAILCORGI_PORT` in `.env` to use another one. On a server with a domain name, use the installer
instead. It asks for your domain, writes `.env` and starts the stack with Caddy for HTTPS
(`docker compose --profile https up -d`):

```sh
curl -fsSL https://raw.githubusercontent.com/rizaardiyanto1412/mailcorgi/main/scripts/install.sh | sh
```

### Check a live install

After you deploy, run this from a checkout to test the install over HTTPS. It uses no dev switches,
creates its own test data and removes it afterwards. On a fresh install it creates the first account
with these credentials.

```sh
npm ci
npm run live:check -- --url https://news.example.com --email you@example.com --password 'your-password'
```

## Guides

- [Self-hosting guide](docs/self-hosting.md): first run, email providers, DNS, custom domains, backups,
  upgrades and every environment variable.
- [Cloud mode](docs/cloud-mode.md): run MailCorgi as a paid service with Stripe or Polar.
- [API](docs/api.md): REST and MCP.
- [Architecture](docs/architecture.md): how the code fits together.

## How this differs from a newsletter SaaS

A hosted newsletter service charges by list size and holds your list. With MailCorgi you pay your
email provider per email (Amazon SES costs about $0.10 per 1,000) and keep the data. You also take on
what the service did for you: you set up the provider and your DNS, you watch your sender reputation,
and you back up your data. MailCorgi helps with the first two through the setup checklist, domain
checks, gradual sending and automatic pauses. Backups are one command; the guide shows it.

## Develop

```sh
npm ci
npm run dev     # the API server and the Vite dev server, with reload on save
npm run ci      # typecheck, lint, tests, build, and smoke tests on Node and wrangler dev
```

Read [docs/development.md](docs/development.md) before you add a feature.

## License

[AGPL-3.0-only](LICENSE). If you run a modified MailCorgi for other people, you must offer them your
source code.
