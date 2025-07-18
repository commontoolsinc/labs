import { join } from "@std/path/join";
import { type TsconfigRaw } from "esbuild";

export interface Config {
  // JS entry from root
  entry: string;
  // JS output from `outDir`
  out: string;
  // Output directory from root to place build artifacts.
  // Defaults to "dist".
  outDir: string;
  // Hostname to use during `serve` and `dev` commands.
  // Defaults to "127.0.0.1".
  hostname?: string;
  // Port to use during `serve` and `dev` commands.
  // Defaults to "5173".
  port?: number;
  // The public directory from root to copy to `outDir`
  // during `serve` and `dev` commands.
  // Defaults to "public".
  publicDir?: string;
  // The directory from root to watch for changes
  // to cause a JS rebuild during `dev`.
  // Defaults to "src".
  watchDir?: string;
  // While running a dev server, a regex to match
  // against a path, and if successful, will return
  // the root index.html.
  redirectToIndex?: RegExp;
  esbuild?: ESBuildConfig;
}

export interface ESBuildConfig {
  sourcemap?: boolean;
  minify?: boolean;
  // https://esbuild.github.io/api/#external
  external?: string[];
  // Maps environment variables at build time to
  // global variables in the bundled code.
  define?: Record<string, string | undefined>;
  metafile?: string;
  supported?: Record<string, boolean>;
  tsconfigRaw: TsconfigRaw;
}

export class ResolvedConfig {
  entry: string;
  out: string;
  outDir: string;
  hostname: string;
  port: number;
  publicDir: string;
  watchDir: string;
  redirectToIndex?: RegExp;
  esbuild: {
    sourcemap: boolean;
    external: string[];
    minify: boolean;
    metafile?: string;
    define: Record<string, string | undefined>;
    supported?: Record<string, boolean>;
    tsconfigRaw?: TsconfigRaw;
  };
  cwd: string;
  constructor(partial: Config, cwd = Deno.cwd()) {
    this.cwd = cwd;
    this.entry = join(cwd, partial.entry);
    this.outDir = join(cwd, partial.outDir ?? "dist");
    this.out = join(this.outDir, partial.out);
    this.publicDir = join(cwd, partial?.publicDir ?? "public");
    this.watchDir = join(cwd, partial?.watchDir ?? "src");
    this.hostname = partial?.hostname ?? "127.0.0.1";
    this.port = partial?.port ?? 5173;
    this.redirectToIndex = partial?.redirectToIndex;
    this.esbuild = {
      sourcemap: !!(partial?.esbuild?.sourcemap),
      minify: !!(partial?.esbuild?.minify),
      external: partial?.esbuild?.external ?? [],
      define: partial?.esbuild?.define ?? {},
      metafile: partial?.esbuild?.metafile
        ? join(cwd, partial.esbuild?.metafile)
        : undefined,
      supported: partial?.esbuild?.supported,
      tsconfigRaw: partial?.esbuild?.tsconfigRaw,
    };
  }
}

export type FeltCommand = "build" | "serve" | "dev";
