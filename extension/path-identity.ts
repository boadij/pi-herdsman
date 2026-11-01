import { realpathSync, statSync } from "node:fs";

export function sameDirectory(left: string, right: string): boolean {
  try {
    const leftPath = realpathSync.native(left);
    const rightPath = realpathSync.native(right);
    const leftStat = statSync(leftPath, { bigint: true });
    const rightStat = statSync(rightPath, { bigint: true });
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    if (
      leftStat.dev !== 0n &&
      rightStat.dev !== 0n &&
      leftStat.ino !== 0n &&
      rightStat.ino !== 0n
    )
      return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
    return leftPath === rightPath;
  } catch {
    return false;
  }
}
