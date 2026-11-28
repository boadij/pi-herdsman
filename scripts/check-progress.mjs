import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function repositoryPath(root, file) {
  const name = relative(root, file);
  if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) return undefined;
  return name.split(sep).join("/");
}

export default async function* checkProgress(source) {
  const cwd = process.cwd();
  const root = realpath(cwd);
  const active = new Map();

  for await (const { type, data } of source) {
    if (type !== "test:dequeue" && type !== "test:complete") continue;
    // In the Node 22.19 process-isolated runner, parent events have
    // null-prototype data; forwarded worker events lose it in serialization.
    // A worker's own test can otherwise match the exact file event shape.
    if (
      !root ||
      !data ||
      Object.getPrototypeOf(data) !== null ||
      data.nesting !== 0 ||
      data.line !== 1 ||
      data.column !== 1 ||
      typeof data.name !== "string" ||
      typeof data.file !== "string" ||
      resolve(cwd, data.name) !== data.file
    )
      continue;

    if (type === "test:dequeue") {
      const name = repositoryPath(cwd, data.file);
      if (!name || /[^a-zA-Z0-9_./-]/u.test(name) || active.has(data.file)) continue;
      const file = realpath(data.file);
      if (!file || !repositoryPath(root, file)) continue;
      active.set(data.file, name);
      yield `check: start ${name}\n`;
    } else {
      const name = active.get(data.file);
      if (!name) continue;
      active.delete(data.file);
      const elapsed = data.details?.duration_ms;
      const duration =
        Number.isFinite(elapsed) && elapsed >= 0 ? ` elapsed=${Math.round(elapsed)}ms` : "";
      yield `check: complete ${name}${duration}\n`;
    }
  }
}
