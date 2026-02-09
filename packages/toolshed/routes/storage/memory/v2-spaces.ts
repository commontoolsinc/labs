/**
 * SpaceV2 Manager — caches SpaceV2 instances by space DID for the toolshed server.
 */
import { SpaceV2 } from "@commontools/memory/v2/space";
import * as Path from "@std/path";

export class SpaceV2Manager {
  private spaces = new Map<string, SpaceV2>();
  private baseDir: string;

  constructor(memoryDir: string) {
    this.baseDir = memoryDir;
  }

  /**
   * Get or create a SpaceV2 for the given space ID.
   * Creates the v2 subdirectory and database file if needed.
   */
  getOrCreate(spaceId: string): SpaceV2 {
    const existing = this.spaces.get(spaceId);
    if (existing) return existing;

    // Create v2 subdirectory
    const v2Dir = Path.join(this.baseDir, "v2");
    try {
      Deno.mkdirSync(v2Dir, { recursive: true });
    } catch {
      // Already exists
    }

    // Sanitize spaceId for use as filename (replace colons)
    const safeId = spaceId.replaceAll(":", "_");
    const dbPath = Path.join(v2Dir, `${safeId}.db`);
    const dbUrl = new URL(`file://${dbPath}`);

    const space = SpaceV2.open({ url: dbUrl });
    this.spaces.set(spaceId, space);
    return space;
  }

  close(): void {
    for (const space of this.spaces.values()) {
      space.close();
    }
    this.spaces.clear();
  }
}
