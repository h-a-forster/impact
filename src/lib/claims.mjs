import { readFileAt } from "./git.mjs";
import { matchesAny } from "./classifier.mjs";

export const CLAIM_VERIFIER_LABEL = "Rule-based claim verifier";

const short = (sha) => (sha ?? "").slice(0, 7);

/** A citation is only usable when the file and line exist at the reviewed commit. */
export function checkFileCitation(sha, cite) {
  if (!cite?.file) return { ok: false, reason: "No source cited." };
  const text = readFileAt(sha, cite.file);
  if (text === null) return { ok: false, reason: `Citation invalid: ${cite.file} does not exist at commit ${short(sha)}.` };
  const lineCount = text.split("\n").length;
  if (cite.line && (cite.line < 1 || cite.line > lineCount)) {
    return { ok: false, reason: `Citation invalid: ${cite.file} has no line ${cite.line} at commit ${short(sha)}.` };
  }
  return { ok: true };
}

function verifyTestClaim(claim, ctx) {
  const test = ctx.tests.find((t) => t.id === claim.test);
  if (!test) {
    return { label: "Unverified", reason: `Citation invalid: the cited test was not found at commit ${short(ctx.sha)}.`, missing: "A test that exists at this commit." };
  }
  const link = { kind: "test", testId: test.id, file: test.file, line: test.line };
  if (!ctx.run) return { label: "Unverified", reason: "No test result is recorded for this commit.", missing: "A run of this test on this commit.", link };
  if (ctx.run.revision !== ctx.sha) {
    return {
      label: "Unverified",
      reason: `The only result on file is for commit ${short(ctx.run.revision)}, not this commit (${short(ctx.sha)}).`,
      missing: "A run of this test on this commit.",
      link,
    };
  }
  const result = ctx.run.tests.find((t) => t.id === test.id);
  if (!result) return { label: "Unverified", reason: "The cited test is not in the run for this commit.", missing: "A run that includes this test.", link };
  if (result.status !== "passed") return { label: "Unverified", reason: `The cited test ${result.status} on this commit.`, missing: "A passing run.", link };
  if (claim.supports && !test.reaches.includes(claim.supports)) {
    const target = ctx.labelOf(claim.supports);
    const actual = test.directCalls.map((d) => ctx.labelOf(d.to)).join(", ") || "nothing mapped";
    return {
      label: "Unverified",
      reason: `The cited test passed, but it does not reach ${target}. It exercises ${actual}. A valid link is not enough: the evidence must support this statement.`,
      missing: `A passing test that exercises ${target}.`,
      link,
    };
  }
  const proof = ctx.proofOf?.(test.id);
  const proofText =
    proof === "changed"
      ? " The same test fails on the base code, so the change caused this."
      : proof === "held"
        ? " The same test also passes on the base code, so this behaviour held; it does not show the change caused it."
        : "";
  return {
    label: "Verified",
    proof: proof ?? null,
    reason: `"${test.name}" passed on this commit (${ctx.run.kind} run)${claim.supports ? ` and reaches ${ctx.labelOf(claim.supports)}` : ""}. This confirms the case it exercises.${proofText}`,
    link,
  };
}

