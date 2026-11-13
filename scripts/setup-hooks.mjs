import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = realpathSync(process.cwd());
if (
  git("rev-parse", "--show-prefix") ||
  existsSync(join(git("rev-parse", "--git-dir"), "commondir"))
) {
  throw new Error("Run setup from the primary repository checkout.");
}

const hooksPath = join(root, ".githooks");
const getConfig = (...args) => {
  try {
    return git("config", ...args);
  } catch (error) {
    if (error.status !== 1) throw error;
    return null;
  }
};
const configured = getConfig("--get", "core.hooksPath");
const localConfigured = getConfig("--local", "--get", "core.hooksPath");

const sameHooks = (other) => {
  if (!existsSync(other) || !statSync(other).isDirectory()) return false;
  const oldFiles = readdirSync(other).sort();
  const newFiles = readdirSync(hooksPath).sort();
  return (
    oldFiles.length === newFiles.length &&
    oldFiles.every(
      (name, i) =>
        name === newFiles[i] &&
        statSync(join(other, name)).isFile() &&
        statSync(join(hooksPath, name)).isFile() &&
        readFileSync(join(other, name)).equals(
          readFileSync(join(hooksPath, name)),
        ),
    )
  );
};

if (configured !== null) {
  if (!isAbsolute(configured) || resolve(configured) !== hooksPath) {
    const copiedHooks =
      isAbsolute(configured) &&
      basename(configured) === ".githooks" &&
      localConfigured === configured &&
      (!existsSync(configured) || sameHooks(configured));
    if (!copiedHooks) {
      throw new Error(
        `Refusing to replace existing core.hooksPath: ${configured}`,
      );
    }
    git("config", "--local", "core.hooksPath", hooksPath);
  }
} else {
  const defaultHooks = resolve(root, git("rev-parse", "--git-path", "hooks"));
  if (
    existsSync(defaultHooks) &&
    readdirSync(defaultHooks).some((name) => {
      const file = join(defaultHooks, name);
      const entry = statSync(file);
      return (
        !name.endsWith(".sample") &&
        entry.isFile() &&
        (entry.mode & 0o111) !== 0
      );
    })
  ) {
    throw new Error(`Refusing to replace executable hooks in ${defaultHooks}`);
  }
  git("config", "--local", "core.hooksPath", hooksPath);
}
console.log(`Worktree hooks enabled: ${hooksPath}`);
