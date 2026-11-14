import YAML from "yaml";
import { readFileAt } from "./git.mjs";

export const ROUTES = {
  WAITING: "Waiting for checks or evidence",
  HUMAN: "Human review required",
  AUTO: "Auto-merge eligible (dry run)",
};
const RANK = { Low: 1, Medium: 2, High: 3 };
const maxSeverity = (a, b) => (RANK[a] >= RANK[b] ? a : b);

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else re += /[.+^${}()|[\]\\?]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp("^" + re + "$");
}
export const matchesAny = (file, globs = []) => (globs ?? []).some((g) => globToRegExp(g).test(file));

// Auto-merge allowlist: a folder alone is not enough, because code can live in a docs folder.
// Unless the policy lists extensions for an entry, only text documents qualify.
const DOCUMENT_EXTENSIONS = [".md", ".txt"];
const hasExtension = (file, extensions) => extensions.some((e) => file.toLowerCase().endsWith(e));
const isPlainPath = (file) => !file.startsWith("/") && !file.split("/").includes("..");

/**
 * The approved policy always comes from the base commit.
 * A PR that edits review-policy.yml cannot grant itself lighter checks.
 */
export function loadApprovedPolicy(baseSha) {
  const text = readFileAt(baseSha, "review-policy.yml");
  const policy = YAML.parse(text ?? "") ?? {};
  return {
    source: "base",
    revision: baseSha,
    file: "review-policy.yml",
    critical_paths: policy.critical_paths ?? [],
    docs_paths: policy.docs_paths ?? [],
    policy_paths: policy.policy_paths ?? [],
    required_checks: policy.required_checks ?? [],
    evidence: policy.evidence ?? {},
    auto_merge_dry_run: policy.auto_merge_dry_run ?? { allow: [] },
  };
}

/**
 * Classifier 1. Deterministic. Runs on PR open or new commit, before checks finish.
 * Inputs: diff, mapped callers, workflow reach, sensitive paths, rollback info.
 */
export function classifier1(policy, facts) {
  const files = facts.changedFiles.map((f) => f.file);
  const fired = [];
  let severity = "Low";

  const critical = files.filter((f) => matchesAny(f, policy.critical_paths));
  if (critical.length) {
    severity = maxSeverity(severity, "High");
    fired.push({
      rule: "C1-CRITICAL-PATH",
      severity: "High",
      reason: `Changes a team-designated critical path. Full human review is required even though only ${facts.editedCount} function(s) are edited.`,
      facts: critical,
    });
  }
  const policyFiles = files.filter((f) => matchesAny(f, policy.policy_paths));
  if (policyFiles.length) {
    severity = maxSeverity(severity, "High");
    fired.push({
      rule: "C1-POLICY-CHANGE",
      severity: "High",
      reason: "Changes the review rules themselves. The approved policy from the base commit still applies to this PR.",
      facts: policyFiles,
    });
  }
  if (facts.sharedEdits.length) {
    severity = maxSeverity(severity, "Medium");
    fired.push({
      rule: "C1-SHARED-LOGIC",
      severity: "Medium",
      reason: "Changes shared logic: an edited function is called from other workflows.",
      facts: facts.sharedEdits.map((s) => `${s.label} is called from ${s.callerConcepts.join(", ")}`),
    });
  }
  const allDocs = files.length > 0 && files.every((f) => matchesAny(f, policy.docs_paths));
  if (allDocs) {
    fired.push({ rule: "C1-DOCS-ONLY", severity: "Low", reason: "Isolated docs change. No code, no mapped callers.", facts: files });
  } else if (!fired.length) {
    severity = maxSeverity(severity, "Medium");
    fired.push({ rule: "C1-CODE-DEFAULT", severity: "Medium", reason: "Code change outside the docs allowlist. Defaults to Medium.", facts: files });
  }
  if (!facts.rollbackRecorded && severity === "Low") {
    severity = "Medium";
    fired.push({ rule: "C1-NO-ROLLBACK", severity: "Medium", reason: "No rollback recorded in the PR brief.", facts: [] });
  }

  const deciding = fired.find((f) => f.severity === severity) ?? fired[0];
  return {
    name: "Classifier 1",
    kind: "deterministic rules",
    severity,
    rule: deciding.rule,
    reason: deciding.reason,
    fired,
    facts: {
      changedFiles: files,
      editedFunctions: facts.editedCount,
      downstreamFunctions: facts.downstreamCount,
      workflowsReached: facts.workflowsReached,
      rollbackRecorded: facts.rollbackRecorded,
    },
  };
}

