import { readDataFileSource } from "@commonfabric/js-compiler";
import type { RuntimeProgram } from "@commonfabric/runner";

/**
 * Attach data files to a resolved program.
 *
 * Every command that builds a program from local files goes through here, so a
 * pattern reads the same bytes under `cf check` and `cf test` that it will read
 * once deployed. A data file is read directly rather than resolved: nothing
 * imports one, so there is no closure to follow, and its bytes are never
 * parsed.
 *
 * `rootPath` grounds each file's stored name — the path `dataFile()` names it
 * by — so the same file attached from the same root is stored under the same
 * name whichever command attached it.
 *
 * Returns `program` unchanged when there is nothing to attach.
 */
export function attachDataFiles(
  program: RuntimeProgram,
  dataFilePaths: readonly string[] | undefined,
  rootPath: string,
): RuntimeProgram {
  if (!dataFilePaths?.length) return program;
  const files = [...program.files];
  const dataFiles: string[] = [];
  for (const path of dataFilePaths) {
    const source = readDataFileSource(path, rootPath);
    if (dataFiles.includes(source.name)) continue;
    // The program already reaches this name through an import, so it would have
    // to both compile the file and store it uninterpreted.
    if (files.some((file) => file.name === source.name)) {
      throw new Error(
        `Data file "${source.name}" is also a source module of this program.`,
      );
    }
    files.push(source);
    dataFiles.push(source.name);
  }
  return { ...program, files, dataFiles };
}
