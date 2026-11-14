# context.md

Demo version. This file is made up for the demo.

In the real feature, the coding agent saves this file with its pull request.
It is a snapshot of what the agent knew and decided while it worked.
The Q&A agent reads it, so you can ask "what were you thinking?" later.

## Snapshot

- Model: claude-sonnet-5-5
- Snapshot: snap-2283-9df83c3
- Branch: ju26-issue-2283
- Commit: 9df83c3

## The task

Bug report #2283 in MessagePack-CSharp.

The tool crashed on one kind of type that comes from another project. The build still looked fine. But a file the app needs was never made, so some apps broke when they ran.

## What must stay the same

Other types from another project already worked. They must still work, and still show their warnings.

## Files I changed

- `README.md`
- `doc/analyzers/MsgPack004.md`
- `src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs`
- `tests/MessagePack.SourceGenerator.Tests/GenericsFormatterTests.cs`

## What I did

All warnings now go through one new check, `ReportIfLocatedInCompilation()`. It drops any warning that points outside this project.

Before: the tool crashed and the file was missing. After: no crash. But warnings about code in another project are now hidden.

## Why I did it this way

The crash came from a type that lives in another project. There is no line in this project to point a warning at. A checker is not allowed to point outside the project. So I made one check, `ReportIfLocatedInCompilation()`, that every warning goes through.

## What I was least sure about

Whether I hide too many warnings. Some types from other projects worked fine before. A few of their warnings are now hidden. I did not check that.

## What I did not test

My unit tests check that the output file gets made. They do not check that it works. They also skip some kinds of types from other projects.

## Checks I ran

Unit tests (`dotnet test`, a saved run on one machine, not the automatic server run): 170 of 170 pass. One extra unit test for `GetObjectInfo()` passes on the old code and fails on the new code.

## How to undo it

Undo the commit. Nothing else to clean up.
