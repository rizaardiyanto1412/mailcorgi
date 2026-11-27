# Plain text send mode

A welcome email written as a few plain paragraphs was sent inside the newsletter theme: gray
background, 600px card, "Thanks for reading." footer, Unsubscribe / Preferences / View on the web
links and an open pixel. It read as a bulk email. `sendFormat: 'plain'` sends the same content as a
plain text email that reads like one written by hand.

## The setting

- **Name.** The field is `sendFormat` (`'html' | 'plain'`), column `campaigns.send_format`. It is not
  called `format` because campaigns already have `format` (`doc | markdown | html`): the format the
  *content is written in*. The two are independent: Markdown, HTML and editor content can each be
  sent as html or plain.
- **Where it lives.** On the `campaigns` row, added by the campaigns module's own migration
  (`2026-11-27-campaigns-send-format`: `ADD COLUMN send_format TEXT NOT NULL DEFAULT 'html'
  CHECK(send_format IN ('html', 'plain'))`). Existing rows read as `html`, so nothing changes until
  someone asks for `plain`. The welcome email (`kind = 'welcome'`) and every sequence step
  (`kind = 'sequence'`) are campaigns rows, so they get the setting with no extra storage.
- **Actions** (REST and MCP alike; `html` when omitted on create, unchanged when omitted on update):

  | Action | Input | Output |
  |---|---|---|
  | `campaigns.create` | `sendFormat` (default `html`) | `sendFormat` |
  | `campaigns.update` | `sendFormat` (optional) | `sendFormat` |
  | `campaigns.get`, `campaigns.duplicate` | | `sendFormat` |
  | `campaigns.list` | | `campaigns[].sendFormat` |
  | `signup.saveWelcome` | `sendFormat` (optional; a new welcome email starts as `html`) | `welcome.sendFormat` |
  | `signup.get` | | `welcome.sendFormat` |
  | `sequences.create` | `steps[].sendFormat` (default `html`) | `steps[].sendFormat` |
  | `sequences.addStep` | `sendFormat` (default `html`) | `sendFormat` |
  | `sequences.updateStep` | `sendFormat` (optional) | `sendFormat` |
  | `sequences.get`, `sequences.reorderSteps`, `sequences.deleteStep` | | `steps[].sendFormat` |

  Any other value is `400 invalid_input`.
- **Dashboard.** A "Send as plain text" checkbox in the campaign editor (which also edits sequence
  step emails) and in the welcome email section of the signup page.

## What a plain email contains

`renderEmail` returns `textOnly: true` for a plain campaign, with:

- **Text.** The content as readable text: paragraphs separated by one blank line, lists as `- item`
  / `1. item`, quotes as `> line`. A link is written `text (https://address)`, or as the bare address
  when its text is the address. Merge fields are resolved as in an html send. HTML content has its
  tags removed (the author's own "plain text alternative", when set, is used as written).
- **One closing line.** `--` and `Unsubscribe: <one-click address>`. No theme header, no footer text,
  no Preferences or View-on-the-web links, no preview text, and no postal address: put the address in
  the body yourself where the law asks for one in this kind of email. The review step still requires
  the newsletter to have one.
- **No tracking.** No open pixel, and links are the addresses the author wrote: no click rewriting,
  no `links` rows. Reports for a plain send show deliveries, bounces, complaints and unsubscribes, and
  zero opens and clicks. Because silence after a plain send says nothing, a plain issue does not add
  to a reader's ignored-issue streak (list hygiene counts only html issues).
- **Headers.** Exactly those of an html send: `List-Unsubscribe` (mailto and one-click URL on
  campaign and sequence sends, the URL on signup mail), `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
  `Feedback-ID` and the routing headers. Unsubscribing by header or by the closing line is the same token.
- **Test sends and previews** render the same way, so `campaigns.sendTest` shows what readers get.
- **Review checks.** A plain email is not asked for preview text, nor for a `{{unsubscribe_url}}`
  link in raw HTML content: the closing line is always there.

## MIME parts per provider

`EmailMessage.textOnly` tells the provider the message is a plain send. `html` is still filled, with a
bare copy of the text (`<p>` per paragraph, `<br>` per line break, addresses as links; no styles,
card, footer or pixel), but no provider sends it: every plain send leaves as `text/plain` only.

| Provider | Plain send goes out as | Why |
|---|---|---|
| Amazon SES | one `text/plain; charset=UTF-8` entity | MailCorgi builds the raw MIME itself (`buildMime`), so it writes a single-part message. |
| SMTP | one `text/plain; charset=UTF-8` entity | Same raw MIME as SES. |
| Resend | `text/plain` only | The `html` field is left out of the API call; Resend sends a text-only message from `text`. |
| PostShiba | `text/plain` only | `html_body` is left out of the HTTP inject call. PostShiba's sending documentation gives inject's `content` as `{text_body, html_body, headers, attachments}` and its own example sends `text_body` alone. No live send was made to inspect the delivered MIME. |
| test (outbox) | `text` and the bare `html` are both stored | The outbox keeps what was rendered. |

The rule is the same everywhere: a plain send is `text/plain` with no HTML part. Each provider still
applies it itself, because each one builds or requests the message differently.

## Not decided here

- Gmail's tab placement is Gmail's decision. Plain text without a theme, pixel or rewritten links
  removes the bulk-mail signals MailCorgi added; the `List-Unsubscribe` headers stay because Gmail and
  Yahoo require them of bulk senders.
