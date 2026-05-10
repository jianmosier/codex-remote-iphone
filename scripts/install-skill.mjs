import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "skills", "codex-remote-iphone");
const targetRoot = process.env.CODEX_HOME
  ? resolve(process.env.CODEX_HOME, "skills")
  : resolve(homedir(), ".codex", "skills");
const target = resolve(targetRoot, "codex-remote-iphone");

await mkdir(targetRoot, { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
await writeFile(resolve(target, "project-root.txt"), `${root}\n`, "utf8");

console.log(`Installed codex-remote-iphone skill to ${target}`);
console.log(`Recorded project root in ${resolve(target, "project-root.txt")}`);
