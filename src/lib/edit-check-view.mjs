// The "too much, too little" check (src/lib/edit-check.mjs) in plain words, for the review steps.
// Pure and browser-safe (no Node imports): the review panel and the evals both use it.

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (wheres) => wheres.map((w) => `\`${w}\``).join(", ");
const gives = (outcome) => (outcome.startsWith("throws ") ? outcome : `returns \`${outcome}\``);

/** What taking a passenger out does, as far as calling the code side by side could tell. */
function differenceText(d) {
  if (d.status === "found") return `taking it out changes what the code does: \`${d.call}\` ${gives(d.with)} with it and ${gives(d.without)} without it.`;
  if (d.status === "none") return `taking it out changed nothing in ${d.tries} calls of the code (not proof that it changes nothing).`;
  return `what taking it out does was not compared: ${d.why}.`;
}

function tooMuch(edits) {
  const passengers = edits.filter((e) => e.verdict === "passenger");
  const needed = edits.filter((e) => e.verdict === "needed");
  if (passengers.length) {
    const changes = passengers.some((e) => e.difference.status === "found");
    const them = passengers.length === 1 ? "it" : "them";
    return `Too much: ${count(passengers.length, "edit", "edits")} no test needs: ${list(passengers.map((e) => e.where))}. Taking ${them} out ${changes ? "changes what the code does, and no test notices" : "changes nothing the tests see"}.`;
  }
  if (needed.length === 1) return "Too much: the edit is needed: taken out, it makes a test fail.";
  if (needed.length) return "Too much: every edit is needed: each one, taken out, makes a test fail.";
  return edits.length ? "Too much: the edits change only comments or layout." : "Too much: no code was changed, so there is nothing to take out.";
}

function tooLittle(edits, leftBehind) {
  if (!edits.length) return "Too little: no code was changed, so there is no old form to look for.";
  const wheres = [...new Set(leftBehind.map((x) => x.where))];
  if (!wheres.length) return "Too little: no old form left behind.";
  return `Too little: the old form is still at ${list(wheres)}: the change may have missed ${wheres.length === 1 ? "it" : "them"}.`;
}

function editText(edit) {
  if (edit.verdict === "comment-only") return "changes only comments or layout.";
  if (edit.verdict === "passenger") return `no test needs it; ${differenceText(edit.difference)}`;
  const more = edit.neededBy.length > 1 ? ` and ${count(edit.neededBy.length - 1, "other test", "other tests")}` : "";
  return `needed: without it, “${edit.neededBy[0]}”${more} fail${edit.neededBy.length > 1 ? "" : "s"}.`;
}

/**
 * The recorded check for one commit as a short summary (two lines) and a list, one item per edit and
 * per old form left behind. Null when there is no recorded result, so the panel shows nothing.
 * Text in backticks is code.
 */
export function editCheckSummary(check) {
  if (!check) return null;
  if (!check.testsPass) return { tone: "", tag: "not checked", lines: [`Not checked: ${count(check.failedOnChange.length, "test fails", "tests fail")} on this change, so taking edits out would show nothing.`], foldTitle: "", items: [] };
  const questions = check.edits.filter((e) => e.verdict === "passenger").length + new Set(check.leftBehind.map((x) => x.where)).size;
  return {
    tone: questions ? "warn" : "ok",
    tag: questions ? count(questions, "question", "questions") : "nothing found",
    lines: [tooMuch(check.edits), tooLittle(check.edits, check.leftBehind)],
    foldTitle: check.leftBehind.length ? "Each edit and old form, one by one" : "Each edit, one by one",
    items: [
      ...check.edits.map((e) => ({ where: e.where, text: editText(e) })),
      ...check.leftBehind.map((x) => ({ where: x.where, text: `still has the old form of \`${x.oldFormOf}\`: \`${x.line}\`` })),
    ],
  };
}
