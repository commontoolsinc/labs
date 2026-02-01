/**
 * VFS Bridge - Export/Import between VFS and real filesystem
 *
 * Provides utilities to export VFS files to a real directory for sandbox
 * consumption, and import modified files back into VFS with labels.
 */

import { VFS } from "../vfs.ts";
import { Label, Labeled } from "../labels.ts";

/**
 * Export VFS files to a real directory for sandbox consumption.
 * Returns a map of exported paths and their labels.
 *
 * @param vfs - The VFS to export from
 * @param vfsPaths - Paths in VFS to export
 * @param realBasePath - Base directory in real filesystem to export to
 * @returns Map of VFS paths to their labels
 */
export async function exportToReal(
  vfs: VFS,
  vfsPaths: string[],
  realBasePath: string,
): Promise<Map<string, Label>> {
  const labelMap = new Map<string, Label>();

  // Check if we have Deno filesystem APIs
  const hasDeno = typeof Deno !== "undefined" && typeof Deno.writeFile === "function";

  if (!hasDeno) {
    // In environments without Deno filesystem APIs, we can't export
    // This is expected in sandboxed contexts - just return empty map
    return labelMap;
  }

  for (const vfsPath of vfsPaths) {
    try {
      // Normalize VFS path
      const normalizedVfsPath = vfs.resolvePath(vfsPath);

      // Check if path exists in VFS
      if (!vfs.exists(normalizedVfsPath)) {
        continue;
      }

      // Get the node
      const node = vfs.resolve(normalizedVfsPath, true);
      if (!node) {
        continue;
      }

      if (node.kind === "file") {
        // Read file content and label
        const { value: content, label } = vfs.readFile(normalizedVfsPath);

        // Compute real filesystem path
        // Remove leading slash and join with base path
        const relativePath = normalizedVfsPath.startsWith("/")
          ? normalizedVfsPath.substring(1)
          : normalizedVfsPath;
        const realPath = `${realBasePath}/${relativePath}`;

        // Ensure parent directory exists
        const lastSlash = realPath.lastIndexOf("/");
        if (lastSlash > 0) {
          const parentDir = realPath.substring(0, lastSlash);
          try {
            await Deno.mkdir(parentDir, { recursive: true });
          } catch (e) {
            // Directory might already exist, that's ok
            if (!(e instanceof Deno.errors.AlreadyExists)) {
              throw e;
            }
          }
        }

        // Write file to real filesystem
        await Deno.writeFile(realPath, content);

        // Track label
        labelMap.set(normalizedVfsPath, label);
      } else if (node.kind === "directory") {
        // Export directory recursively
        const { value: entries } = vfs.readdir(normalizedVfsPath);

        for (const entry of entries) {
          const childPath = normalizedVfsPath === "/"
            ? `/${entry}`
            : `${normalizedVfsPath}/${entry}`;

          // Recursively export child
          const childLabels = await exportToReal(vfs, [childPath], realBasePath);
          for (const [path, label] of childLabels) {
            labelMap.set(path, label);
          }
        }
      }
      // Skip symlinks for now
    } catch (error) {
      // Log error but continue with other files
      console.error(`Failed to export ${vfsPath}: ${error}`);
    }
  }

  return labelMap;
}

/**
 * Import real files back into VFS after sandbox execution.
 * New files get labeled with the provided label.
 *
 * @param vfs - The VFS to import into
 * @param realBasePath - Base directory in real filesystem to import from
 * @param vfsBasePath - Base path in VFS to import to
 * @param label - Label to apply to imported files
 * @returns List of imported VFS paths
 */
export async function importFromReal(
  vfs: VFS,
  realBasePath: string,
  vfsBasePath: string,
  label: Label,
): Promise<string[]> {
  const imported: string[] = [];

  // Check if we have Deno filesystem APIs
  const hasDeno = typeof Deno !== "undefined" && typeof Deno.readDir === "function";

  if (!hasDeno) {
    // In environments without Deno filesystem APIs, we can't import
    return imported;
  }

  try {
    // Walk the real directory
    await walkRealDir(realBasePath, realBasePath, vfsBasePath, vfs, label, imported);
  } catch (error) {
    console.error(`Failed to import from ${realBasePath}: ${error}`);
  }

  return imported;
}

/**
 * Recursively walk a real directory and import files into VFS
 */
async function walkRealDir(
  currentRealPath: string,
  baseRealPath: string,
  baseVfsPath: string,
  vfs: VFS,
  label: Label,
  imported: string[],
): Promise<void> {
  try {
    // Read directory entries
    for await (const entry of Deno.readDir(currentRealPath)) {
      const realPath = `${currentRealPath}/${entry.name}`;

      // Compute relative path from base
      const relativePath = currentRealPath === baseRealPath
        ? entry.name
        : `${currentRealPath.substring(baseRealPath.length + 1)}/${entry.name}`;

      // Compute VFS path
      const vfsPath = baseVfsPath === "/"
        ? `/${relativePath}`
        : `${baseVfsPath}/${relativePath}`;

      if (entry.isFile) {
        try {
          // Read file content
          const content = await Deno.readFile(realPath);

          // Write to VFS with label
          vfs.writeFile(vfsPath, content, label);

          imported.push(vfsPath);
        } catch (error) {
          console.error(`Failed to import file ${realPath}: ${error}`);
        }
      } else if (entry.isDirectory) {
        // Recursively walk subdirectory
        await walkRealDir(realPath, baseRealPath, baseVfsPath, vfs, label, imported);
      }
      // Skip other types (symlinks, etc.)
    }
  } catch (error) {
    console.error(`Failed to walk directory ${currentRealPath}: ${error}`);
  }
}
