import fs from "node:fs";
import path from "node:path";
import { git, listFiles, readFileAt } from "./git.mjs";
import { DEMO, SAMPLE_FIXTURES, SAMPLE_REPO, SNAPSHOTS } from "./paths.mjs";

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst);
    } else {
      // Normalise line endings so commit SHAs are the same on every machine.
      const text = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
      fs.writeFileSync(dst, text);
    }
  }
}

function commit(message, date, author) {
  const env = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  git(["add", "-A"]);
  git(["commit", "--no-verify", "--no-gpg-sign", "-m", message], { env });
  return git(["rev-parse", "HEAD"]).trim();
}

/**
 * Build the sample Git repo from fixtures. Real commits, fixed dates, so the
 * SHAs are stable and recorded evidence can be tied to them.
 */
export function buildSampleRepo() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLE_FIXTURES, "manifest.json"), "utf8"));
  fs.rmSync(SAMPLE_REPO, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(SAMPLE_REPO, { recursive: true });
  const emptyHooks = path.join(DEMO, "empty-hooks");
  fs.mkdirSync(emptyHooks, { recursive: true });

  git(["init", "-q", "-b", manifest.base.branch]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "core.hooksPath", emptyHooks]);
  git(["config", "commit.gpgsign", "false"]);

  copyTree(path.join(SAMPLE_FIXTURES, "base"), SAMPLE_REPO);
  const baseSha = commit(manifest.base.message, manifest.base.date, manifest.author);

  const prs = [];
  for (const pr of manifest.prs) {
    git(["checkout", "-q", "-b", pr.branch, manifest.base.branch]);
    const commits = [];
    for (const c of pr.commits) {
      copyTree(path.join(SAMPLE_FIXTURES, "commits", c.overlay), SAMPLE_REPO);
      const sha = commit(c.message, c.date, manifest.author);
      commits.push({ sha, message: c.message, date: c.date, index: commits.length + 1 });
    }
    prs.push({ id: pr.id, number: pr.number, title: pr.title, requirement: pr.requirement, kind: pr.kind, branch: pr.branch, commits });
  }
  git(["checkout", "-q", manifest.base.branch]);

  return {
    repoName: manifest.repoName,
    github: { ...manifest.github, fullName: `${manifest.github.owner}/${manifest.github.name}` },
    author: manifest.author,
    base: { sha: baseSha, branch: manifest.base.branch, message: manifest.base.message, date: manifest.base.date },
    prs,
  };
}

/** Write a clean copy of one revision outside the repo. Used for tests and indexing. */
export function snapshot(sha) {
  const dir = path.join(SNAPSHOTS, sha);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  for (const file of listFiles(sha)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readFileAt(sha, file));
  }
  return dir;
}

/** Base code with the tests/ folder of another commit. Used for before/after evidence. */
export function snapshotBaseWithTestsFrom(baseSha, sha) {
  const dir = path.join(SNAPSHOTS, `${sha}-on-base`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  const write = (from, file) => {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readFileAt(from, file));
  };
  for (const file of listFiles(baseSha)) if (!file.startsWith("tests/")) write(baseSha, file);
  for (const file of listFiles(sha)) if (file.startsWith("tests/")) write(sha, file);
  return dir;
}

/** A copy of one commit with one planted fault: `find` replaced by `replace` in `file`. */
export function snapshotWithFault(sha, fault) {
  const dir = path.join(SNAPSHOTS, `${sha}-fault-${fault.id}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  let applied = false;
  for (const file of listFiles(sha)) {
    let text = readFileAt(sha, file);
    if (file === fault.file && text.includes(fault.find)) {
      text = text.replace(fault.find, fault.replace);
      applied = true;
    }
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return { dir, applied };
}

export function allRevisions(revisions) {
  const out = [{ sha: revisions.base.sha, role: "base" }];
  for (const pr of revisions.prs) for (const c of pr.commits) out.push({ sha: c.sha, role: "commit", pr: pr.id });
  return out;
}
