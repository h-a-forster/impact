// Writes the shop-sample repo and its PRs into the GitHub replica's data folder.
//   node scripts/export-replica.mjs [path to github-replica]
// Default path: ../REA/github-replica (the sibling worktree).
import fs from "node:fs";
import path from "node:path";
import { exportReplicaData } from "../src/lib/github.mjs";
import { loadRevisions } from "../src/lib/model.mjs";
import { ROOT } from "../src/lib/paths.mjs";

const replica = path.resolve(process.argv[2] ?? process.env.REPLICA_DIR ?? path.join(ROOT, "..", "REA", "github-replica"));
if (!fs.existsSync(path.join(replica, "src", "data"))) {
  console.error(`GitHub replica not found at ${replica}\nPass its path:  node scripts/export-replica.mjs <path to github-replica>`);
  process.exit(1);
}
const revisions = loadRevisions();
const { repo, pulls } = exportReplicaData(revisions);
const out = path.join(replica, "src", "data", "repos", repo.name);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "repo.json"), JSON.stringify(repo, null, 2) + "\n");
fs.writeFileSync(path.join(out, "pulls.json"), JSON.stringify(pulls, null, 2) + "\n");
console.log(`Exported ${repo.fullName}: ${pulls.length} PRs -> ${out}`);
for (const p of pulls) console.log(`  #${p.number} ${p.title} (${p.commits.length} commit(s), ${p.stats.files} file(s))`);
