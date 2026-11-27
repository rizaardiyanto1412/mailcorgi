# Per-campaign sender override

The From address was only the newsletter's: `"Name" <local@verified-domain>`. A campaign, the welcome
email or a sequence step can now carry its own sender. It is optional, and it never changes Reply-To.

## The fields

`fromDomainId`, `fromLocal`, `fromName` (camelCase in REST and MCP), columns `campaigns.from_domain_id`,
`from_local`, `from_name`, all nullable, added by the campaigns module's own migrations
(`2026-11-27-campaigns-from-*`). Existing rows stay unset. The welcome email (`kind = 'welcome'`) and every
sequence step (`kind = 'sequence'`) are campaigns rows, so they need no extra storage.

| Field | Rules (the same as `newsletters.update`, `fromLocal` and `fromName`) |
|---|---|
| `fromDomainId` | A sending domain id of this account. Must be `verified` when saved and again when sent. |
| `fromLocal` | 1 to 64 characters of `a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-`. Unlike the newsletter field it cannot be empty: an empty local part could never send. |
| `fromName` | Trimmed, at most 200 characters, no CR, LF, `<` or `>`. An empty string is a value: no display name. |

An invalid type, local part or name is `400 invalid_input`. An unknown, unverified or other-account
domain is `400 domain_unverified`, the code `newsletters.update` uses. Domains are per account store, so
another account's domain id is simply unknown.

## Fallback

Each field falls back to the newsletter **on its own** while it is null or not stored:

- Effective domain = `fromDomainId`, else the newsletter's `domainId`.
- Effective local part = `fromLocal`, else the newsletter's `fromLocal`.
- Effective display name = `fromName` (a stored empty string means no display name), else the newsletter's `fromName`.
- The From is built exactly as `verifiedSenderFor` always built it, from those parts. The effective domain
  must be `verified` right now, the local part valid, and the newsletter not archived. Otherwise there is
  no sender and the send is refused.
- **Reply-To is always the newsletter's `replyTo`.** There is no per-campaign Reply-To.

## Saving and clearing

On `campaigns.update`, `signup.saveWelcome` and `sequences.updateStep`: `null` clears one field (the
newsletter value is used again), omitting it keeps the stored value, and there is no sentinel string. To
clear all three, send all three as `null`. On `campaigns.create`, `sequences.create` steps and
`sequences.addStep`, `null` and omitted both mean no override. `campaigns.duplicate` copies the override.

When a save touches any override field, the sender that would result (the new values plus the stored and
newsletter ones) must be usable now, or the save fails closed with `400 sender_unverified`. So an override
that only sets a name needs a working newsletter domain and local part. A save that leaves the override
fields out is never checked again: an autosave does not fail because a domain changed since.

Deleting a sending domain sets `campaigns.from_domain_id` to NULL, as it does for `newsletters.domain_id`.
The campaign's `fromLocal` and `fromName` stay, so it then sends from the newsletter domain with those.

## One implementation

`verifiedSenderFor(ctx, newsletterId, override?)` in `server/account/domains/index.ts` is used by every
path, with the override read off the campaigns row (`senderOverrideOf`). A missing domain, or one that is
`pending`, `failed` or `suspended`, returns null:

| Path | When the effective sender is unusable |
|---|---|
| `campaigns.send`, `schedule` | `400 review_failed` (check `sender_domain`), as before |
| `send.start` (scheduled), `send.batch` | The campaign is canceled or paused with reason `sender_unverified` |
| `campaigns.resume`, `campaigns.sendTest` | `400 sender_unverified` |
| `campaigns.preview` | `sender: null` and the `sender_domain` review error |
| `sequences.activate`, `resume` | `400 review_failed` naming the step, using each step's own sender |
| Sequence tick | That step's enrollments wait an hour (`HOLD_MS`) and nothing is queued; other steps still go |
| Welcome email delivery | The signup mail is marked `failed` and nothing is sent |

`campaigns.preview` returns `sender: { from, replyTo? } | null`: the effective From and Reply-To. A test
send goes out from the same sender and the unsubscribe mailbox follows its domain
(`unsubscribe@<effective domain>`).

### The welcome email

The welcome email has gone out from the install's system address (`email_from`), not from the newsletter
sender. That is unchanged **when no override is set**. When any of the three fields is set, it is sent from
the effective sender above (so fields it leaves unset come from the newsletter, not from the system
address), the domain is checked again at delivery, and an unusable sender fails the mail instead of falling
back to the system address. The confirmation email never has an override. Its test send (`campaigns.sendTest`
on the welcome campaign) always used the newsletter sender and now uses the effective one.

## Providers and alignment

Every provider builds its message from `EmailMessage.from`, so the effective From is what is sent and
nothing else is needed:

- **PostShiba** sets `envelope_sender` to the address in From. MAIL FROM and Return-Path therefore follow the
  effective domain, and DKIM alignment is PostShiba's to make for that domain.
- **SMTP** uses the From address as the SMTP envelope sender. **SES** passes it as `FromEmailAddress`.
  **Resend** passes it as `from`. Each keeps its own envelope behaviour.
- MailCorgi does not add a second envelope domain.

### Verify the exact domain with the provider

MailCorgi only checks that the domain is `verified` in its own list. Sending from a different domain,
such as the root `sandywp.com` while the newsletter uses `mail.sandywp.com`, needs **that exact domain**
verified with the provider. A verified sibling, parent or subdomain does not count.

- **SES and Resend** (`identities: true`). Add `sandywp.com` in **Settings → Sending domains**. MailCorgi
  creates the identity at the provider and lists the DKIM, SPF and MAIL FROM records to publish. Check it
  until it is `verified`. Until then it cannot be a `fromDomainId`.
- **PostShiba** (`identities: false`). MailCorgi does **not** create the identity. First add `sandywp.com` to
  the PostShiba cluster and publish the DKIM and return-path records PostShiba lists, until PostShiba shows it
  verified. Then also add and verify `sandywp.com` in MailCorgi (its SPF and DMARC records). If only
  `mail.sandywp.com` is verified in PostShiba, a send From `@sandywp.com` is rejected by PostShiba (its
  unverified or not-aligned domain error), and the delivery fails.
- **SMTP**. The server must be allowed to send as that domain: the SPF and DKIM the operator set up for it.

None of this changes DNS or provider settings by itself.

## Interface

`campaigns.create`, `campaigns.update`, `signup.saveWelcome`, `sequences.create` (`steps[]`),
`sequences.addStep` and `sequences.updateStep` take the three fields. `campaigns.get`, `list`,
`duplicate`, `signup.get` and `signup.saveWelcome` (under `welcome`), and every sequence step output
return them. The dashboard has an optional Sender section in the campaign editor and in the welcome
email, with a domain picker fed by `domains.senders` (admins), and a button to go back to the newsletter
sender. Sequence steps have no editor of their own, so no sender picker.
