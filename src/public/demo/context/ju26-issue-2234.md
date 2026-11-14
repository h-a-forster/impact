# context.md

Demo version. This file is made up for the demo.

In the real feature, the coding agent saves this file with its pull request.
It is a snapshot of what the agent knew and decided while it worked.
The Q&A agent reads it, so you can ask "what were you thinking?" later.

## Snapshot

- Model: claude-sonnet-5-5
- Snapshot: snap-2234-9007cee
- Branch: ju26-issue-2234
- Commit: 9007cee

## The task

Bug report #2234 in MessagePack-CSharp.

The report says the code checker "does not work" when code generation is turned off. It does not say what goes wrong.

## What must stay the same

The code generator uses the same code. It must not quietly drop a member.

## Files I changed

- `README.md`
- `src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs`
- `tests/MessagePack.SourceGenerator.ExecutionTests/SuppressedSourceGenerationTests.cs`
- `tests/MessagePack.SourceGenerator.Tests/SuppressSourceGenerationAnalyzerTests.cs`

## What I did

`GetObjectInfo()` now skips a member that has the wrong kind of key. It also stops adding the same key twice.

Before: a repeated or mixed key made the tool crash. After: it keeps the first member with that key and skips the later one.

## Why I did it this way

With code generation off, the checker still has to finish before it can warn you. A repeated key made it crash, so no warning came out. Now I keep the first member and skip the later one. The checker can finish and show the error.

## What I was least sure about

The bug report only says it "does not work". I guessed it meant the crash. I also changed code that the generator shares. It now makes output with a member missing, where it used to stop.

## What I did not test

No unit test runs the field part, only the property part. An empty key on a field still crashes.

## Checks I ran

Unit tests (`dotnet test`, a saved run on one machine, not the automatic server run): 175 of 175 pass. One extra unit test disagrees with the change.

## How to undo it

Undo the commit. Nothing else to clean up.
