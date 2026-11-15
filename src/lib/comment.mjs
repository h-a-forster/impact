// "Copy as PR comment": a short Markdown summary of one review, to paste into GitHub.
// Pure and browser-safe (no Node imports): the chat UI and the evals both use it.

const MAX_POINTS = 5;
const MAX_UNCHECKED = 3;
const LEVEL = { block: "**Blocker:** ", major: "", minor: "Minor: " };

/** One line, cut at a word near `max` characters. */
function oneLine(text, max = 140) {
  const s = String(text).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : max).replace(/[\s,.;:]+$/, "") + "…";
}

/** Bullets, at most `max`, then one line for the rest. */
function bullets(lines, max) {
  const shown = lines.slice(0, max).map((l) => `- ${l}`);
  if (lines.length > max) shown.push(`- …and ${lines.length - max} more in the Impact Map`);
  return shown;
}

/**
 * What the review could not settle, from the model alone: claims it could not verify and
 * questions the AI reviewer could not decide. Missing proof is already an open point, so it is left out here.
 */
export function uncheckedOf(model) {
  return [
    ...model.claims.filter((c) => c.label !== "Verified").map((c) => `Claim ${c.label.toLowerCase()}: ${c.text}`),
    ...model.review.couldNotDecide.map((q) => `Reviewer could not decide: ${q.question}`),
  ];
}

/**
 * The comment itself.
 * - verdict, score: the first screen's advice (score null while a tool is still loading).
 * - points: the open points, each { level: "block" | "major" | "minor", title }.
 * - notRun: names of tools with no saved runs for this PR.
 * - url: the link back to this review.
 * - signOff: the commit's sign-off, if any. An override (a merge against the rules) is said under the heading.
 */
export function prComment({ model, verdict, score, points, notRun = [], url, signOff = null }) {
  const c2 = model.classifier2;
  const order = ["block", "major", "minor"];
  const open = [...points].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map((p) => LEVEL[p.level] + oneLine(p.title));
  const unchecked = [...uncheckedOf(model), ...notRun.map((n) => `${n}: not run`)].map((t) => oneLine(t));
  const head = `### Impact Map review: ${verdict}${score == null ? "" : ` (${score} / 100)`}`;
  const lines = [
    head,
    `**Route:** ${c2.route} · **Risk:** ${c2.severity} · commit \`${model.selected.short}\``,
    "",
    ...(signOff?.override ? [`**Merged against the rules by ${signOff.name}:** ${oneLine(signOff.override.reason)}`, ""] : []),
    open.length ? `**Open points (${open.length})**` : "**Open points:** none",
    ...bullets(open, MAX_POINTS),
  ];
  if (unchecked.length) lines.push("", "**Not checked**", ...bullets(unchecked, MAX_UNCHECKED));
  lines.push("", `[Open in Impact Map](${url})`);
  return lines.join("\n") + "\n";
}
