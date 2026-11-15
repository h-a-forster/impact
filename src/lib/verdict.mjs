// The first screen's verdict as one plain sentence: the decision in colour, then the single most
// important reason. "Cannot merge yet: Order Import has no test for the REQ-17 case."
// Pure and browser-safe (no Node imports): the chat UI and the evals both use it.

/** At most this many characters, so the sentence and the score fit on one line of the first screen. */
export const SENTENCE_MAX = 72;

/**
 * The open points of one commit, each as one line of problem and one line of fix.
 * - "block": proof is missing. The rules refuse a normal sign-off, so it cannot be acknowledged (only overridden).
 * - "major": the rule that raised the risk, and the AI review's important findings.
 * - "minor": the AI review's small findings. Shown folded.
 * An AI finding about the same code as a missing proof is folded into it, so one problem is one line.
 */
export function issueList(m) {
  const c2 = m.classifier2, out = [], folded = new Set();
  c2.blockers.forEach((b, i) => {
    const f = m.review.findings.find((x) => !folded.has(x) && sameCode(m, b, x));
    if (f) folded.add(f);
    out.push(f
      ? { id: `proof-${i}`, level: "block", title: f.title, fix: "Ask the author for a unit test that proves it.", detail: [b.text, f.detail].filter(Boolean).join(" "), citations: f.citations }
      : { id: `proof-${i}`, level: "block", title: b.text, fix: "Ask the author for a unit test that proves it." });
  });
  if (!c2.blockers.length && c2.rule === "T-contradicted") {
    out.push({ id: "rule", level: "major", title: c2.reason.split(". ")[0].replace(/\.$/, ""), fix: "Accept the change on purpose, or ask for a smaller fix.", detail: [c2.reason, ...c2.notes.map((n) => n.text)].join(" "), run: Boolean(m.run) });
  }
  for (const f of m.review.findings) if (!folded.has(f)) out.push({ id: f.id, level: f.category === "Minor" ? "minor" : "major", title: f.title, fix: f.fix ?? f.suggestedCheck, detail: f.detail, citations: f.citations });
  return out;
}
/**
 * A blocker and an AI finding point at the same code when the finding cites the blocker's file,
 * or names the area (concept) that file sits in. Blocker refs look like "fn:path#name".
 */
function sameCode(m, blocker, finding) {
  const file = blocker.ref?.replace(/^[a-z]+:/, "").split("#")[0];
  if (!file) return false;
  if ((finding.citations ?? []).some((c) => c.valid && c.file === file)) return true;
  const area = m.graph.nodes.find((n) => n.level === "concept" && file.startsWith(n.id.replace(/^concept:/, "") + "/"));
  return Boolean(area && finding.title.toLowerCase().includes(area.label.toLowerCase()));
}

// Words a cut line must not end on: "…has no test for the…" reads as if a word was lost.
const DANGLING = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "is", "its", "of", "on", "or", "so", "that", "the", "to", "with"]);

/** Text cut to at most `max` characters at a word boundary, ending in "…" when cut. A word is never split. */
export function cutAtWord(text, max) {
  const s = String(text).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const words = s.split(" "), kept = [];
  for (const w of words) {
    if ([...kept, w].join(" ").length + 1 > max) break;
    kept.push(w);
  }
  while (kept.length > 1 && DANGLING.has(kept.at(-1).replace(/[,;:]$/, "").toLowerCase())) kept.pop();
  if (!kept.length) kept.push(words[0]); // one word longer than the line: keep it whole
  return kept.join(" ").replace(/[\s,;:.–—-]+$/, "") + "…";
}

// A clause that turns the one before it around: "Validation is kept, but no test covers it" must not stop at the comma.
const TURN = /^(but|yet|although|though|except|unless|not|only)\b/i;

/**
 * The longest leading clause of the text (up to a comma, semicolon or dash) that fits in `max`, or "" when none does.
 * A clause of fewer than three words, or one the next clause turns around, does not count.
 */
