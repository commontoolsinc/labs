import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { debounce } from "@std/async/debounce";
import { ResolvedConfig } from "./interface.ts";

export class Builder extends EventTarget {
  constructor(public manifest: ResolvedConfig) {
    super();
  }

  async watch(watchRoot: string, debounceTimeout: number = 200) {
    const fn = debounce(this.build.bind(this), debounceTimeout);
    const watcher = Deno.watchFs(watchRoot);
    for await (const _ of watcher) {
      await fn();
    }
  }

  async build() {
    console.log("Building...");

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
      // Explicitly compile decorators, as this what Jumble->Vite
      // does, and no browsers currently support (any form of) decorators,
      // and if we're bundling, we're probably running in a browser.
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
        },
      },
    };

    if (this.manifest.esbuild.metafile) {
      config.metafile = true;
    }

    const result = await esbuild.build(config);
    esbuild.stop();

    if (this.manifest.esbuild.metafile && result.metafile) {
      await Deno.writeTextFile(
        this.manifest.esbuild.metafile,
        JSON.stringify(result.metafile),
      );

      console.log(await esbuild.analyzeMetafile(result.metafile));
    }
    this.dispatchEvent(new CustomEvent("build"));
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
