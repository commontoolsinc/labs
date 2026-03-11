import * as esbuild from "esbuild";
import { denoPlugin } from "@deno/esbuild-plugin";
import { debounce } from "@std/async/debounce";
import { ResolvedConfig } from "./interface.ts";
import { blue, dim, green, red, yellow } from "@std/fmt/colors";

function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export class Builder extends EventTarget {
  constructor(public manifest: ResolvedConfig) {
    super();
  }

  async watch(watchRoot: string, debounceTimeout: number = 200) {
    const fn = debounce(async () => {
      try {
        await this.build();
      } catch (e: unknown) {
        const message = e && typeof e === "object" && "message" in e
          ? e.message
          : e;
        console.error(`   ${red("✗")} ${red("Error:")} ${message}`);
      }
    }, debounceTimeout);
    const watcher = Deno.watchFs(watchRoot);
    for await (const _ of watcher) {
      await fn();
    }
  }

  async build() {
    const startTime = performance.now();
    console.log(
      `${yellow("🔨")} ${dim("Building")} ${
        this.manifest.entries.map((e) => blue(e.in)).join(", ")
      }...`,
    );

    try {
      const config: Parameters<typeof build>[0] = {
        define: resolveDefines(this.manifest),
        sourcemap: this.manifest.esbuild.sourcemap,
        minify: this.manifest.esbuild.minify,
        entryPoints: this.manifest.entries,
        outdir: this.manifest.outDir,
        external: this.manifest.esbuild.external,
        supported: this.manifest.esbuild.supported,
        tsconfigRaw: this.manifest.esbuild.tsconfigRaw,
        logOverride: this.manifest.esbuild.logOverride,
      };

      if (this.manifest.esbuild.metafile) {
        config.metafile = true;
      }

      const result = await build(config);

      for (const output of result.outputFiles ?? []) {
        const fileInfo = await Deno.stat(output.path);
        const fileSize = formatFileSize(fileInfo.size);

        console.log(
          `   ${green("✓")} ${dim("Built")} ${blue(output.path)} ${
            dim(`(${fileSize})`)
          }`,
        );
      }
      if (this.manifest.esbuild.metafile && result.metafile) {
        await Deno.writeTextFile(
          this.manifest.esbuild.metafile,
          JSON.stringify(result.metafile),
        );
        console.log(await esbuild.analyzeMetafile(result.metafile));
      }

      // Generate build manifest with content hashes of output files.
      // Used for compilation cache fingerprinting.
      // See docs/specs/compilation-cache.md Phase 3.
      await this.writeBuildManifest();

      const buildTime = Math.round(performance.now() - startTime);
      console.log(`   ${dim(`Total build time: ${buildTime}ms`)}`);
      this.dispatchEvent(new CustomEvent("build"));
    } catch (error) {
      const buildTime = Math.round(performance.now() - startTime);
      console.error(
        `   ${red("✗")} ${red("Build failed")} ${dim(`after ${buildTime}ms`)}`,
      );
      throw error;
    }
  }

  /**
   * Write a build manifest containing SHA-256 hashes of each output file.
   * The manifest is used by the shell to fingerprint the worker bundle
   * for compilation cache invalidation.
   * See docs/specs/compilation-cache.md Phase 3.
   */
  private async writeBuildManifest(): Promise<void> {
    const manifest: Record<string, string> = {};
    for (const entry of this.manifest.entries) {
      // esbuild appends .js to entry.out; only .js outputs are hashed.
      const outPath = `${entry.out}.js`;
      try {
        const content = await Deno.readFile(outPath);
        const hash = await crypto.subtle.digest("SHA-256", content);
        const hex = Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        // Store with path relative to outDir
        const relPath = outPath.slice(this.manifest.outDir.length + 1);
        manifest[relPath] = hex;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    const manifestPath = `${this.manifest.outDir}/build-manifest.json`;
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }
}

function resolveDefines(
  manifest: ResolvedConfig,
): Record<string, string> {
  return Object.keys(manifest.esbuild.define).reduce((defines, envName) => {
    const value = manifest.esbuild.define[envName];
    defines[envName] = typeof value === "string" ? `"${value}"` : `undefined`;
    return defines;
  }, {} as Record<string, string>);
}

// Plugin to support Deno 2.4+ style text imports within esbuild:
// `import file from "./module.ts" with { type: "text" }`
function textLoaderPlugin(): esbuild.Plugin {
  return {
    name: "text-loader-plugin",
    setup(build) {
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (args.with.type !== "text") return undefined;
        const contents = await Deno.readTextFile(args.path);
        if (!contents) return undefined;
        return { contents, loader: "text" };
      });
    },
  };
}

// Exposes `esbuild`'s build functionality, applying
// default deno resolution plugins, browser platform,
// and ESM bundling format.
export async function build(
  config: Parameters<typeof esbuild.build>[0],
): Promise<ReturnType<typeof esbuild.build>> {
  const fullConfig = Object.assign({}, config, {
    plugins: [textLoaderPlugin(), denoPlugin()],
    platform: "browser",
    bundle: true,
    format: "esm",
  });

  const result = await esbuild.build(fullConfig);
  esbuild.stop();
  return result;
}
