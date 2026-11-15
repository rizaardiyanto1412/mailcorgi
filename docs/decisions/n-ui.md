# UI pass decisions (unit n-ui)

- **`/settings/website` redirects to `/website`.** The website page lived at both paths and showed in the
  sidebar and in settings. Architecture section 7 lists `/website` as the route and no website entry
  under settings, so settings keeps only a redirect for old links.
- **Settings order is fixed in `web/src/app/Settings.tsx`.** Feature order produced a random list with
  Design twice. Settings now lists newsletter pages first (newsletter, design, authors, signup forms,
  tags and fields, list hygiene), then account pages (sending domains, team, suppressions, API & MCP,
  account, billing). `/settings` opens Newsletter.
- **`NavEntry.role`.** A settings entry can name the lowest role that may use it (`owner` or `admin`).
  The layout hides entries the signed-in user cannot use; the pages also show a `NoAccess` state if
  opened directly. Team stays visible to members, who can leave a shared newsletter there.
- **Each settings page owns its `PageHeader`.** The layout no longer renders a "Settings" header, so every
  page in the app starts with the same header.
- **Website excerpts drop link footnotes and list markers.** `renderWeb` built card excerpts from the
  plain-text email, which shows `[1]` link references and `-` bullets on the public site. The excerpt
  now strips them (`server/account/render/index.ts`). The text email is unchanged.
- **Dark theme tokens `--on-accent` and `--on-danger`.** White text on the dark theme's orange and red
  buttons was below 3:1 contrast. Primary and danger buttons now use these tokens (white in light
  theme, near-black in dark).
