import { walk } from "@std/fs";
import { debounce } from "@std/async/debounce";

export interface NoteChange {
  path: string;
  type: "add" | "modify" | "remove";
  content?: string;
}

export class NotesWatcher {
  private watcher?: Deno.FsWatcher;
  private path: string;
  private onChange: (change: NoteChange) => void;

  constructor(path: string, onChange: (change: NoteChange) => void) {
    this.path = path;
    this.onChange = debounce(onChange, 100);
    console.log(`NotesWatcher initialized with path: ${path}`);
  }

  async start() {
    console.log("Starting watcher...");
    try {
      await Deno.permissions.request({ name: "read", path: this.path });
      await Deno.permissions.request({ name: "write", path: this.path });

      // First, let's verify the path exists
      const stat = await Deno.stat(this.path);
      if (!stat.isDirectory) {
        throw new Error(`${this.path} is not a directory`);
      }

      console.log("Starting file system watcher...");
      this.watcher = Deno.watchFs(this.path, { recursive: true });

      for await (const event of this.watcher) {
        if (!event.paths[0].endsWith(".md")) continue;
        console.log(`File event detected: ${event.kind} - ${event.paths[0]}`);

        try {
          switch (event.kind) {
            case "create":
            case "modify": {
              try {
                const content = await Deno.readTextFile(event.paths[0]);
                this.onChange({
                  path: event.paths[0],
                  type: event.kind === "create" ? "add" : "modify",
                  content,
                });
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) {
                  throw error;
                }
              }
              break;
            }
            case "remove":
              this.onChange({
                path: event.paths[0],
                type: "remove",
              });
              break;
          }
        } catch (error) {
          console.error("Error processing file change:", error);
        }
      }
    } catch (error) {
      console.error("Error in watcher:", error);
    }
  }

  stop() {
    console.log("Stopping watcher...");
    this.watcher?.close();
  }

  async listFiles(): Promise<NoteChange[]> {
    console.log(`Starting to list files in ${this.path}`);
    const files: NoteChange[] = [];

    try {
      // First verify we can access the directory
      const stat = await Deno.stat(this.path);
      if (!stat.isDirectory) {
        throw new Error(`${this.path} is not a directory`);
      }

      // Manually list directory contents first
      for await (const dirEntry of Deno.readDir(this.path)) {
        console.log(
          `Found entry: ${dirEntry.name} (${
            dirEntry.isFile ? "file" : "directory"
          })`,
        );
      }

      console.log("Starting walk...");
      for await (
        const entry of walk(this.path, {
          exts: [".md"],
          followSymlinks: false,
          includeDirs: false,
        })
      ) {
        console.log(`Found .md file: ${entry.path}`);
        try {
          const content = await Deno.readTextFile(entry.path);
          files.push({
            path: entry.path,
            type: "add",
            content,
          });
          console.log(`Successfully read: ${entry.path}`);
        } catch (error) {
          console.error(`Error reading file ${entry.path}:`, error);
        }
      }

      console.log(`Found ${files.length} markdown files`);
    } catch (error) {
      console.error("Error listing files:", error);
    }

    return files;
  }
}

// usage:
// const watcher = new NotesWatcher("/Users/ben/code/common-tools/labs/cli/notes", (change) => {
//   console.log('File changed:', change.path);
//   console.log('Change type:', change.type);
//   if (change.content) {
//     console.log('Content:', change.content);
//   }
// });

// // Get initial list of files
// const files = await watcher.listFiles();
// console.log('Initial files:', files);

// // Start watching for changes
// await watcher.start();
