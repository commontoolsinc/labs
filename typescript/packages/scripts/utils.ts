import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

export async function bundle(inputPath: string, outputPath: string) {
  const result = await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: [inputPath],
    outfile: outputPath,
    bundle: true,
    format: "esm",
  });

  esbuild.stop();
}
