# context.md

Demo version. This file is made up for the demo.

In the real feature, the coding agent saves this file with its pull request.
It is a snapshot of what the agent knew and decided while it worked.
The Q&A agent reads it, so you can ask "what were you thinking?" later.

## Snapshot

- Model: claude-sonnet-5-5
- Snapshot: snap-2297-a0aa5ab
- Branch: ju26-issue-2297
- Commit: a0aa5ab

## The task

Feature request #2297 in MessagePack-CSharp.

Generated code is hard to test. It drags the coverage number down.

## What must stay the same

Projects that build today must still build. Generated code must work the same.

## Files I changed

- `README.md`
- `src/MessagePack.SourceGenerator/Transforms/CompositeResolverTemplate.cs`
- `src/MessagePack.SourceGenerator/Transforms/CompositeResolverTemplate.tt`
- `src/MessagePack.SourceGenerator/Transforms/EnumTemplate.cs`
- `src/MessagePack.SourceGenerator/Transforms/EnumTemplate.tt`
- `src/MessagePack.SourceGenerator/Transforms/FormatterTemplate.cs`
- `src/MessagePack.SourceGenerator/Transforms/FormatterTemplate.tt`
- `src/MessagePack.SourceGenerator/Transforms/ResolverTemplate.cs`
- and 229 more files

## What I did

All 6 code templates add the mark. One shared helper, `EmitNestingTypesAndNamespaces()`, also adds a line break.

Before: generated code counts in coverage. After: it is marked `[ExcludeFromCodeCoverage]` and skipped. Older project types do not get the mark.

## Why I did it this way

I believed the mark does not exist on netstandard2.0 and .NET Framework. So I left it out there, to keep those projects building. I did not confirm this with a build.

## What I was least sure about

Resolver classes. The user writes half of that class and we generate the other half. If the user already added the mark, it is there twice and the build may fail.

## What I did not test

The new unit test looks for the mark in each file. It ignores build errors, so it would miss the double-mark case.

## Checks I ran

Unit tests (`dotnet test`, a saved run on one machine, not the automatic server run): 169 of 169 pass. The new unit test only looks for the mark once per file. It ignores build errors.

## How to undo it

Undo the commit. Then make the saved test output files again.
