import YAML from "yaml";
import { addressesAnAgent, readFileAt } from "./git.mjs";

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
// Unless the policy lists extensions for an entry, only Markdown qualifies (.txt is also what
// build files such as requirements.txt and CMakeLists.txt use).
const DOCUMENT_EXTENSIONS = [".md"];
const hasExtension = (file, extensions) => extensions.some((e) => file.toLowerCase().endsWith(e));
// No climbing out of the folder, no hidden files or folders, and a name with exactly one extension.
const isPlainPath = (file) => {
  const parts = file.split("/");
  return !file.startsWith("/") && parts.every((part) => part !== ".." && !part.startsWith(".")) && /^[\w -]+\.\w+$/.test(parts.at(-1));
};
// The fast lane fails closed: a file counts as ordinary only when the diff says so.
const isOrdinaryFile = (changed) => changed.oddity === null;

/**
 * Why the team's own limits on the fast lane hold this change back, or null.
 * Both come from the base commit's policy, so a pull request can neither lift a pause nor add its author.
 *   paused: areas where an escape or revert happened; only a person edits the list.
 *   trusted_authors: when present, every commit in the change must be by someone on it.
 */
function fastLaneHold(rules, files, authors) {
  const pause = (rules.paused ?? []).find((p) => files.some((f) => matchesAny(f, p?.paths)));
  if (pause) return { rule: "C2-PAUSED", text: `Auto-merge is paused here after an escape on ${pause.escape_on}; ${pause.owner} lifts it.` };
  const trusted = rules.trusted_authors;
  if (trusted == null) return null;
  const onList = (a) => Array.isArray(trusted) && trusted.includes(a);
  if (!authors?.length || !authors.every(onList)) return { rule: "C2-UNTRUSTED-AUTHOR", text: "The author is not on the team's trusted list for the fast lane." };
  return null;
}

/**
 * A description that speaks to the AI reviewer is trying to steer it. If the reviewer obeyed,
 * its silence proves nothing, so the fast lane does not count on it.
 */
function descriptionHold(description) {
  if (!addressesAnAgent(description)) return null;
  return { rule: "C2-ADDRESSES-REVIEWER", text: "The PR description contains text addressed to the AI reviewer or an agent, so a silent review does not count." };
}

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
  const { initial, checks, evidence, review, changedFiles, authors, description } = input;
  const files = changedFiles.map((f) => f.file);
  let severity = initial.severity;
  const notes = [];

  const actionRequired = (Array.isArray(review?.findings) ? review.findings : []).filter((f) => f.category === "Action required" && f.citationsValid);
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
    if (e.status !== "supported") blockers.push({ type: "evidence", ref: e.nodeId, status: "unverified", text: e.missing, suggestedCheck: e.suggestedCheck });
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
      (a) =>
        a.severity === severity &&
        files.length > 0 &&
        changedFiles.every(isOrdinaryFile) &&
        files.every((f) => isPlainPath(f) && matchesAny(f, a.paths) && hasExtension(f, a.extensions ?? DOCUMENT_EXTENSIONS)),
    );
    const reviewAvailable = review?.available === true;
    // The fast lane fails closed: every required check passed under its own name, and the reviewer reported no finding of any kind.
    const requiredPassed = checks.length > 0 && (policy.required_checks ?? []).every((name) => checks.some((c) => c.name === name && c.status === "passed"));
    const reviewerSilent = reviewAvailable && Array.isArray(review.findings) && review.findings.length === 0;
    const qualifies = severity === "Low" && allow && requiredPassed && reviewerSilent;
    const hold = qualifies ? (descriptionHold(description) ?? fastLaneHold(policy.auto_merge_dry_run, files, authors)) : null;
    if (hold) {
      route = ROUTES.HUMAN;
      rule = hold.rule;
      reason = `${hold.text} A named engineer decides.`;
    } else if (qualifies) {
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
