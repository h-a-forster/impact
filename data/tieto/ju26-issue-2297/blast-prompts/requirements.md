## Requirements (from the pull request description)

Requirement: Feature request #2297 in MessagePack-CSharp.

Why: Generated code is hard to test. It drags the coverage number down.

Before and after: Before: generated code counts in coverage. After: it is marked `[ExcludeFromCodeCoverage]` and skipped.

Must preserve: Projects that build today must still build. Generated code must work the same.

## The feature request the Requirement row points to (issue #2297, word for word)

# Add ExcludeFromCodeCoverage attribute to generated code.

#### Is your feature request related to a problem? Please describe.
MessagePack generated code is not decorated with ExcludeFromCodeCoverage attribute.

Because it is very hard to write good coverage for generated MessagePack code, it may skew coverage numbers, especially on large projects with a lot of generated code.

#### Describe the solution you'd like
I would like all generated code to be decorated with ExcludeFromCodeCoverage attribute.  I do not feel like a setting is needed, but setting would be fine to have too.

#### Describe alternatives you've considered
There are no alternatives, it is close to impossible to write good coverage for generated code as it covers many edge cases.

#### Additional context

N/A
