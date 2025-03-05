import { join } from "@std/path";
import { ensureDir } from "@std/fs";

export class DiskStorage {
  constructor(public baseDir: string) {}

  async init() {
    await ensureDir(this.baseDir);
  }

  private getPath(hash: string): string {
    return join(this.baseDir, hash);
  }

  async saveBlob(hash: string, content: string) {
    await Deno.writeTextFile(this.getPath(hash), content);
  }

  async getBlob(hash: string): Promise<string | null> {
    try {
      return await Deno.readTextFile(this.getPath(hash));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async deleteBlob(hash: string): Promise<void> {
    try {
      await Deno.remove(this.getPath(hash));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}
