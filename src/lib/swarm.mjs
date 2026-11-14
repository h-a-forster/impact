// Monte Carlo swarm: N agents of one model got the same task. How often did they end up close to the real change?
// Recorded by scripts/record-swarm.mjs into data/tieto/<pr>/swarm.json. This file only does the maths.
//
// THE SIMILARITY RULE (the README says the same):
//   Each change is a set of "things": the product code files it touches, plus the functions
//   in them it edits that already existed. Docs and unit tests are left out, as in the trust label.
//   Similarity = things both changes touch / things either change touches   (Jaccard, 0 to 100%)
//   A run is "similar" to the real change when its similarity is 50% or more.
//   "Agents agree with each other" = the average similarity over every pair of agents.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./paths.mjs";

export const SIMILAR_AT = 0.5;
const file = (prId, name) => path.join(DATA, "tieto", prId, name);

/** The set of things a change touches. Keys: file path, or "file#function". */
export function thingsOf(files) {
  const out = new Map();
  for (const f of files ?? []) {
    if (f.kind !== "code") continue;
    out.set(f.file, { id: f.file, label: f.file.split("/").pop(), isFile: true });
    for (const x of f.functions ?? []) if (!x.isNew) out.set(`${f.file}#${x.key}`, { id: `${f.file}#${x.key}`, label: `${x.name}()`, isFile: false });
  }
  return out;
}
export function similarity(a, b) {
  const all = new Set([...a.keys(), ...b.keys()]);
  if (!all.size) return 1;
  let both = 0;
  for (const k of a.keys()) if (b.has(k)) both++;
  return both / all.size;
}

export function buildSwarm(prId) {
  if (!fs.existsSync(file(prId, "swarm.json")) || !fs.existsSync(file(prId, "blast.json"))) return { pr: prId, recorded: false, message: "No swarm runs recorded for this PR yet." };
  const rec = JSON.parse(fs.readFileSync(file(prId, "swarm.json"), "utf8"));
  const real = thingsOf(JSON.parse(fs.readFileSync(file(prId, "blast.json"), "utf8")).real.files);
  const pct = (x) => Math.round(x * 100);
  const models = Object.entries(rec.models).map(([id, m]) => {
    const sets = m.runs.map((r) => thingsOf(r.files));
    const runs = m.runs.map((r, i) => {
      const mine = sets[i];
      const score = similarity(mine, real);
      return {
        n: r.n,
        ok: r.exitCode === 0,
        noChange: r.files.length === 0,
        score: pct(score),
        similar: score >= SIMILAR_AT,
        shared: [...mine.values()].filter((t) => real.has(t.id)).map((t) => t.label),
        missed: [...real.values()].filter((t) => !mine.has(t.id)).map((t) => t.label),
        extra: [...mine.values()].filter((t) => !real.has(t.id)).map((t) => t.label),
        files: r.files.length,
        added: r.files.reduce((s, f) => s + f.added, 0),
        removed: r.files.reduce((s, f) => s + f.removed, 0),
        touchedDocs: r.files.some((f) => f.kind === "doc"),
        touchedTests: r.files.some((f) => f.kind === "test"),
        seconds: r.startedAt && r.endedAt ? Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000) : null,
        reply: r.reply,
        changes: r.files.map((f) => ({ file: f.file, kind: f.kind, added: f.added, removed: f.removed, patch: f.patch })),
      };
    });
    let pairs = 0, sum = 0;
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
      pairs++;
      sum += similarity(sets[i], sets[j]);
    }
    return { id, label: m.label, count: runs.length, runs, agentsAgree: pairs ? pct(sum / pairs) : null };
  });
  return {
    pr: prId,
    recorded: true,
    recordedAt: rec.recordedAt,
    prompt: rec.prompt,
    how: rec.how,
    notBuilt: rec.notBuilt,
    similarAt: pct(SIMILAR_AT),
    real: [...real.values()].map((t) => t.label),
    models,
  };
}
