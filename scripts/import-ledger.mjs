// Copies the recorded review packs for the real Tieto sample PRs from the teammate
// repository (Impact Ledger, https://github.com/h-a-forster/junction26-earned-trust) into data/tieto/.
//   node scripts/import-ledger.mjs <path to a clone of that repository>
// The packs are data: git facts, Roslyn symbols, recorded `dotnet test` results and one
// recorded AI review per change. This project only reads them. It does not re-run them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../src/lib/paths.mjs";

const src = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(path.join(src, "demo", "concepts.json"))) {
  console.error("Usage: node scripts/import-ledger.mjs <path to a clone of junction26-earned-trust>");
  process.exit(1);
}
const out = path.join(DATA, "tieto");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// PR numbers match the GitHub replica (REA/github-replica/scripts/fetch-data.mjs).
const CHANGES = [
  { number: 1, id: "ju26-issue-2283" },
  { number: 2, id: "ju26-issue-2234" },
  { number: 3, id: "ju26-issue-2129" },
  { number: 4, id: "ju26-issue-2297" },
];
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};
const changes = [];
for (const c of CHANGES) {
  const dir = path.join(src, "demo", c.id);
  copy(path.join(dir, "pack.json"), path.join(out, c.id, "pack.json"));
  copy(path.join(dir, "factory.json"), path.join(out, c.id, "factory.json"));
  const pack = JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8"));
  changes.push({
    number: c.number,
    id: c.id,
    requirement: pack.requirement.id,
    title: pack.requirement.title ?? pack.change.head.subject,
    head: pack.change.head.sha,
    base: pack.change.base.sha,
    stages: pack.stages.map((s) => ({ id: s.id, label: s.label })),
    packSha256: pack.pack_sha256,
  });
  console.log(`  ${c.id}: ${pack.rows.length} rows, ${pack.stages.length} stage(s)`);
}
copy(path.join(src, "demo", "concepts.json"), path.join(out, "concepts.json"));
copy(path.join(src, "demo", "NOTICE.md"), path.join(out, "NOTICE.upstream.md"));
copy(path.join(src, "LICENSE"), path.join(out, "LICENSE.upstream"));
copy(path.join(src, "review-policy.yml"), path.join(out, "review-policy.upstream.yml"));

let sourceCommit = null;
try {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }).trim();
} catch {}
const index = {
  note: "Recorded review packs for the real Tieto sample PRs. Produced by the teammate project Impact Ledger. Read-only here.",
  source: "https://github.com/h-a-forster/junction26-earned-trust",
  sourceCommit,
  repo: "te-industry-tech-office/junction26-messagepack-csharp",
  changes,
};
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
fs.writeFileSync(
  path.join(out, "README.md"),
  `# Recorded packs for the real Tieto sample PRs

These files were produced by the teammate project **Impact Ledger**
(${index.source}, commit \`${sourceCommit ?? "unknown"}\`) and copied here by
\`node scripts/import-ledger.mjs\`. They are not edited.

- \`<change>/pack.json\`: git diff facts, Roslyn symbol links, recorded \`dotnet test\` outcomes on base and
  head, one recorded AI review, and the ledger rows built from them.
- \`<change>/factory.json\`: severity and route from that project's two rule-based classifiers.
- \`concepts.json\`: concept groups declared by hand in that project.
- \`review-policy.upstream.yml\`: the policy those classifiers read.
- \`LICENSE.upstream\`, \`NOTICE.upstream.md\`: licence and notice for the data (MIT; includes excerpts of
  MessagePack-CSharp, MIT).

This project shows them in the same Impact Map as the shop sample. It does not re-run the C# tests
(no .NET SDK on the build machine) and does not recompute severity or route for these PRs.
`,
);
console.log(`Imported ${changes.length} changes into ${path.relative(process.cwd(), out)}`);
