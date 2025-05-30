import { dirname, join } from "@std/path";
import { type TsArtifact } from "../interface.ts";

// Takes a list of absolute filepaths and reads the files from disk,
// populating a `TsArtifact`.
export async function populateArtifact(
  files: string[],
): Promise<TsArtifact> {
  const artifact: Partial<TsArtifact> = {
    files: [],
  };
  let fsRoot;
  for (const filepath of files) {
    const contents = await Deno.readTextFile(filepath);

    // The first file is the entry point.
    if (!fsRoot) {
      fsRoot = dirname(filepath);
    }

    const name = filepath.substring(fsRoot.length);
    if (!artifact.entry) {
      artifact.entry = name;
    }

    // Module path is relative to the entry point.
    // e.g. `ct run ../project/recipe.ts ../project/dir/utils.ts`
    // Will set module paths as `/recipe.ts` and `/dir/utils.ts`
    if (!filepath.startsWith(fsRoot)) {
      throw new Error(
        `File does not live within entry file project: ${filepath}`,
      );
    }
    artifact.files!.push({ name, contents });
  }
  return artifact as TsArtifact;
}

export function relativeToAbsolute(rootDir: string, filepath: string): string {
  return join(rootDir, filepath);
}
