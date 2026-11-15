// Monte Carlo swarm: N agents of one model got the same task. How often did they end up close to the real change?
// Recorded by scripts/record-swarm.mjs into data/tieto/<pr>/swarm.json. This file only does the maths.
// The shop sample's runs live in data/shop/<pr>/swarm.json (scripts/record-shop-swarm.mjs), which carries its own real change.
//
// THE SIMILARITY RULE:
//   Each change is a set of "things": the product code files it touches, plus the functions
//   in them it edits that already existed. Docs and unit tests are left out, as in the trust label.
//   Similarity = things both changes touch / things either change touches   (Jaccard, 0 to 100%)
//   A run is "similar" to the real change when its similarity is 50% or more.
//   "Agents agree with each other" = the average similarity over every pair of agents (worked out on the page).
//
// A SECOND SCORE, BY CHANGED LINES (shown in the matrix):
//   Each change is a set of the code lines it adds or removes in product code files, each line
//   with its file and a + or - mark, spaces squeezed, blank lines left out.
//   Line similarity = lines both changes add or remove / lines either one adds or removes.
//   It sees inside a function: two different fixes in the same function score low here.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./paths.mjs";

export const SIMILAR_AT = 0.5;
const DEFAULT_MODEL = "claude-sonnet-5-5";
const file = (prId, name) => path.join(DATA, "tieto", prId, name);
const shopFile = (prId) => path.join(DATA, "shop", prId, "swarm.json");

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
/** The set of changed lines in product code: "file|+text" or "file|-text". */
export function linesOf(files) {
  const out = new Map();
  for (const f of files ?? []) {
    if (f.kind !== "code") continue;
    let on = false;
    for (const raw of (f.patch ?? "").split("\n")) {
      if (raw.startsWith("@@")) on = true;
      else if (on && (raw[0] === "+" || raw[0] === "-")) {
        const text = raw.slice(1).trim().replace(/\s+/g, " ");
        if (text) out.set(`${f.file}|${raw[0]}${text}`, true);
      }
    }
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
  const demoRecorded = fs.existsSync(file(prId, "swarm.json")) && fs.existsSync(file(prId, "blast.json"));
  if (!demoRecorded && !fs.existsSync(shopFile(prId))) return { pr: prId, recorded: false, message: "No swarm runs recorded for this PR yet." };
  const rec = JSON.parse(fs.readFileSync(demoRecorded ? file(prId, "swarm.json") : shopFile(prId), "utf8"));
  const blast = demoRecorded ? JSON.parse(fs.readFileSync(file(prId, "blast.json"), "utf8")) : { runs: [] };
  const realFiles = demoRecorded ? blast.real.files : rec.real.files;
  const real = thingsOf(realFiles);
  const realLines = linesOf(realFiles);
  const pct = (x) => Math.round(x * 100);
  const LABEL = Object.fromEntries(Object.entries(rec.models).map(([id, m]) => [id, m.label]));
  /** One agent's run, scored against the real change. */
  const makeRun = ({ key, model, n, files, ok, seconds, reply, madeUp = false, from = null }) => {
    const mine = thingsOf(files);
    // A failed run, or one that changed nothing, agrees with nothing (two empty sets would score 100%).
    const counts = ok && files.length > 0;
    const score = counts ? similarity(mine, real) : 0;
    return {
      key,
      model,
      modelLabel: LABEL[model] ?? model,
      n,
      madeUp,
      from,
      things: [...mine.keys()],
      lines: [...linesOf(files).keys()],
      lineScore: counts ? pct(similarity(linesOf(files), realLines)) : 0,
      ok,
      noChange: files.length === 0,
      score: pct(score),
      similar: score >= SIMILAR_AT,
      shared: [...mine.values()].filter((t) => real.has(t.id)).map((t) => t.label),
      missed: [...real.values()].filter((t) => !mine.has(t.id)).map((t) => t.label),
      extra: [...mine.values()].filter((t) => !real.has(t.id)).map((t) => t.label),
      files: files.length,
      added: files.reduce((s, f) => s + f.added, 0),
      removed: files.reduce((s, f) => s + f.removed, 0),
      touchedDocs: files.some((f) => f.kind === "doc"),
      touchedTests: files.some((f) => f.kind === "test"),
      seconds,
      reply,
      changes: files.map((f) => ({ file: f.file, kind: f.kind, added: f.added, removed: f.removed, patch: f.patch })),
    };
  };
  const models = Object.entries(rec.models).map(([id, m]) => ({
    id,
    label: m.label,
    runs: m.runs.map((r) =>
      makeRun({
        key: `${id}:${r.n}`, model: id, n: r.n, files: r.files, ok: r.exitCode === 0, reply: r.reply,
        seconds: r.startedAt && r.endedAt ? Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000) : null,
      })),
  }));
  // The made-up demo set: real recorded changes, with made-up model names on them (see record-swarm.mjs).
  const SOURCE_NAME = { real: "Tieto's AI-written branch (the real change)", "blast:minimal": "the careful agent's run", "blast:normal": "the normal agent's run", "blast:wide": "the run of the agent that changes too much" };
  const filesFrom = (from) => {
    if (from === "real") return realFiles;
    if (from.startsWith("blast:")) return blast.runs.find((r) => r.id === from.slice(6))?.files ?? [];
    const [, model, n] = from.split(":");
    return rec.models[model]?.runs.find((r) => r.n === Number(n))?.files ?? [];
  };
  const demo = (rec.demo?.runs ?? []).map((d, i) => {
    const files = filesFrom(d.from).filter((f) => !d.only || d.only.includes(f.file));
    const fromName = SOURCE_NAME[d.from] ?? `swarm run ${d.from.split(":").slice(1).join(" #")}`;
    return makeRun({
      key: `demo:${i + 1}`, model: d.model, n: i + 1, files, ok: true, seconds: d.seconds ?? null, madeUp: true, from: d.from,
      reply: `Made up for the demo. This code is a real recorded change: ${fromName}${d.only ? `, only ${d.only.map((x) => x.split("/").pop()).join(", ")}` : ""}. The model name on it is made up.`,
    });
  });
  // What the Run button can play: each model on its own, and the demo mix. Only recorded runs, never made up.
  const runOf = (model, n) => models.find((m) => m.id === model)?.runs.find((r) => r.n === n);
  const sets = models.map((m) => ({ id: m.id, label: m.label, runs: m.runs.map((r) => r.key) }));
  const mix = (rec.mix ?? []).map(([model, n]) => runOf(model, n)).filter(Boolean);
  if (mix.length) {
    // In the order the mix lists them.
    const parts = [...new Set(mix.map((r) => r.modelLabel))].map((l) => [l, mix.filter((r) => r.modelLabel === l).length]);
    sets.unshift({ id: "mix", label: `Mix, real runs: ${parts.map(([l, k]) => `${k} ${l}`).join(", ")}`, runs: mix.map((r) => r.key) });
  }
  if (demo.length) {
    const parts = [...new Set(demo.map((r) => r.modelLabel))].map((l) => [l, demo.filter((r) => r.modelLabel === l).length]);
    sets.unshift({ id: "demo", madeUp: true, note: rec.demo.note, label: `Demo mix, made up: ${parts.map(([l, k]) => `${k} ${l}`).join(", ")}`, runs: demo.map((r) => r.key) });
  }
  // The default plays real runs whenever there are any: the default model's, else the first real set.
  // The made-up set stays in the menu.
  const realSets = sets.filter((x) => !x.madeUp && x.runs.length);
  const defaultSet = (realSets.find((x) => x.id === DEFAULT_MODEL) ?? realSets[0] ?? sets[0]).id;
  return {
    pr: prId,
    recorded: true,
    recordedAt: rec.recordedAt,
    prompt: rec.prompt,
    how: rec.how,
    notBuilt: rec.notBuilt,
    similarAt: pct(SIMILAR_AT),
    real: [...real.values()].map((t) => t.label),
    // The real change as sets, so the page can build the matrix (real change + agents, every pair).
    realThings: [...real.keys()],
    realLines: [...realLines.keys()],
    defaultSet,
    // Shown in the model list even when nothing is recorded for them.
    choices: ["demo", "mix", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
    choiceLabels: { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5", "claude-fable-5-2": "Fable 5.2" },
    maxAgents: 10,
    sets,
    runs: [...demo, ...models.flatMap((m) => m.runs)],
  };
}
