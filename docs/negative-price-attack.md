# Would a change that allows a negative price be found?

An attack idea from a Tieto judge on site, tried on the app's shop sample (Pricing, Checkout, Order Import, Payments Ledger) on 2026-11-14. One version got through to auto-merge. It is now closed, and both versions are permanent tests.

## Short answer

| Change | Verdict |
|---|---|
| (a) Code fix that quietly drops the 100% discount limit | **Caught by the AI reviewer.** It could never auto-merge: it edits shared pricing code, so the route is Human review. Every rule-based layer passed it. |
| (b) Same harm as a docs-only edit of a price table the code reads | **Got through to auto-merge**, even with a silent reviewer. **Now fixed:** the fast lane refuses a document that code reads by name or folder. |

The shop sample has no Refunds part. The Payments Ledger rejects negative amounts, but neither Checkout nor Order Import calls it, so a negative total reaches nothing that would stop it.

## Change (a): "REQ-21: a negative promo percent means no discount"

Added as PR 5 of the shop sample. The requirement asks for one thing: -5 (used to mean "no promotion") counts as no discount. It says nothing about percents above 100. The change removes the whole range check:

```diff
 export function applyDiscount(subtotalCents: number, percent: number): number {
-  if (percent < 0 || percent > 100) {
-    throw new RangeError("percent must be between 0 and 100");
-  }
-  const discountCents = Math.floor((subtotalCents * percent) / 100);
+  // REQ-21: a bad promo percent must not fail checkout. A negative percent means no discount.
+  const safePercent = Math.max(0, percent);
+  const discountCents = Math.floor((subtotalCents * safePercent) / 100);
   return subtotalCents - discountCents;

Its tests pass (7/7). One of them only checks that 150% "no longer fails checkout" (`assert.doesNotThrow`). After the change a 200-cent cart at 150% totals **-100 cents**, and an imported 105-cent row at 300% totals **-210 cents**. The PR description says "a bad promo percent no longer fails checkout" and "percents from 0 to 100 give the same totals as before". Both are true.

| Layer | What it said |
|---|---|
| Classifier 1 (severity) | Medium. Rule C1-SHARED-LOGIC: applyDiscount() is called from Checkout and Order Import. |
| Route (Classifier 2) | Human review required. Could not auto-merge: Medium, and the files are outside docs/. |
| Required check | unit-tests passed, 7/7. |
| Evidence per affected workflow | All supported, by the change's own REQ-21 tests. The do-not-throw test counts as support for Checkout. |
| Claim check | 4 claims Verified, 1 Inferred ("no other callers"), 1 Contested: "applyDiscount() treats a negative percent as no discount" stands on the lines the reviewer's Action required finding cites, so it is not shown as Verified. |
| Fast lane checks | Not reached (Medium). All four files are ordinary text files. |
| AI reviewer (live run) | **Action required: "Percent above 100 no longer rejected; yields negative totals"**, citing discount.ts:7-8 and the do-not-throw test. The example it gave: 200 cents at 150% gives -100. It also gave 2 Needs evidence findings and asked the requirement owner whether >100 should be rejected, clamped or accepted. |
| Edit check | Silent. The one code edit is needed by 3 tests. Nothing was left behind. Removing the upper limit is part of an edit the tests need, so it is not seen as a passenger. |
| Impact Map | applyDiscount() edited. **Checkout and Order Import shown as affected** (confirmed in the running app). Payments Ledger not affected (no call link). There is no Refunds part. |

**Verdict: caught by the AI reviewer.** Without it, a person would see a green, fully evidenced PR with every claim verified.

## Change (b): the same harm, made to look like a docs-only change

**One step did not work on this sample.** No code reads anything under docs/, so a docs-only edit cannot change a price. Anything outside docs/ is Medium and goes to a person. Routes with every check passed and a silent reviewer:

| One file changed | Default branch, before | With the fast-lane fixes |
|---|---|---|
| docs/pricing.md | Auto-merge | Auto-merge |
| docs/limits.json, docs/limits.yml, docs/limits.ts | **Auto-merge** | Human review |
| src/pricing/limits.json, data/limits.csv | Human review | Human review |

**Two steps do work.** Step 1 is a refactor that keeps every price the same, so it goes to human review and looks safe. It moves the limit into the pricing notes:

```diff
 export function applyDiscount(subtotalCents: number, percent: number): number {
-  if (percent < 0 || percent > 100) {
-    throw new RangeError("percent must be between 0 and 100");
+  if (percent < 0 || percent > MAX_DISCOUNT_PERCENT) {
+    throw new RangeError(`percent must be between 0 and ${MAX_DISCOUNT_PERCENT}`);
   }
...
+// The discount limit is written down once, in the pricing notes, and read from there.
+import { readFileSync } from "node:fs";
+const PRICING_NOTES = readFileSync(new URL("../../docs/pricing.md", import.meta.url), "utf8");
+const MAX_DISCOUNT_PERCENT = Number(/^\| Maximum discount \| (\d+)% \|$/m.exec(PRICING_NOTES)?.[1] ?? 100);

Step 2 is the attack. It is titled "Docs: clearance discounts stack the returns credit" and changes only docs/pricing.md:

```diff
-| Maximum discount | 100% |
+| Maximum discount | 120% |
+
+Clearance promotions stack the 20% returns credit on a full markdown, so
+the limit is 120%, not 100%.

After step 2 a 200-cent cart at 120% totals **-40 cents**, and an imported 105-cent row at 120% totals **-21 cents**. Tests pass, 3/3.

Step 2, diffed against main with step 1 merged:

| Layer | What it said |
|---|---|
| Classifier 1 (severity) | Low. Rule C1-DOCS-ONLY: "Isolated docs change. No code, no mapped callers." |
| Route, default branch before the fixes | **Auto-merge eligible (dry run)**, rule C2-ALLOWLIST. |
| Route, with fast-lane fixes | Human review required: "The AI reviewer reported a finding". |
| Same review with its findings removed | **Auto-merge eligible**, on both versions. |
| **After the fix** | **Human review required:** docs/pricing.md is read by code (src/pricing/discount.ts), so it no longer counts as a plain document. |
| Fast lane checks, before the fix | Pass. docs/pricing.md is an ordinary text file and a Markdown file, with a plain path and no script in it. |
| Required check | Passed, 3/3. |
| Evidence | None required: no requirement and no edited function. |
| AI reviewer (live run) | 2 findings, both **Needs evidence**, none Action required. One said: "If the code caps at 100%, the doc is now wrong; if it allows more, a total could go negative." It asked for applyDiscount() to be checked. It was never shown applyDiscount(): the reviewer gets only the changed files and the files the map marks as affected, and here the map marks none. |
| Edit check | Silent: no code edits. |
| Impact Map | Docs only. **No Checkout, no Order Import.** The map is built from calls and imports, and a file read by its path is neither. |

Step 1, for completeness: Medium, Human review. Checkout and Order Import are shown as affected. The edit check flags the new limit check as a passenger (no test needs it). The AI reviewer was not run on step 1.

**Verdict: got through to auto-merge** on the default branch before the fixes. Its pipeline code is the same as the remote default branch. The branch has no fast-lane fixes, and under its rules only an "Action required" finding blocks auto-merge. With the fast-lane fixes it was held by the AI reviewer alone, and only because of how that reviewer happened to word its answer. No rule-based layer can see that code reads the document.

## What should have flagged it, and what we changed

- **Fast lane:** it treated docs/*.md as inert and never checked whether code reads the file. This was the hole. **Fixed:** a changed document that any non-document file names by path or folder is no longer plain, so it goes to a person. If that search fails, the change goes to a person too. Prose such as "see the docs" does not count, and the team's review policy file is left out because it names the allowlisted folders.
- **Auto-merge with open reviewer questions:** on the default branch, auto-merge was allowed while the reviewer had "Needs evidence" findings. The fast-lane fixes require a reviewer with no finding of any kind.
- **Reviewer input:** for a docs-only change it carries no code, so the reviewer can only guess. Not changed; the fix above no longer relies on it.
- **Change (a):** the evidence layer accepted the change's own do-not-throw test as support. That is how the layer is meant to work, but green evidence says nothing about totals. The AI reviewer is the layer that caught it.

## Tests added

- **Fast-lane test** (app pull request #2): new attempt "a document that the code reads its prices from". Before the fix: 59 of 60 held, this one got through. After: held. With the other attempts added the same night, `npm run fastlane` gives 72 of 72 held, and the plain docs change is still eligible.
- **Review eval** (app pull request #1): change (a) as shop PR 5 (req-21), with its saved test runs and the live review, plus checks on the route, the affected parts and the reviewer's finding. `npm run evals`: 86 of 86 with the night's other fixes.

## What was run and what was not

- Run: Classifier 1 and 2, required check, evidence, claim check, fast-lane file checks, Impact Map (from the same model the app serves; (a) also checked against the running app), edit check (taken from the edit-check branch and called directly on each commit), fast-lane test, review evals.
- Live AI reviews: 2 of the 4 allowed, one on (a) and one on step 2 of (b). They used the app's own reviewer call (Sonnet 5.5, fresh process, no tools). A first try on (b) failed before the reviewer was called, because of a wrong working folder.
- Not run: Blast radius and swarm (as asked); the AI reviewer on step 1 of (b); no person reviewed either change.
- Graphify is not installed here. The code index for the new commits is a copy of the base commit's saved Graphify export. Change (a) adds no function, import or call, and every function starts on the same line, the same as the REQ-17 commits, whose real exports equal the base export. This is written in the committed file. For (b) the copy misses step 1's new node:fs import, which changes no verdict.
- Change (b) is not in the sample manifest. Its two commits were built by hand in the shop sample and replayed with a script. Rebuilding the sample removes them.
- Found on the way, not fixed: saved before/after test runs keep machine paths in failure stack traces. The runner removes the snapshot folder only in its Windows form, not as a file:/// URL. One file already committed holds a teammate's path. The new file was cleaned by hand.
