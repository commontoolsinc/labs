// Build metadata baked into the toolshed binary at compile time.
//
// `tasks/build-binaries.ts` writes `packages/toolshed/COMPILED` and includes
// it in the binary via `deno compile --include`. At runtime we read it
// (synchronously, once) to surface the deployed commit on `/api/meta`.
//
// In non-compiled runs (e.g. `deno task production` from a checkout) the
// file does not exist and `commitSha` is null — callers should fall back
// to the `TOOLSHED_GIT_SHA` env var or treat it as unknown.

const COMPILED_PATH = new URL("../COMPILED", import.meta.url);

export interface BuildInfo {
  commitSha: string | null;
  builtAt: string | null;
}

function read(): BuildInfo {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(COMPILED_PATH);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (!raw.trim()) return { commitSha: null, builtAt: null };
  try {
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    return {
      commitSha: parsed.commitSha?.trim() ? parsed.commitSha : null,
      builtAt: parsed.builtAt?.trim() ? parsed.builtAt : null,
    };
  } catch {
    return { commitSha: null, builtAt: null };
  }
}

export const buildInfo: BuildInfo = read();
