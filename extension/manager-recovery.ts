import {
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { sameDirectory } from "./herdr.ts";
import { sessionLeadRoleState } from "./supervision.ts";

export function readSavedManagerSession(
  session: { id: string; path: string },
  options: { checkout?: string; maxBytes?: number } = {},
) {
  const fd = openSync(
    session.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  let content: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error("Saved Manager session is not a regular file");
    const { maxBytes } = options;
    if (maxBytes === undefined) content = readFileSync(fd, "utf8");
    else {
      const tooLarge = () =>
        new Error("Saved Manager session exceeds the discovery read limit");
      if (stat.size > maxBytes) throw tooLarge();
      const buffer = Buffer.allocUnsafe(stat.size);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!count) break;
        length += count;
      }
      // The file may have grown after the size check. Do not validate a prefix.
      if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw tooLarge();
      content = buffer.toString("utf8", 0, length);
    }
  } finally {
    closeSync(fd);
  }
  const entries = parseSessionEntries(content);
  const header = entries[0];
  if (
    header?.type !== "session" ||
    header.id !== session.id ||
    typeof header.cwd !== "string" ||
    !isAbsolute(header.cwd) ||
    (options.checkout !== undefined &&
      !sameDirectory(header.cwd, options.checkout))
  )
    throw new Error(
      "Saved Manager session identity does not match the repository",
    );
  // Opening an existing file with Pi can migrate it. Inspect the branch in memory.
  const saved = SessionManager.inMemory(header.cwd, undefined, entries);
  return {
    checkoutPath: header.cwd,
    role: sessionLeadRoleState(saved.getBranch(), session.id)?.role,
  };
}
