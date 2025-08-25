import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { debounce } from "@std/async/debounce";
import { ResolvedConfig } from "./interface.ts";
import { blue, bold, dim, green, red, yellow } from "@std/fmt/colors";

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
      `${yellow("🔨")} ${dim("Building")} ${blue(this.manifest.entry)}...`,
    );

    try {
      const config: Parameters<typeof build>[0] = {
        define: resolveDefines(this.manifest),
        sourcemap: this.manifest.esbuild.sourcemap,
        minify: this.manifest.esbuild.minify,
        entryPoints: [this.manifest.entry],
        outfile: this.manifest.out,
        external: this.manifest.esbuild.external,
        supported: this.manifest.esbuild.supported,
        // Explicitly compile decorators, as this what Jumble->Vite
        // does, and no browsers currently support (any form of) decorators,
        // and if we're bundling, we're probably running in a browser.
        tsconfigRaw: this.manifest.esbuild.tsconfigRaw,
        logOverride: this.manifest.esbuild.logOverride,
      };

      if (this.manifest.esbuild.metafile) {
        config.metafile = true;
      }

      const result = await build(config);

      // Calculate build time
      const buildTime = Math.round(performance.now() - startTime);

      // Get output file size
      const fileInfo = await Deno.stat(this.manifest.out);
      const fileSize = formatFileSize(fileInfo.size);

      console.log(
        `   ${green("✓")} ${dim("Built")} ${blue(this.manifest.out)} ${
          dim(`(${fileSize})`)
        } ${green(`in ${buildTime}ms`)}`,
      );

      if (this.manifest.esbuild.metafile && result.metafile) {
        await Deno.writeTextFile(
          this.manifest.esbuild.metafile,
          JSON.stringify(result.metafile),
        );

        console.log(await esbuild.analyzeMetafile(result.metafile));
      }
      this.dispatchEvent(new CustomEvent("build"));
    } catch (error) {
      const buildTime = Math.round(performance.now() - startTime);
      console.error(
        `   ${red("✗")} ${red("Build failed")} ${dim(`after ${buildTime}ms`)}`,
      );
      throw error;
    }
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

// Exposes `esbuild`'s build functionality, applying
// default deno resolution plugins, browser platform,
// and ESM bundling format.
export async function build(
  config: Parameters<typeof esbuild.build>[0],
): Promise<ReturnType<typeof esbuild.build>> {
  const fullConfig = Object.assign({}, config, {
    plugins: [...denoPlugins()],
    platform: "browser",
    bundle: true,
    format: "esm",
  });

  const result = await esbuild.build(fullConfig);
  esbuild.stop();
  return result;
}
