import { homedir } from "node:os";
import { isAbsolute, parse, resolve, sep } from "node:path";

const windows = sep === "\\";
const invalidSegment = /[\\/<>:"|?*]|[. ]$/;
const deviceName =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.|$)/i;

export function hasControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function safeCloneSegment(segment: string): boolean {
  return (
    !!segment &&
    !invalidSegment.test(segment) &&
    !deviceName.test(segment) &&
    !hasControls(segment) &&
    segment.toLowerCase() !== ".git"
  );
}

export function pathSegments(path: string): string[] {
  return path.slice(parse(path).root.length).split(sep).filter(Boolean);
}

export function absolutePath(value: string, homeDirectory: string): string {
  if (!value || hasControls(value))
    throw new Error("Repository path is empty or contains control characters");
  const path = windows ? value.replaceAll("/", "\\") : value;
  const fromHome = path === "~" || path.startsWith(`~${sep}`);
  // Windows root-relative paths depend on the current drive. Device namespaces
  // bypass ordinary Win32 normalization; neither is an explicit checkout.
  if (
    !fromHome &&
    (!isAbsolute(path) ||
      (windows &&
        !/^(?:[a-z]:\\|\\\\(?![?.]\\)[^\\]+\\[^\\]+(?:\\|$))/i.test(path)))
  )
    throw new Error("Repository path must be fully absolute or start with ~/");

  if (windows && path.startsWith(sep + sep)) {
    const rootSegments = parse(path).root.split(sep).filter(Boolean);
    if (rootSegments.some((part) => !safeCloneSegment(part)))
      throw new Error("Repository path has an unsafe UNC authority");
  }
  const segments = fromHome
    ? path.slice(2).split(sep).filter(Boolean)
    : pathSegments(path);
  if (
    segments.some(
      (part) =>
        part === "." || part === ".." || (windows && !safeCloneSegment(part)),
    )
  )
    throw new Error("Repository path contains an unsafe path segment");
  return fromHome ? resolve(homeDirectory, ...segments) : resolve(path);
}

/** Lexical only: check filesystem state when a clone is requested. */
export function resolveClonePath(
  value: string,
  homeDirectory = homedir(),
): string {
  const path = absolutePath(value, homeDirectory);
  if (pathSegments(path).some((segment) => !safeCloneSegment(segment)))
    throw new Error("Clone path contains an unsafe path segment");
  return path;
}
