# Notice for the sample data under `demo/` and `planted/`

The walkthrough reviews an agent-written change from Tieto's challenge sample,
`te-industry-tech-office/junction26-messagepack-csharp`, which is a copy of
[MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) with extra branches.

So that the demo runs without network access, these folders contain review data taken from that
repository: the diff of the change, the text of the changed files at the head commit, symbol and
reference facts extracted from the source generator project, test names and outcomes, and line
coverage. MessagePack-CSharp is licensed under the MIT License, copyright (c) All contributors
(its `LICENSE` file applies to those excerpts).

`requirement.source.md` is the text of upstream issue #2283, kept verbatim with its URL because
the issue is the requirement for the change. It is third-party text and is included as data.

Nothing here is code we wrote, except the files under `checks/` and `seeds.json`, which are ours
and are covered by this repository's MIT licence.
