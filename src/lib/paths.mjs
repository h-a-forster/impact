import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SAMPLE_FIXTURES = path.join(ROOT, "sample");
export const BRIEFS = path.join(ROOT, "briefs");
export const DATA = path.join(ROOT, "data");
export const DEMO = path.join(ROOT, ".demo");
export const SAMPLE_REPO = path.join(DEMO, "shop-sample");
export const SNAPSHOTS = path.join(DEMO, "snapshots");
export const DECISIONS_FILE = path.join(DEMO, "decisions.json");
export const REVISIONS_FILE = path.join(DATA, "revisions.json");
