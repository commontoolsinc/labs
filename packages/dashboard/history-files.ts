import { join } from "@std/path";

type Environment = (name: string) => string | undefined;

export function dashboardCacheDirectory(
  env: Environment = Deno.env.get,
): string {
  return env("DASHBOARD_CACHE_DIR") ?? env("TMPDIR") ?? env("TEMP") ??
    env("TMP") ?? (Deno.build.os === "windows" ? "." : "/tmp");
}

export function dashboardCacheFile(
  basename: string,
  env: Environment = Deno.env.get,
): string {
  return join(dashboardCacheDirectory(env), basename);
}
