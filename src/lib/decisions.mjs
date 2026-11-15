import fs from "node:fs";
import path from "node:path";
import { ROUTES } from "./classifier.mjs";
import { DECISIONS_FILE } from "./paths.mjs";

export const ACTIONS = ["request-check", "escalate", "sign-off"];
/** An override (a sign-off against the rules) needs a reason of at least this many characters. */
export const OVERRIDE_REASON_MIN = 10;

export function loadDecisions(file = DECISIONS_FILE) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

/**
 * Record a named human decision for one commit.
 * - Old decisions are never edited or removed.
 * - A decision only applies to the commit it was made on.
 * - Sign-off is only accepted once the required evidence is in for that commit, unless a named
 *   person overrides the rules on purpose: override true plus a reason. The override is recorded
 *   as such, with what was still open. Only this request can make one; no rule or AI path does.
 * With file null the decision is checked and returned, not saved (public demo).
 */
export function recordDecision(model, input, file = DECISIONS_FILE) {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "A named engineer is required." };
  if (!ACTIONS.includes(input.action)) return { ok: false, error: `Unknown action: ${input.action}` };
  if (model.selected.isBase) return { ok: false, error: "Decisions are recorded on a PR commit, not on the base." };
  const route = model.classifier2.route;
  const override = input.override === true;
  const reason = String(input.reason ?? "").trim();
  if (override && input.action !== "sign-off") return { ok: false, error: "Only a sign-off can override the rules." };
  if (input.action === "sign-off") {
    if (route === ROUTES.WAITING && !override) {
      return { ok: false, error: `Sign-off is not available on commit ${model.selected.short}: ${model.classifier2.blockers.map((b) => b.text).join(" ")} To merge anyway, override the rules and give a reason.` };
    }
    if (override && route !== ROUTES.WAITING) return { ok: false, error: `Nothing blocks commit ${model.selected.short}, so there is nothing to override. Sign off as usual.` };
    if (override && reason.length < OVERRIDE_REASON_MIN) return { ok: false, error: `Give a reason for merging against the rules (at least ${OVERRIDE_REASON_MIN} characters).` };
    if (!String(input.residualRisk ?? "").trim()) return { ok: false, error: "State the residual risk you accept (or write: none)." };
  }
  const decision = {
    id: `d${Date.now()}`,
    pr: model.pr.id,
    commit: model.selected.sha,
    commitIndex: model.selected.index,
    action: input.action,
    name,
    at: new Date().toISOString(),
    routeAtDecision: route,
    severityAtDecision: model.classifier2.severity,
    // What was checked, and by whom. Machine items are filled from the evidence on screen.
    checked: [
      ...model.checks.map((c) => ({ by: `Runner (${c.kind ?? "no"} run)`, what: `${c.name}: ${c.status}${c.counts ? ` (${c.counts.passed}/${c.counts.total})` : ""} on ${model.selected.short}` })),
      ...model.evidence.filter((e) => e.rowIds).map((e) => ({ by: "Recorded checks (Impact Ledger pack)", what: e.label + ": " + e.statusLabel })),
      ...model.evidence.filter((e) => e.status === "supported" && !e.rowIds).map((e) => ({ by: "Runner + test mapper", what: `${e.label}: ${e.supportingTests.length} ${model.pr.requirement} test(s) passed on ${model.selected.short}` })),
      { by: model.review.available ? `AI reviewer (${model.review.model}, recorded)` : "AI reviewer", what: model.review.available ? `${model.review.findings.length} finding(s), ${model.review.couldNotDecide.length} open question(s)` : "unavailable - rule-based fallback shown" },
      ...(String(input.checkedByHuman ?? "").trim() ? [{ by: name, what: String(input.checkedByHuman).trim() }] : []),
    ],
    unchecked: [
      ...model.evidence.filter((e) => e.status !== "supported").map((e) => ({ what: e.label, why: e.missing ?? e.statusLabel })),
      ...model.claims.filter((c) => c.label !== "Verified").map((c) => ({ what: `Claim: ${c.text}`, why: `${c.label}. ${c.reason}` })),
      ...model.review.couldNotDecide.map((q) => ({ what: q.question, why: `Reviewer could not decide. Would help: ${q.checkThatWouldHelp}` })),
      ...(String(input.uncheckedByHuman ?? "").trim() ? [{ what: String(input.uncheckedByHuman).trim(), why: "Stated by the engineer." }] : []),
    ],
    requestedCheck: input.action === "request-check" ? String(input.requestedCheck ?? "").trim() : null,
    residualRisk: String(input.residualRisk ?? "").trim() || null,
    note: String(input.note ?? "").trim() || null,
    // A sign-off against the rules: why, and what the rules still held open at that moment.
    override: override ? { reason, open: model.classifier2.blockers.map((b) => b.text) } : null,
  };
  if (file) {
    const all = loadDecisions(file);
    all.push(decision);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  }
  return { ok: true, decision };
}

/** Decision state for the selected commit, plus the full history for the PR. */
export function decisionView(model, file = DECISIONS_FILE) {
  const history = loadDecisions(file).filter((d) => d.pr === model.pr.id);
  const here = history.filter((d) => d.commit === model.selected.sha);
  const signOff = [...here].reverse().find((d) => d.action === "sign-off") ?? null;
  return {
    signedOff: Boolean(signOff),
    signOff,
    overridden: Boolean(signOff?.override),
    forThisCommit: here,
    history: history.map((d) => ({ ...d, appliesToSelection: d.commit === model.selected.sha })),
    canSignOff: !model.selected.isBase && model.classifier2.route !== ROUTES.WAITING,
  };
}
