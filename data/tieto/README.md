# Recorded packs for the real Tieto sample PRs

These files were produced by the teammate project **Impact Ledger**
(https://github.com/h-a-forster/junction26-earned-trust, commit `8435e5b528eb9e9863ff295012ed4fc689383c0b`) and copied here by
`node scripts/import-ledger.mjs`. They are not edited.

- `<change>/pack.json`: git diff facts, Roslyn symbol links, recorded `dotnet test` outcomes on base and
  head, one recorded AI review, and the ledger rows built from them.
- `<change>/factory.json`: severity and route from that project's two rule-based classifiers.
- `concepts.json`: concept groups declared by hand in that project.
- `review-policy.upstream.yml`: the policy those classifiers read.
- `LICENSE.upstream`, `NOTICE.upstream.md`: licence and notice for the data (MIT; includes excerpts of
  MessagePack-CSharp, MIT).

This project shows them in the same Impact Map as the shop sample. It does not re-run the C# tests
(no .NET SDK on the build machine) and does not recompute severity or route for these PRs.
