# Cloud mode

Cloud mode turns a MailCorgi install into a hosted service that strangers sign up for and pay for. It
adds open sign-up with emailed codes, plans with limits, billing through Stripe or Polar, and account
blocking in the admin console. Everything in the [self-hosting guide](self-hosting.md) still applies:
set up the install there first, including a real email provider.

## Turn it on

Set these variables and restart (Docker) or redeploy (Cloudflare):

```sh
CLOUD=true
BILLING_PROVIDER=stripe        # or polar
ADMIN_EMAILS=you@example.com
APP_URL=https://app.example.com
```

With `CLOUD=true`:

- Anyone can sign up. MailCorgi emails a 6-digit code to confirm the address, so the email provider
  and the system sender in **Admin → Email** must work first. To limit sign-up, set `SIGNUP_MODE` to
  `allowlist` or `closed`, or change it in **Admin → Settings**.
- New accounts start on the free plan. Owners see **Settings → Billing** with their plan, live usage
  and an upgrade button. Contacts count both subscribed and unconfirmed ones.
- Limits apply to contacts, emails a month, newsletters and team members per newsletter (members plus
  pending invitations). A limit error says how much is used, for example "1,000 of 1,000 contacts
  used", and links to billing. At the contact limit the signup form tells new readers the newsletter
  is not taking subscribers, and the owner gets one notification a month about it. A blocked account
  stops sending within one batch.
- The accounts list in **Admin** shows usage from an hourly snapshot and says how old it is. **Summary**
  on an account counts live.

Install admins are the addresses in `ADMIN_EMAILS`. They see `/admin`.

## Plans

Plans live in [server/control/billing/plans.ts](../server/control/billing/plans.ts):

| Plan | Contacts | Emails a month | Newsletters | Team per newsletter | Monthly | Yearly |
|---|---|---|---|---|---|---|
| `free` | 1,000 | 10,000 | 1 | 2 | $0 | $0 |
| `starter` | 5,000 | 50,000 | 3 | 5 | $19 | $190 |
| `growth` | 15,000 | 150,000 | 5 | 10 | $49 | $490 |
| `pro` | 50,000 | 500,000 | 10 | 20 | $99 | $990 |
| `scale` | 150,000 | 1,500,000 | 25 | 50 | $249 | $2,490 |

To change a limit or a displayed price, edit that file and deploy. The price that customers pay comes
from Stripe or Polar, so change it there too. Plan names are fixed: the billing providers map to them.

## Stripe

1. **Create the products.** In the Stripe dashboard, create one product per paid plan: Starter,
   Growth, Pro and Scale. Give each a monthly and a yearly recurring price.
2. **Set the lookup keys.** MailCorgi finds prices by lookup key, not by ID. Set each price's lookup
   key to `mailcorgi_<plan>_<interval>`:

   ```
   mailcorgi_starter_monthly   mailcorgi_starter_yearly
   mailcorgi_growth_monthly    mailcorgi_growth_yearly
   mailcorgi_pro_monthly       mailcorgi_pro_yearly
   mailcorgi_scale_monthly     mailcorgi_scale_yearly
   ```

3. **Turn on the customer portal.** In **Settings → Billing → Customer portal**, activate the portal.
   MailCorgi sends owners there to change cards and see invoices.
4. **Add the webhook.** In **Developers → Webhooks**, add an endpoint at
   `https://app.example.com/hooks/stripe` with API version `2026-09-30.endive` and these events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`
   - `invoice.payment_failed`
5. **Save the keys.** In **Admin → Settings**, save `stripe_secret_key` (a secret or restricted key)
   and `stripe_webhook_secret` (the endpoint's signing secret). Or set `STRIPE_SECRET_KEY` and
   `STRIPE_WEBHOOK_SECRET` in the environment.

Use test-mode keys and a test-mode webhook first. Buy a plan with a test card, then check that the
account's plan changes in **Admin → Accounts**.

## Polar

1. **Create the products.** In Polar, create a recurring product for each plan and interval you sell,
   for example "Starter monthly" and "Starter yearly". Copy each product ID.
2. **Map them to plans.** In **Admin → Settings**, save `polar_products` as a JSON object (or set
   `POLAR_PRODUCTS`):

   ```json
   {
   	"starter_monthly": "00000000-0000-0000-0000-000000000001",
   	"starter_yearly": "00000000-0000-0000-0000-000000000002",
   	"growth_monthly": "00000000-0000-0000-0000-000000000003"
   }
   ```

   Keys are `<plan>_<monthly|yearly>` for `starter`, `growth`, `pro` and `scale`. A plan without an
   entry cannot be bought.
3. **Create an access token.** In Polar's organization settings, create an organization access token
   that can manage checkouts, subscriptions and customer sessions. Save it as `polar_access_token`.
4. **Add the webhook.** Add an endpoint at `https://app.example.com/hooks/polar` with the
   `subscription.*` events. Save its secret as `polar_webhook_secret`.

Polar pauses a subscription at the end of the paid period, not at once. When you block an account,
its sending stops at once and its billing pauses at the period end.

## What happens when a payment fails

- **Payment fails**: the account keeps its plan for 7 days, then drops to free limits unless the
  payment recovers.
- **Subscription ends**: the plan lasts until the end of the paid period, plus 7 days.
- **Account blocked**: sending stops and billing pauses. Unblocking resumes billing. After 30 days
  blocked, MailCorgi cancels the subscription and moves the account to the free plan.

Each webhook is processed once, and an older event never overwrites newer subscription state.

## Admin console

Install admins open `/admin`:

- **Setup**: the checklist from the self-hosting guide.
- **Accounts**: search by name or owner email, filter by status and plan, see contacts and emails sent
  this month, read a summary, block with a reason, unblock, or delete for good.
- **Alerts**: failed jobs, provider errors and automatic blocks.
- **Dead jobs**: jobs that failed 8 times, in the control store or any account store. Retry or
  discard them.
- **Settings**: sign-up mode, allowed emails, and billing keys. Secrets are shown only as saved or not
  saved.
- **Email**: provider, keys, system sender, sending switch and webhook URLs.
- **Suppressions**: the install-wide list of addresses that bounced as nonexistent or were reported
  as spam traps, stored as keyed hashes.

Account protection runs on its own. When an account's hard bounces pass 5% or its complaints pass
0.3% over its last 1,000 or more emails, MailCorgi blocks it in cloud mode and raises an alert.
