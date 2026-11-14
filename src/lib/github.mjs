// The bridge to the GitHub replica (REA/github-replica).
//  - prSummary(): what the "Impact review" check, bot comments and sidebar show. Live, per commit.
//  - exportReplicaData(): the shop-sample repo and its PRs in the replica's JSON shape.
import { git, listFiles, readFileAt } from "./git.mjs";
import { buildModel, loadBrief } from "./model.mjs";
import { decisionView } from "./decisions.mjs";
import { ROUTES } from "./classifier.mjs";

const short = (sha) => sha.slice(0, 7);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function findPr(revisions, repo, number) {
  return revisions.prs.find((p) => String(p.number) === String(number) && (!repo || p.repo === repo)) ?? null;
}

/**
 * Review state for every commit of one PR, in the words a GitHub check uses.
 * Check status: "success" only when a named engineer signed off on that commit,
 * or the dry-run allowlist applies. Everything else stays "pending".
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
    const summary = signOff
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
      route: signOff ? `${c2.route} · signed off` : c2.route,
      rule: c2.rule,
      summary,
      blockers: c2.blockers.map((b) => ({ text: b.text, suggestedCheck: b.suggestedCheck ?? null })),
      counts: { edited: model.impact.edited.length, downstream: model.impact.downstream.length, unverified: model.impact.unverified.length },
      unverified: model.impact.unverified.map((u) => u.label),
      claims: {
        verified: model.claims.filter((x) => x.label === "Verified").length,
        inferred: model.claims.filter((x) => x.label === "Inferred").length,
        unverified: model.claims.filter((x) => x.label === "Unverified").length,
      },
      aiReview: { available: model.review.available, label: model.review.modeLabel, findings: model.review.findings.length },
      signedOff: signOff ? { name: signOff.name, at: signOff.at, residualRisk: signOff.residualRisk } : null,
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

// ---------- export in the replica's data shape ----------
const svgAvatar = (letter, bg) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${bg}"/><text x="40" y="54" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">${letter}</text></svg>`);

function miniMarkdown(md) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let list = false;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p dir="auto">${inline(para.join(" "))}</p>`);
    para = [];
  };
  for (const line of md.split("\n")) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!li && list) {
      if (/^\s{2,}\S/.test(line)) {
        out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, " " + inline(line.trim()) + "</li>");
        continue;
      }
      out.push("</ul>");
      list = false;
    }
    if (h) {
      flush();
      out.push(`<h${h[1].length} dir="auto">${inline(h[2])}</h${h[1].length}>`);
    } else if (li) {
      flush();
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  if (list) out.push("</ul>");
  return out.join("\n");
}

function briefHtml(pr, brief, head) {
  const rev = brief.revisions[String(head.index)];
  const row = (k, v) => `<tr><th align="left">${k}</th><td>${v}</td></tr>`;
  return [
    `<p dir="auto">${pr.requirement ? `Implements <strong>${esc(pr.requirement)}</strong>. ` : ""}PR brief by ${esc(brief.author)}. Statements below are the author's claims. The Impact Map checks each one.</p>`,
    `<table>`,
    row("Requirement", esc(pr.requirement ?? "None linked")),
    row("Why", esc(brief.why)),
    row("Before", esc(brief.before)),
    row("After", esc(brief.after)),
    row("Behaviour to preserve", esc(brief.preserve)),
    row("Approach", esc(brief.approach)),
    row("Alternatives considered", esc(brief.alternatives ?? "None recorded")),
    row("Checks run", (rev.checksRun ?? []).map((c) => esc(c.label)).join("; ") || "None recorded"),
    row("Open gaps", (rev.openGaps ?? []).map(esc).join("; ") || "None stated"),
    row("Rollback", esc(brief.rollback)),
    `</table>`,
    `<p dir="auto"><strong>Claims</strong></p>`,
    `<ul>${rev.claims.map((c) => `<li>${esc(c.text)}</li>`).join("")}</ul>`,
  ].join("\n");
}

function prFiles(baseSha, headSha) {
  const status = new Map(
    git(["diff", "--name-status", baseSha, headSha]).split("\n").filter(Boolean).map((l) => {
      const [s, ...rest] = l.split("\t");
      return [rest[rest.length - 1], s[0] === "A" ? "added" : s[0] === "D" ? "removed" : s[0] === "R" ? "renamed" : "modified"];
    }),
  );
  return git(["diff", "--numstat", baseSha, headSha]).split("\n").filter(Boolean).map((l) => {
    const [add, del, filename] = l.split("\t");
    const full = git(["diff", "--unified=3", baseSha, headSha, "--", filename]);
    const at = full.indexOf("\n@@");
    return { filename, previousFilename: null, status: status.get(filename) ?? "modified", additions: Number(add), deletions: Number(del), patch: at >= 0 ? full.slice(at + 1).replace(/\n$/, "") : "" };
  });
}

export function exportReplicaData(revisions) {
  const gh = revisions.github;
  const base = revisions.base;
  const agentAvatar = svgAvatar("A", "#6639ba");
  const ownerAvatar = svgAvatar("J", "#0969da");
  const top = new Map();
  let tsBytes = 0;
  for (const file of listFiles(base.sha)) {
    const [first, ...rest] = file.split("/");
    top.set(first, rest.length ? "dir" : "file");
    if (file.endsWith(".ts")) tsBytes += (readFileAt(base.sha, file) ?? "").length;
  }
  const entries = [...top.entries()]
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === "dir" ? -1 : 1))
    .map(([name, type]) => ({ name, type, path: name, last: { sha: base.sha, message: base.message, date: base.date } }));
  const repo = {
    owner: gh.owner,
    ownerAvatar,
    name: gh.name,
    fullName: gh.fullName,
    private: false,
    forkOf: null,
    description: gh.description,
    homepage: "",
    topics: gh.topics,
    stars: 0,
    forks: 0,
    watchers: 1,
    license: "Demo fixture",
    languages: { TypeScript: tsBytes },
    defaultBranch: base.branch,
    branchCount: 1 + revisions.prs.filter((p) => p.source !== "ledger").length,
    commitCount: 1,
    head: { sha: base.sha, message: base.message, author: gh.authorLogin, authorAvatar: agentAvatar, date: base.date },
    entries,
    readmeHtml: `<article class="markdown-body entry-content container-lg" itemprop="text">${miniMarkdown(readFileAt(base.sha, "README.md") ?? "")}</article>`,
  };
  const pulls = revisions.prs.filter((p) => p.source !== "ledger").map((pr) => {
    const brief = loadBrief(pr.id);
    const head = pr.commits[pr.commits.length - 1];
    const files = prFiles(base.sha, head.sha);
    const issue = pr.requirement && gh.issues?.[pr.requirement];
    return {
      number: pr.number,
      title: pr.title,
      state: "open",
      branch: pr.branch,
      base: base.branch,
      author: gh.authorLogin,
      authorAvatar: agentAvatar,
      createdAt: pr.commits[0].date,
      body: `${brief.why}\n\n${brief.approach}`,
      bodyHtml: briefHtml(pr, brief, head),
      issue: issue ? { repo: gh.fullName, number: issue.number, title: issue.title, url: "#", state: "open", author: issue.author, labels: [] } : null,
      commits: pr.commits.map((c) => ({ sha: c.sha, message: c.message, author: gh.authorLogin, authorName: revisions.author.name, authorAvatar: agentAvatar, date: c.date })),
      stats: { additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0), files: files.length },
      files,
    };
  });
  return { repo, pulls };
}
