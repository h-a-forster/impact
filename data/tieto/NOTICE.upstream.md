# Notice for the data in `data/tieto/`

The real PRs come from Tieto's challenge sample, `te-industry-tech-office/junction26-messagepack-csharp`,
which is a copy of [MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) with
extra branches.

So that the demo runs without network access, this folder contains review data taken from that
repository: the diff of each change, the text of the changed files at the head commit, symbol and
reference facts extracted from the source generator project, test names and outcomes, and the text
of the upstream issues the changes answer. MessagePack-CSharp is licensed under the MIT License,
copyright (c) All contributors (its `LICENSE` file applies to those excerpts). The issue text is
third-party text, kept verbatim as data because the issue is the requirement for the change.

The rest (packs, classifier results, recorded agent runs) is ours and covered by the MIT licence in
`LICENSE.upstream` and the repository's `LICENSE`.
