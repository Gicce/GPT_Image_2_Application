/**
 * SemVer 比较工具：内部版本号统一为 `4.0.2` 形式（不带 V 前缀、不带阶段后缀）。
 * UI 展示可以带 V 前缀，比较前先归一化。
 */

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, '');
}

export function parseSemver(version: string): SemverParts | null {
  if (!version) return null;
  const normalized = normalizeVersion(version);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(normalized);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

/** 返回 -1 / 0 / 1；任一侧无法解析时返回 null（调用方应视为不可比较，不得猜测大小）。 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/** candidate 是否严格大于 current（相等或不可比较返回 false）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) === 1;
}
