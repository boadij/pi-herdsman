import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = realpathSync(process.cwd());
if (
  root !== realpathSync(git("rev-parse", "--show-toplevel")) ||
  git("rev-parse", "--path-format=absolute", "--git-dir") !==
    git("rev-parse", "--path-format=absolute", "--git-common-dir")
) {
  throw new Error("Run setup from the primary repository checkout.");
}

const hooksPath = join(root, ".githooks");
let configured = null;
try {
  configured = git("config", "--get", "core.hooksPath");
} catch (error) {
  if (error.status !== 1) throw error;
}

if (configured !== null) {
  if (!isAbsolute(configured) || resolve(configured) !== hooksPath) {
    throw new Error(
      `Refusing to replace existing core.hooksPath: ${configured}`,
    );
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
