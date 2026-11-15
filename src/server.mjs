import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { readFileAt, revisionExists } from "./lib/git.mjs";
import { buildFullMap, buildModel, demoRevisions, loadRevisions } from "./lib/model.mjs";
import { ledgerSource } from "./lib/ledger.mjs";
import { loadTietoSlice } from "./lib/graphify-tieto.mjs";
import { buildBlast } from "./lib/blast.mjs";
import { buildSwarm } from "./lib/swarm.mjs";
import { decisionView, recordDecision } from "./lib/decisions.mjs";
import { findPr, prSummary } from "./lib/github.mjs";
import { DECISIONS_FILE, DEMO, REVISIONS_FILE, ROOT, SAMPLE_REPO } from "./lib/paths.mjs";

const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC = path.join(ROOT, "src", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
// Browser-safe lib modules the page imports, so the UI and the evals share one copy.
const SHARED = new Map(["comment.mjs", "edit-check-view.mjs", "reach.mjs", "verdict.mjs"].map((f) => [`/lib/${f}`, path.join(ROOT, "src", "lib", f)]));

if (!fs.existsSync(REVISIONS_FILE) || !fs.existsSync(SAMPLE_REPO)) {
  console.error("The demo is not set up yet. Run:  npm run setup");
  process.exit(1);
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

// Writes come only from this app's own pages (or a local script, which sends no Origin):
// a JSON content type cannot be sent cross-site without a preflight, and a foreign Origin is refused.
function refuseWrite(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return "POST bodies must be application/json";
  const origin = req.headers.origin;
  if (!origin || (URL.canParse(origin) && new URL(origin).host === req.headers.host)) return null;
  return `Cross-site request from ${origin} refused`;
}

// Eval test cases: PRs a person marked as "merged, then broke the system".
// They become test cases for the AI review agent. Saved per PR.
const EVAL_CASES_FILE = path.join(DEMO, "eval-cases.json");
const loadEvalCases = () => (fs.existsSync(EVAL_CASES_FILE) ? JSON.parse(fs.readFileSync(EVAL_CASES_FILE, "utf8")) : {});
function setEvalCase(prId, on) {
  const cases = loadEvalCases();
  if (on) cases[prId] = { markedAt: new Date().toISOString() };
  else delete cases[prId];
  fs.mkdirSync(DEMO, { recursive: true });
  fs.writeFileSync(EVAL_CASES_FILE, JSON.stringify(cases, null, 2) + "\n");
  return cases[prId] ?? null;
}

// Session mode (?session=1, used by timed review sessions): the routes serve the shop sample's
// pull requests, whose right answers are known, in place of the demo's list.
const revisionsSource = (url) => (url.searchParams.get("session") === "1" ? loadRevisions : demoRevisions);

function modelFor(prId, sha, revisions) {
  const model = buildModel(revisions, prId, sha);
  return { ...model, decisions: decisionView(model), evalCase: loadEvalCases()[prId] ?? null };
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const demoRevisions = revisionsSource(url); // shadows the import, so every route below follows the session switch
  try {
    if (req.method === "POST") {
      const refused = refuseWrite(req);
      if (refused) return json(res, 403, { error: refused });
    }
    if (url.pathname === "/api/revisions") {
      return json(res, 200, demoRevisions());
    }
    if (url.pathname === "/api/evalcase" && req.method === "POST") {
      const input = JSON.parse(await readBody(req));
      if (!demoRevisions().prs.some((p) => p.id === input.pr)) return json(res, 404, { error: `Unknown PR ${input.pr}` });
      return json(res, 200, { ok: true, evalCase: setEvalCase(input.pr, Boolean(input.on)) });
    }
    if (url.pathname === "/api/model") {
      return json(res, 200, modelFor(url.searchParams.get("pr"), url.searchParams.get("sha"), demoRevisions()));
    }
    if (url.pathname === "/api/graphify") {
      // The saved Graphify export for a PR (a slice of graph.json), as a file to read.
      const pr = demoRevisions().prs.find((p) => p.id === url.searchParams.get("pr"));
      const slice = pr ? loadTietoSlice(pr.commits[0].sha) : null;
      return slice ? json(res, 200, slice) : json(res, 404, { error: "No saved Graphify export for this pull request" });
    }
    if (url.pathname === "/api/blast") {
      // "Blast radius" tab: 3 recorded agent runs on the same task, compared with the real change.
      const pr = demoRevisions().prs.find((p) => p.id === url.searchParams.get("pr"));
      return pr ? json(res, 200, buildBlast(pr.id)) : json(res, 404, { error: `Unknown PR ${url.searchParams.get("pr")}` });
    }
    if (url.pathname === "/api/swarm") {
      // Monte Carlo swarm on the "Blast radius" tab: N recorded runs of one model, scored against the real change.
      const pr = demoRevisions().prs.find((p) => p.id === url.searchParams.get("pr"));
      return pr ? json(res, 200, buildSwarm(pr.id)) : json(res, 404, { error: `Unknown PR ${url.searchParams.get("pr")}` });
    }
    if (url.pathname === "/api/fullmap") {
      // The Full map is drawn over a snapshot of the Tieto repo, so only that repo's PRs go on it.
      // A session lists shop PRs only and keeps them all.
      const revisions = demoRevisions();
      const tieto = revisions.prs.filter((p) => p.source === "tieto");
      return json(res, 200, buildFullMap(tieto.length ? { ...revisions, prs: tieto } : revisions));
    }
    if (url.pathname === "/api/summary") {
      // Used by the GitHub replica: live state for the Impact review check, per commit.
      const revisions = demoRevisions();
      const pr = findPr(revisions, url.searchParams.get("repo"), url.searchParams.get("pr"));
      if (!pr) return json(res, 404, { error: `No Impact Map analysis for ${url.searchParams.get("repo")} PR #${url.searchParams.get("pr")}`, analysedRepo: revisions.github.fullName });
      return json(res, 200, prSummary(revisions, pr));
    }
    if (url.pathname === "/api/source") {
      const sha = url.searchParams.get("sha");
      const file = url.searchParams.get("file");
      const owner = demoRevisions().prs.find((p) => p.id === url.searchParams.get("pr"));
      if (owner?.source === "tieto") {
        // The text comes from the recorded pack (changed files at the head commit only).
        const r = ledgerSource(owner.id, file);
        return r.error ? json(res, 404, { error: r.error }) : json(res, 200, { sha, file, text: r.text });
      }
      if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !revisionExists(sha)) return json(res, 404, { error: `Unknown commit ${sha}` });
      const text = readFileAt(sha, file);
      if (text === null) return json(res, 404, { error: `${file} does not exist at commit ${sha.slice(0, 7)}` });
      return json(res, 200, { sha, file, text });
    }
    if (url.pathname === "/api/decisions" && req.method === "POST") {
      const input = JSON.parse(await readBody(req));
      const revisions = demoRevisions();
      const model = buildModel(revisions, input.pr, input.sha);
      const result = recordDecision(model, input);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      // "Reset demo" in the chat UI: forget every saved sign-off, so a merge can be shown again.
      fs.rmSync(DECISIONS_FILE, { force: true });
      return json(res, 200, { ok: true });
    }
    // Static files.
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = SHARED.get(url.pathname) ?? path.join(PUBLIC, rel);
    if (!(file.startsWith(PUBLIC) || SHARED.has(url.pathname)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(fs.readFileSync(file));
  } catch (err) {
    json(res, 500, { error: err.message });
  }
};
const server = http.createServer(handler);
// Also answer on IPv6 loopback: Node resolves "localhost" to ::1 first, browsers may use either.
http.createServer(handler).on("error", () => {}).listen(PORT, "::1");

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Code Review Impact Map: http://localhost:${PORT}`);
  console.log(`Open Impact Map link for the demo PR: http://localhost:${PORT}/#pr=ju26-issue-2283`);
  console.log(`GitHub replica link form:              http://localhost:${PORT}/?repo=<owner/name>&pr=<number>&sha=<sha>`);
});