export function firstClause(text, max) {
  const s = String(text).replace(/\s+/g, " ").trim();
  let best = "";
  for (const m of s.matchAll(/[,;] | [–—] /g)) {
    const head = s.slice(0, m.index), next = s.slice(m.index + m[0].length);
    if (head.length > max) break;
    if (head.split(" ").length >= 3 && !TURN.test(next)) best = head;
  }
  return best;
}
/** Text that fits in `max`: whole, else its first clause, else cut at a word with "…". */
function shorten(text, max) {
  return text.length <= max ? text : firstClause(text, max) || cutAtWord(text, max);
}

/**
 * A point's title as the second half of the sentence: no end stop, and a lower-case first word
 * unless it starts a name ("Order Import") or is an acronym ("README").
 */
function asReason(title) {
  const s = String(title).trim().replace(/\.$/, "").replace(/^No proof yet: /i, "No proof that ");
  const [first, second = ""] = s.split(" ");
  return /^[A-Z][a-z]*$/.test(first) && !/^[A-Z]/.test(second) ? first.toLowerCase() + s.slice(first.length) : s;
}

const count = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

/**
 * The sentence, from the first screen's data.
 * - verdict, tone: the advice's verdict ("Cannot merge yet", "bad"). tone is "ok", "warn" or "bad".
 * - auto: the rules would merge this by itself (route "Auto-merge eligible").
 * - points: issueList() of the commit, each with done = acknowledged.
 * - checksPassed: every required check passed. docsOnly: the change edits docs only.
 * - signedOff: { name, step, reason } once someone signed off this commit. reason is set only when
 *   they overrode the rules: then the sentence says so, never in green.
 * - because: the largest reason the score went down, said when no open point explains the verdict.
 * Returns the verdict and tone to show, the reason (cut to fit), the full reason, the point it names (lead), and whether it was cut.
 */
export function verdictSentence({ verdict, tone, auto = false, points = [], checksPassed = false, docsOnly = false, signedOff = null, because = "", max = SENTENCE_MAX }) {
  const open = points.filter((p) => !p.done);
  const say = (v, t, full, lead = null) => {
    const reason = shorten(full, max - v.length - 3); // ": " and the end stop
    return { verdict: v, tone: t, reason, full, lead, cut: reason !== full, text: `${v}: ${reason}${reason.endsWith("…") ? "" : "."}` };
  };
  if (signedOff?.reason) return say(`Merged against the rules by ${signedOff.name}`, "warn", String(signedOff.reason).trim().replace(/\.$/, ""));
  if (signedOff) return say("Merged", "ok", `${signedOff.name} signed off ${signedOff.step}`);
  // Blockers cannot be acknowledged, so "nothing open" here means every point was acknowledged.
  if (points.length && !open.length) return say("Ready for your sign-off", "ok", points.length === 1 ? "you acknowledged the one point" : `you acknowledged all ${points.length} points`);
  if (tone === "ok") {
    const v = auto ? "Could merge by itself" : verdict;
    if (open.length) return say(v, tone, `${count(open.length, "one point needs", "points need")} your OK first`);
    return say(v, tone, [docsOnly ? "docs only" : "nothing is open", checksPassed ? "every check passed" : ""].filter(Boolean).join(", "));
  }
  // Not fine: the first open point of the highest level, preferring one that fits whole, then one whose first clause fits.
  const level = ["block", "major", "minor"].find((l) => open.some((p) => p.level === l));
  if (!level) return say(verdict, tone, asReason(because || "The tools found something to look at first"));
  const top = open.filter((p) => p.level === level);
  const room = max - verdict.length - 3;
  const lead = top.find((p) => asReason(p.title).length <= room) ?? top.find((p) => firstClause(asReason(p.title), room)) ?? top[0];
  return say(verdict, tone, asReason(lead.title), lead.id);
}
