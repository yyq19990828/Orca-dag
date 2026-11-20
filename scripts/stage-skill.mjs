import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Stage only managed files; never ship local preferences or follow symlinks. */
export function stageSkill(source, destination) {
  const entry = join(source, "SKILL.md");
  if (!lstatSync(source).isDirectory() || !lstatSync(entry).isFile()) {
    throw new Error(`Expected a regular skill directory and SKILL.md at ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  copyFileSync(entry, join(destination, "SKILL.md"));

  const refs = join(source, "references");
  if (!lstatSync(refs, { throwIfNoEntry: false })?.isDirectory()) return;
  const destRefs = join(destination, "references");
  mkdirSync(destRefs, { recursive: true });
  for (const name of readdirSync(refs).sort()) {
    if (!name.endsWith(".md") || name === "USER_PREFERENCES.md") continue;
    const file = join(refs, name);
    if (lstatSync(file).isFile()) copyFileSync(file, join(destRefs, name));
  }
}
