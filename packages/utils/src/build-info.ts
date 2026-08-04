// Reader for the `COMPILED` build-metadata file that `tasks/build-binaries.ts`
// writes next to a binary's entry package and includes via `deno compile
// --include`. The values travel with the artifact and identify the commit it
// was built from. Both the toolshed server and the cf CLI read their own copy
// through this module.

export interface BuildInfo {
  commitSha: string | null;
  builtAt: string | null;
}

export function normalize(s: string | null | undefined): string | null {
  const trimmed = s?.trim();
  return trimmed ? trimmed : null;
}

export function readBuildInfoFrom(path: URL | string): BuildInfo {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (!raw.trim()) return { commitSha: null, builtAt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { commitSha: null, builtAt: null };
  }
  const obj = parsed as Partial<BuildInfo>;
  return {
    commitSha: normalize(obj.commitSha),
    builtAt: normalize(obj.builtAt),
  };
}
