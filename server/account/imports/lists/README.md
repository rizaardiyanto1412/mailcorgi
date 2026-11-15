# Disposable domains

`disposable-domains.json` contains 10,234 domains downloaded on November 15, 2026 from [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains/blob/main/disposable_email_blocklist.conf). The upstream list uses the CC0 public-domain dedication in `LICENSE.txt`. The conversion removes empty lines and comments, then writes a JSON string array so both platform bundles can load it without filesystem access.

The cleaner checks the domain and its parents. The list is bundled, so imports do not fetch third-party blocklists at runtime. Refreshes should review the upstream changes and rerun the import tests.
