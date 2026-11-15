// The chat's question box with no model: a typed question gets the closest saved answer, never new text.
// Pure and browser-safe (no Node imports): the chat UI and the evals both use it.

/** Share of the question's words a saved entry must have to answer it. Below it, the closest entries are offered. */
export const MATCH_AT = 0.5;
const SUGGEST = 3;

const STOPWORDS = new Set(("a an the is it its this that these those what whats how do does did can could would should will " +
  "you your u ur we our us i im me my of to in on for and or with by be been are was were about there here when which who " +
  "whom just really work please tell pr pull request so if any all some one").split(" "));

// Words that mean the same here, mapped to one form before stemming.
const SYNONYMS = {
  didn: "not", doesn: "not", isn: "not", don: "not", wasn: "not", weren: "not", aren: "not", hasn: "not", haven: "not",
  never: "not", without: "not", no: "not",
  used: "use",
  untested: "test", coverage: "test", covered: "test",
  revert: "undo", rollback: "undo", reverse: "undo",
  risky: "risk", danger: "risk", dangerous: "risk",
  broke: "break", broken: "break", breaks: "break",
  edit: "change", edits: "change", edited: "change", modify: "change", modified: "change", diff: "change",
  caller: "call", callers: "call", depend: "call", depends: "call", dependent: "call",
  reason: "why", purpose: "why",
  doubt: "unsure", worried: "unsure", uncertain: "unsure", confident: "unsure",
  ship: "merge", land: "merge",
  summarize: "summary", summarise: "summary", overview: "summary", tldr: "summary",
  llm: "model", gpt: "model",
};

/** A light stem, the same on both sides: tests, tested, testing -> test; changes, changed -> chang. */
export function stem(word) {
  let w = SYNONYMS[word] ?? word;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w) && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length - 3 >= 2) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length - 2 >= 3) w = w.slice(0, -2);
  if (/([^aeioulsz])\1$/.test(w)) w = w.slice(0, -1); // stopped -> stop
  if (w.endsWith("e") && w.length >= 3) w = w.slice(0, -1); // change, changed -> chang
  return SYNONYMS[w] ? stem(SYNONYMS[w]) : w; // stem the synonym too, so doubt and doubts meet
}

/** The words that carry meaning, stemmed. */
export function words(text) {
  const raw = String(text ?? "").toLowerCase().replace(/['’]s\b/g, "").match(/[a-z0-9]+/g) ?? [];
  const kept = raw.filter((w) => (w.length > 1 || /\d/.test(w)) && !STOPWORDS.has(w)).map(stem);
  // "What does this PR do?" is all stopwords: read it as asking for a summary.
  if (!kept.length && raw.some((w) => w === "do" || w === "does")) kept.push("summary");
  return new Set(kept);
}

const plain = (text) => (String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
const shared = (a, b) => [...a].filter((w) => b.has(w)).length;

/**
 * Saved entries ({ q, keys, a }) ranked by the share of the question's words found in their question and keys.
 * Ties go to the saved question those words cover most fully, then to the answer that shares most of them.
 */
export function closest(question, entries, n = SUGGEST) {
  const asked = words(question);
  const scored = entries.map((entry, i) => {
    const q = words(entry.q), all = new Set([...q, ...words(entry.keys)]);
    return {
      entry,
      score: asked.size ? shared(asked, all) / asked.size : 0,
      covers: q.size ? shared(asked, q) / q.size : 0,
      inAnswer: shared(asked, words(entry.a)),
      i,
    };
  });
  return scored.sort((x, y) => y.score - x.score || y.covers - x.covers || y.inAnswer - x.inAnswer || x.i - y.i).slice(0, n);
}

/**
 * The saved answer for a typed question, or the closest entries to offer instead.
 * { entry, score } when it answers; { entry: null, suggestions, near } when not (near: some word matched).
 */
export function match(question, entries) {
  const exact = entries.find((e) => plain(e.q) === plain(question));
  if (exact) return { entry: exact, score: 1, exact: true };
  const ranked = closest(question, entries);
  if (ranked[0] && ranked[0].score >= MATCH_AT) return { entry: ranked[0].entry, score: ranked[0].score, exact: false };
  return { entry: null, near: Boolean(ranked[0]?.score), suggestions: ranked.map((r) => r.entry) };
}

const ASKS = /^(what|whats|why|how|who|which|when|where|is|are|does|do|did|can|could|should|would|will|explain|define)\b|\?\s*$/;
const ORDERS = /\b(show|open|run|start|play|launch)\b/;
/** Phrased as a question ("what is blast radius?"), not a request ("run the blast radius", "show me the map?"). */
export const asksQuestion = (text) => ASKS.test(text.trim().toLowerCase()) && !ORDERS.test(text.toLowerCase());
