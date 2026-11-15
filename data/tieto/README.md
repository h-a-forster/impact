# Recorded packs for the real Tieto sample PRs

These files were produced by **Impact Ledger**, a companion tool built by the same team (source
commit `8435e5b528eb9e9863ff295012ed4fc689383c0b`), and copied here unchanged.

- `<change>/pack.json`: git diff facts, Roslyn symbol links, recorded `dotnet test` outcomes on base and
  head, one recorded AI review, and the ledger rows built from them.
- `<change>/factory.json`: severity and route from that tool's two rule-based classifiers.
- `concepts.json`: concept groups declared by hand in that tool.
- `review-policy.upstream.yml`: the policy those classifiers read.
- `LICENSE.upstream`, `NOTICE.upstream.md`: licence and notice for the data (MIT; includes excerpts of
  MessagePack-CSharp, MIT).

The other files here (`fullmap.json`, `<change>/blast*`, `<change>/swarm.json`) were recorded by this
project's own scripts in `scripts/`.

This project shows the packs in the same Impact Map as the shop sample. It does not re-run the C# tests
(no .NET SDK on the build machine) and does not recompute severity or route for these PRs.
