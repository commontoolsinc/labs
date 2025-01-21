import { DiskStorage } from "@/lib/redis/storage.ts";

const DATA_DIR = "./cache/blobby";

export const storage = new DiskStorage(DATA_DIR);
await storage.init();
