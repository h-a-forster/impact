import fs from "node:fs";
import path from "node:path";
import { ROUTES } from "./classifier.mjs";
import { DECISIONS_FILE } from "./paths.mjs";

export const ACTIONS = ["request-check", "escalate", "sign-off"];

export function loadDecisions(file = DECISIONS_FILE) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

/**
 * Record a named human decision for one commit.
 * - Old decisions are never edited or removed.
 * - A decision only applies to the commit it was made on.
 * - Sign-off is only accepted once the required evidence is in for that commit.
 */
export function recordDecision(model, input, file = DECISIONS_FILE) {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "A named engineer is required." };
  if (!ACTIONS.includes(input.action)) return { ok: false, error: `Unknown action: ${input.action}` };
  if (model.selected.isBase) return { ok: false, error: "Decisions are recorded on a PR commit, not on the base." };
  const route = model.classifier2.route;
  if (input.action === "sign-off") {
    if (route === ROUTES.WAITING) {
      return { ok: false, error: `Sign-off is not available on commit ${model.selected.short}: ${model.classifier2.blockers.map((b) => b.text).join(" ")}` };
    }
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
  };
  const all = loadDecisions(file);
  all.push(decision);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
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
    forThisCommit: here,
    history: history.map((d) => ({ ...d, appliesToSelection: d.commit === model.selected.sha })),
    canSignOff: !model.selected.isBase && model.classifier2.route !== ROUTES.WAITING,
  };
}
