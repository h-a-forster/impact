// Monte Carlo swarm: N agents of one model got the same task. How often did they end up close to the real change?
// Recorded by scripts/record-swarm.mjs into data/tieto/<pr>/swarm.json. This file only does the maths.
//
// THE SIMILARITY RULE (the README says the same):
//   Each change is a set of "things": the product code files it touches, plus the functions
//   in them it edits that already existed. Docs and unit tests are left out, as in the trust label.
//   Similarity = things both changes touch / things either change touches   (Jaccard, 0 to 100%)
//   A run is "similar" to the real change when its similarity is 50% or more.
//   "Agents agree with each other" = the average similarity over every pair of agents (worked out on the page).
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
        key: `${id}:${r.n}`,
        model: id,
        modelLabel: m.label,
        n: r.n,
        things: [...mine.keys()],
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
    return { id, label: m.label, runs };
  });
  // What the Run button can play: each model on its own, and the demo mix. Only recorded runs, never made up.
  const runOf = (model, n) => models.find((m) => m.id === model)?.runs.find((r) => r.n === n);
  const sets = models.map((m) => ({ id: m.id, label: m.label, runs: m.runs.map((r) => r.key) }));
  const mix = (rec.mix ?? []).map(([model, n]) => runOf(model, n)).filter(Boolean);
  if (mix.length) {
    // In the order the mix lists them.
    const parts = [...new Set(mix.map((r) => r.modelLabel))].map((l) => [l, mix.filter((r) => r.modelLabel === l).length]);
    sets.unshift({ id: "mix", label: `Mix: ${parts.map(([l, k]) => `${k} ${l}`).join(", ")}`, runs: mix.map((r) => r.key) });
  }
  return {
    pr: prId,
    recorded: true,
    recordedAt: rec.recordedAt,
    prompt: rec.prompt,
    how: rec.how,
    notBuilt: rec.notBuilt,
    similarAt: pct(SIMILAR_AT),
    real: [...real.values()].map((t) => t.label),
    // The demo default: the first set (the mix when there is one), all of its runs.
    defaultSet: sets[0].id,
    // Shown in the model list even when nothing is recorded for them.
    choices: ["mix", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
    choiceLabels: { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5", "claude-fable-5-2": "Fable 5.2" },
    maxAgents: 10,
    sets,
    runs: models.flatMap((m) => m.runs),
  };
}
