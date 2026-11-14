// Takes a snapshot of the whole Tieto sample repo for the "Full map" tab.
// Real data, read once through the GitHub API (needs `gh`), then replayed from
// data/tieto/fullmap.json. Projects come from the file tree; links between
// projects come from <ProjectReference> lines in each .csproj.
//   Run with:  node scripts/snapshot-fullmap.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../src/lib/paths.mjs";

const TIETO = path.join(DATA, "tieto");
const index = JSON.parse(fs.readFileSync(path.join(TIETO, "index.json"), "utf8"));
const repo = index.repo;
const ref = index.changes[0].base;
const gh = (endpoint, jq) => execFileSync("gh", ["api", endpoint, "--jq", jq], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = JSON.parse(gh(`repos/${repo}/git/trees/${ref}?recursive=1`, '[.tree[] | select(.type == "blob") | .path]'));

// A project is a folder that holds a .csproj. Every file belongs to the deepest project above it.
const csprojs = files.filter((f) => f.endsWith(".csproj"));
const projectDirs = csprojs.map((f) => path.posix.dirname(f)).sort((a, b) => b.length - a.length);
const projectOf = (file) => projectDirs.find((d) => file.startsWith(d + "/")) ?? null;

const projects = new Map();
for (const proj of csprojs) {
  const dir = path.posix.dirname(proj);
  projects.set(dir, { id: dir, name: path.posix.basename(dir), group: dir.split("/")[0], csproj: proj, files: 0, references: [] });
}
let outside = 0;
for (const f of files) {
  const p = projectOf(f);
  if (p) projects.get(p).files += 1;
  else outside += 1;
}
for (const p of projects.values()) {
  const xml = Buffer.from(gh(`repos/${repo}/contents/${p.csproj}?ref=${ref}`, ".content"), "base64").toString("utf8");
  for (const m of xml.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
    const target = path.posix.dirname(path.posix.normalize(path.posix.join(p.id, m[1].replaceAll("\\", "/"))));
    if (projects.has(target) && !p.references.includes(target)) p.references.push(target);
  }
  console.log(`${p.id}: ${p.files} files, ${p.references.length} references`);
}

const out = {
  note: "Snapshot of the whole repository for the Full map tab. Read once from GitHub; not updated live.",
  repo,
  commit: ref,
  takenAt: new Date().toISOString(),
  totals: { files: files.length, projects: projects.size, filesOutsideProjects: outside },
  projects: [...projects.values()],
  files,
};
fs.writeFileSync(path.join(TIETO, "fullmap.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`Saved data/tieto/fullmap.json: ${out.totals.projects} projects, ${out.totals.files} files.`);
