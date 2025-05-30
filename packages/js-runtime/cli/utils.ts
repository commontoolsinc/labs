import { join, dirname } from "@std/path";
import { type TsArtifact } from "../interface.ts";

// Takes a list of filepaths and reads the files from disk,
// populating a `TsArtifact`.
export async function populateArtifact(
  rootDir: string,
  files: string[],
): Promise<TsArtifact> {
  const artifact: Partial<TsArtifact> = {
    files: [],
  };
  let fsRoot;
  for (const filepath of files) {
    const absPath = join(rootDir, filepath);
    const contents = await Deno.readTextFile(absPath);

    // The first file is the entry point.
    if (!fsRoot) {
      fsRoot = dirname(absPath);
    }

    const name = absPath.substring(fsRoot.length);
    if (!artifact.entry) {
      artifact.entry = name;
    }

    // Module path is relative to the entry point.
    // e.g. `ct run ../project/recipe.ts ../project/dir/utils.ts`
    // Will set module paths as `/recipe.ts` and `/dir/utils.ts`
    if (!absPath.startsWith(fsRoot)) {
      throw new Error(
        `File does not live within entry file project: ${absPath}`,
      );
    }
    artifact.files!.push({ name, contents });
  }
  return artifact as TsArtifact;
}