/**
 * Classifier 2. Deterministic. Applies the same approved policy after the
 * review and checks. Keeps or raises severity. Picks exactly one route.
 */
export function classifier2(policy, input) {
  const { initial, checks, evidence, review, changedFiles } = input;
  const files = changedFiles.map((f) => f.file);
  let severity = initial.severity;
  const notes = [];

  const actionRequired = (review?.findings ?? []).filter((f) => f.category === "Action required" && f.citationsValid);
  if (actionRequired.length && severity === "Low") {
    severity = "Medium";
    notes.push({ rule: "C2-RAISE-ON-ACTION", text: "Raised from Low: the reviewer reported a supported problem." });
  }

  const blockers = [];
  for (const c of checks) {
    if (c.status !== "passed") {
      blockers.push({
        type: "check",
        ref: c.name,
        status: c.status,
        text:
          c.status === "stale"
            ? `Required check "${c.name}" has a result for another commit (${c.resultRevision?.slice(0, 7)}). It does not count here.`
            : c.status === "missing"
              ? `Required check "${c.name}" has no result for this commit.`
              : c.status === "pending"
                ? `Required check "${c.name}" is still running.`
                : `Required check "${c.name}" failed on this commit.`,
      });
    }
  }
  for (const e of evidence) {
    if (e.status === "unverified") blockers.push({ type: "evidence", ref: e.nodeId, status: "unverified", text: e.missing, suggestedCheck: e.suggestedCheck });
  }

  let route;
  let rule;
  let reason;
  if (blockers.length) {
    route = ROUTES.WAITING;
    rule = "C2-WAIT";
    reason = "Required checks or evidence are missing, failed, stale or pending. See the blockers.";
  } else {
    const allow = (policy.auto_merge_dry_run?.allow ?? []).find(
      (a) => a.severity === severity && files.length > 0 && files.every((f) => isPlainPath(f) && matchesAny(f, a.paths) && hasExtension(f, a.extensions ?? DOCUMENT_EXTENSIONS)),
    );
    const reviewAvailable = review && review.available;
    // The fast lane fails closed: at least one check ran, and the reviewer reported no finding of any kind.
    const reviewerSilent = reviewAvailable && !(review.findings ?? []).length;
    if (severity === "Low" && allow && checks.length && reviewerSilent) {
      route = ROUTES.AUTO;
      rule = "C2-ALLOWLIST";
      reason = `Low severity, required checks passed, AI review available with no action required, and every changed file is on the dry-run allowlist (${allow.paths.join(", ")}). Dry run only. Nothing is merged.`;
    } else {
      route = ROUTES.HUMAN;
      rule = severity === "High" ? "C2-HUMAN-FULL" : "C2-HUMAN";
      reason =
        severity === "High"
          ? "High severity. A named engineer must do a full review."
          : !reviewAvailable && severity === "Low"
            ? "The AI review is unavailable, so this cannot qualify for auto-merge. A named engineer decides."
            : reviewAvailable && severity === "Low" && !reviewerSilent
              ? "The AI reviewer reported a finding, so this cannot qualify for auto-merge. A named engineer decides."
              : "Required checks and evidence are in. A named engineer decides.";
      if (actionRequired.length) reason += " The reviewer reported a problem that needs resolution.";
    }
  }

  return {
    name: "Classifier 2",
    kind: "deterministic rules",
    initialSeverity: initial.severity,
    severity,
    rule,
    reason,
    route,
    blockers,
    notes,
    autoMergeDryRun: route === ROUTES.AUTO,
  };
}
