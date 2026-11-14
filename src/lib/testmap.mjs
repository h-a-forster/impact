import { listFiles, readFileAt } from "./git.mjs";
import { blockEnd } from "./graphify.mjs";

export const TEST_MAPPER_LABEL = "Rule-based test mapper (parses test(...) blocks; Graphify gave no symbols for test files)";

/**
 * Test mapper. Links each test to the code it exercises.
 * - Direct calls: an imported function name used inside the test block.
 *   The import itself is a Graphify EXTRACTED edge.
 * - Reach: follows Graphify call edges from those functions.
 * Run results are NOT joined here. They are joined later, by commit SHA.
 */
export function mapTests(sha, index) {
  const tests = [];
  const nameById = new Map(index.symbols.map((s) => [s.id, s.name]));
  const callsFrom = new Map();
  for (const c of index.calls) {
    if (!callsFrom.has(c.from)) callsFrom.set(c.from, []);
    callsFrom.get(c.from).push(c);
  }

  for (const file of listFiles(sha).filter((f) => /^tests\/.+\.test\.ts$/.test(f))) {
    const lines = (readFileAt(sha, file) ?? "").split("\n");
    const imported = index.imports.filter((i) => i.fromFile === file);
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:test|it)\(\s*(["'`])(.+?)\1\s*,/.exec(lines[i]);
      if (!m) continue;
      const name = m[2];
      const line = i + 1;
      const endLine = blockEnd(lines, line);
      const directCalls = [];
      const assertions = [];
      for (let ln = line; ln <= endLine; ln++) {
        const text = lines[ln - 1];
        if (/\bassert\b/.test(text)) assertions.push({ line: ln, text: text.trim() });
        for (const imp of imported) {
          const fn = nameById.get(imp.to);
          if (fn && new RegExp(`\\b${fn}\\s*\\(`).test(text) && !directCalls.some((d) => d.to === imp.to)) {
            directCalls.push({ to: imp.to, file, line: ln, confidence: "EXTRACTED", via: "import edge + call in test block" });
          }
        }
      }
      // Everything the test can reach through mapped calls.
      const reach = new Map();
      const queue = directCalls.map((d) => ({ id: d.to, path: [d.to] }));
      while (queue.length) {
        const { id, path } = queue.shift();
        if (reach.has(id)) continue;
        reach.set(id, path);
        for (const c of callsFrom.get(id) ?? []) queue.push({ id: c.to, path: [...path, c.to] });
      }
      tests.push({
        id: `test:${file}#${name}`,
        name,
        file,
        line,
        endLine,
        requirementIds: [...new Set(name.match(/\bREQ-\d+\b/g) ?? [])],
        assertions,
        directCalls,
        reaches: [...reach.keys()],
        reachPaths: Object.fromEntries(reach),
      });
      i = endLine - 1;
    }
  }
  return tests;
}
