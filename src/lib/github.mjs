// GitHub-shaped review state: prSummary() gives what an "Impact review" check would show. Live, per commit.
import { buildModel } from "./model.mjs";
import { decisionView } from "./decisions.mjs";
import { ROUTES } from "./classifier.mjs";

const short = (sha) => sha.slice(0, 7);

export function findPr(revisions, repo, number) {
  return revisions.prs.find((p) => String(p.number) === String(number) && (!repo || p.repo === repo)) ?? null;
}

/**
 * Review state for every commit of one PR, in the words a GitHub check uses.
 * Check status: "success" only when a named engineer signed off on that commit (an override
 * included, and its summary says so), or the dry-run allowlist applies. Everything else stays "pending".
 */
export function prSummary(revisions, pr, decisionsFile) {
  const commits = pr.commits.map((c) => {
    const model = buildModel(revisions, pr.id, c.sha);
    const decisions = decisionView(model, decisionsFile);
    const c2 = model.classifier2;
    const signOff = decisions.signOff;
    const waiting = c2.route === ROUTES.WAITING;
    const status = signOff || c2.route === ROUTES.AUTO ? "success" : "pending";
    const realSha = c.commitSha ?? c.sha; // recorded PRs: several evidence steps share one commit
    const recorded = model.source === "ledger";
    const summary = signOff?.override
      ? `Merged against the rules by ${signOff.name} on commit ${short(realSha)}: ${signOff.override.reason}. Not proven: ${signOff.override.open.join(" ")}`
      : signOff
      ? `Signed off by ${signOff.name} on commit ${short(realSha)}. Residual risk accepted: ${signOff.residualRisk}.`
      : waiting
        ? c2.blockers.map((b) => b.text).join(" ")
        : c2.route === ROUTES.AUTO
          ? "Policy dry run only. Nothing is merged."
          : `${c2.reason} Awaiting a named sign-off on commit ${short(realSha)}.`;
    return {
      sha: realSha,
      rev: c.sha,
      label: recorded ? c.label : `commit ${c.index}`,
      sameCommit: Boolean(c.sameCommit),
      recorded,
      index: c.index,
      message: c.message,
      status,
      severity: c2.severity,
      route: signOff ? `${c2.route} · ${signOff.override ? "overridden" : "signed off"}` : c2.route,
      rule: c2.rule,
      summary,
      blockers: c2.blockers.map((b) => ({ text: b.text, suggestedCheck: b.suggestedCheck ?? null })),
      counts: { edited: model.impact.edited.length, downstream: model.impact.downstream.length, unverified: model.impact.unverified.length },
      unverified: model.impact.unverified.map((u) => u.label),
      claims: {
        verified: model.claims.filter((x) => x.label === "Verified").length,
        inferred: model.claims.filter((x) => x.label === "Inferred").length,
        unverified: model.claims.filter((x) => x.label === "Unverified").length,
        contested: model.claims.filter((x) => x.label === "Contested").length,
      },
      aiReview: { available: model.review.available, label: model.review.modeLabel, findings: model.review.findings.length },
      signedOff: signOff ? { name: signOff.name, at: signOff.at, residualRisk: signOff.residualRisk, override: signOff.override } : null,
      humanActions: decisions.forThisCommit.map((d) => ({ action: d.action, name: d.name, at: d.at, requestedCheck: d.requestedCheck })),
      // CI-style rows for this commit. These are local runs, and say so.
      checks: model.checks.map((k) => ({
        workflow: recorded ? "dotnet test" : "Unit tests",
        name: k.name,
        event: recorded ? "recorded run" : "local run",
        status: k.status === "passed" ? "success" : k.status === "failed" ? "failure" : "pending",
        summary: k.counts
          ? `${k.counts.passed}/${k.counts.total} passed on ${short(realSha)} · ${recorded ? "recorded run, not re-run here" : "local run, not CI"}`
          : `No result for ${short(realSha)} (${k.status})`,
      })),
    };
  });
  return { repo: revisions.github.fullName, number: pr.number, prId: pr.id, title: pr.title, head: commits[commits.length - 1].sha, commits };
}
