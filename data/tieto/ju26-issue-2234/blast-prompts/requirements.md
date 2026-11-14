## Requirements (from the pull request description)

Requirement: Bug report #2234 in MessagePack-CSharp.

Why: The report says the code checker "does not work" when code generation is turned off. It does not say what goes wrong.

Before and after: Before: a repeated or mixed key made the tool crash.

Must preserve: The code generator uses the same code. It must not quietly drop a member.

## The bug report the Requirement row points to (issue #2234, word for word)

# The analyzer does not work if SuppressSourceGeneration = true

#### Bug description

The analyzer does not work if SuppressSourceGeneration = true. This has happened since version 3.1.1. It still worked in 3.1.0.