function verifyOne(claim, ctx) {
  // Step 1 for every claim: the cited source must exist at the reviewed commit.
  if (claim.cite) {
    const c = checkFileCitation(ctx.sha, claim.cite);
    if (!c.ok) return { label: "Unverified", reason: c.reason, missing: "A citation that exists at the reviewed commit." };
  }
  switch (claim.kind) {
    case "symbol-changed": {
      const sym = ctx.index.symbols.find((s) => s.id === claim.symbol);
      if (!sym) return { label: "Unverified", reason: `Citation invalid: ${claim.symbol} not found at commit ${short(ctx.sha)}.`, missing: "An existing symbol." };
      const link = { kind: "diff", file: sym.file, line: sym.line };
      if (!ctx.editedIds.includes(sym.id)) return { label: "Unverified", reason: `The diff does not change ${sym.name}().`, missing: "A diff that edits this function.", link };
      return {
        label: "Verified",
        reason: `The diff changes ${sym.name}() in ${sym.file}. The diff establishes the edit. It does not establish behaviour in each workflow.`,
        link,
      };
    }
    case "test-passed":
      return verifyTestClaim(claim, ctx);
    case "behaviour": {
      const ev = ctx.evidenceByNode.get(claim.node);
      const call = claim.cite ? ctx.index.calls.find((c) => c.from === claim.node && c.file === claim.cite.file && c.line === claim.cite.line) : null;
      const link = claim.cite ? { kind: "source", file: claim.cite.file, line: claim.cite.line, nodeId: claim.node } : null;
      if (claim.cite && !call) {
        return { label: "Unverified", reason: `Citation invalid: no mapped call at ${claim.cite.file}:${claim.cite.line} at commit ${short(ctx.sha)}.`, missing: "A real call site.", link };
      }
      if (ev?.status === "supported") {
        const t = ctx.tests.find((x) => x.id === ev.supportingTests[0]);
        return { label: "Verified", reason: `"${t.name}" passed on this commit and reaches ${ctx.labelOf(claim.node)}.`, link: { kind: "test", testId: t.id, file: t.file, line: t.line } };
      }
      return {
        label: "Unverified",
        reason: `The call link is real (${call?.confidence ?? "mapped"}), so there is a path to inspect. A call link is not a test result. ${ev?.missing ?? "No test on this commit exercises this workflow for the requirement."}`,
        missing: ev?.suggestedCheck ?? "A targeted test on this commit.",
        link,
      };
    }
    case "suite-green": {
      if (!ctx.run || ctx.run.revision !== ctx.sha) {
        return { label: "Unverified", reason: "No test run is recorded for this commit.", missing: "A run on this commit." };
      }
      if (ctx.run.status !== "passed") return { label: "Unverified", reason: `The run on this commit failed (${ctx.run.counts.failed} failed).`, missing: "A passing run.", link: { kind: "run" } };
      return {
        label: "Verified",
        reason: `${ctx.run.counts.passed} of ${ctx.run.counts.total} tests passed on this commit (${ctx.run.kind} run). This establishes those ${ctx.run.counts.total} checks. It does not show that every workflow is covered.`,
        link: { kind: "run" },
      };
    }
    case "callers-complete": {
      const callers = ctx.index.calls.filter((c) => c.to === claim.symbol);
      return {
        label: "Inferred",
        reason: `The index resolved ${callers.length} caller(s) of ${ctx.labelOf(claim.symbol)} (${[...new Set(callers.map((c) => c.confidence))].join(", ") || "none"}). Dynamic calls and code outside this repo are not indexed, so this still needs confirmation.`,
        missing: "Confirmation from someone who knows the other consumers.",
        link: { kind: "node", nodeId: claim.symbol },
      };
    }
    case "files-only": {
      const outside = ctx.changedFiles.map((f) => f.file).filter((f) => !matchesAny(f, claim.paths));
      if (outside.length) return { label: "Unverified", reason: `The diff also changes: ${outside.join(", ")}.`, missing: "A diff limited to the stated paths.", link: { kind: "diff" } };
      return { label: "Verified", reason: `The diff only changes: ${ctx.changedFiles.map((f) => f.file).join(", ")}.`, link: { kind: "diff" } };
    }
    default:
      return { label: "Unverified", reason: "No traceable source establishes this statement.", missing: "A diff, test result or issue that supports it." };
  }
}

/** Claim verifier: a per-claim label, a short reason and a source link where available. */
export function verifyClaims(claims, ctx) {
  return (claims ?? []).map((claim) => ({ id: claim.id, text: claim.text, kind: claim.kind, ...verifyOne(claim, ctx) }));
}
