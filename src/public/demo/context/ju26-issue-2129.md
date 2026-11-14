# context.md

Demo version. This file is made up for the demo.

In the real feature, the coding agent saves this file with its pull request.
It is a snapshot of what the agent knew and decided while it worked.
The Q&A agent reads it, so you can ask "what were you thinking?" later.

## Snapshot

- Model: claude-sonnet-5-5
- Snapshot: snap-2129-083afd9
- Branch: ju26-issue-2129
- Commit: 083afd9

## The task

Feature request #2129 in MessagePack-CSharp.

Project A cannot use MessagePack. So Project B needs to make the save-and-load code for Project A's type.

## What must stay the same

Projects that do not use the new marker must get the same output as before.

## Files I changed

- `README.md`
- `doc/analyzers/MsgPack019.md`
- `doc/analyzers/MsgPack020.md`
- `doc/analyzers/MsgPack021.md`
- `doc/analyzers/MsgPack022.md`
- `doc/analyzers/index.md`
- `src/MessagePack.Annotations/Attributes.cs`
- `src/MessagePack.SourceGenerator/AnalyzerReleases.Unshipped.md`
- and 20 more files

## What I did

A new marker, new code that finds the marked classes, 4 new warnings (`MsgPack019` to `MsgPack022`), and edits to the code templates.

Before: no way to do this. After: mark a class with `[GeneratedMessagePackFormatter]` and the code is made for you.

## Why I did it this way

The request asks for exactly this: mark a class and get the code made for you. The type itself cannot carry MessagePack marks, because its project cannot use MessagePack. So I read the type as it is. I added `SurrogateType` for when you want to pick the keys yourself.

## What I was least sure about

The project files. I added one project and edited two others. Your team treats those files as risky. I also did not handle map mode.

## What I did not test

The unit tests that ran only cover the 4 new warnings. The working case, where code is really generated, was not run.

## Checks I ran

Unit tests (`dotnet test`, a saved run on one machine, not the automatic server run): 173 of 173 pass. The 6 new unit tests that ran all stop before any code is generated.

## How to undo it

Undo the commit. Do it before a release, because users can see the new marker.
