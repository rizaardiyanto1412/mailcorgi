# Unit decisions

A feature unit records any deviation from the architecture contract in its own file,
`docs/decisions/<unit>.md`. Describe the contract, the deviation, and why it is needed.
Units no longer edit `docs/architecture.md` directly. Keep each decision in the owning unit's file
so parallel branches can merge without sharing a documentation edit.
- [index-audit](index-audit.md)
- [sequences-send](sequences-send.md)
