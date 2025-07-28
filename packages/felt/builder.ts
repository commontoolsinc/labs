import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { debounce } from "@std/async/debounce";
import { ResolvedConfig } from "./interface.ts";

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
      } catch (e: any) {
        const message = e && "message" in e ? e.message : e;
        console.error(message);
      }
    }, debounceTimeout);
    const watcher = Deno.watchFs(watchRoot);
    for await (const _ of watcher) {
      await fn();
    }
  }

  async build() {
    const startTime = performance.now();
    console.log(`Building ${this.manifest.entry}...`);

    try {
      const config: Partial<Parameters<typeof esbuild.build>[0]> = {
      define: resolveDefines(this.manifest),
      sourcemap: this.manifest.esbuild.sourcemap,
      minify: this.manifest.esbuild.minify,
      plugins: [...denoPlugins()],
      platform: "browser",
      entryPoints: [this.manifest.entry],
      outfile: this.manifest.out,
      external: this.manifest.esbuild.external,
      bundle: true,
      format: "esm",
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

    const result = await esbuild.build(config);
    esbuild.stop();

    // Calculate build time
    const buildTime = Math.round(performance.now() - startTime);
    
    // Get output file size
    const fileInfo = await Deno.stat(this.manifest.out);
    const fileSize = formatFileSize(fileInfo.size);
    
    console.log(`✓ Built ${this.manifest.out} (${fileSize}) in ${buildTime}ms`);

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
      console.error(`✗ Build failed after ${buildTime}ms`);
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
