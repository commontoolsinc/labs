import { ensureDir } from "@std/fs";
import { colors, timestamp } from "./cli.ts";
import env from "@/env.ts";

export const CACHE_DIR = `${env.CACHE_DIR}/llm-api-cache`;

async function validateCache() {
  // Ensure cache directory exists and count files on startup
  await ensureDir(CACHE_DIR);
  let cacheCount = 0;
  try {
    for await (const entry of Deno.readDir(CACHE_DIR)) {
      if (entry.isFile) {
        cacheCount++;
      }
    }
    console.log(
      `${timestamp()} ${colors.green}📦 Cache contains${colors.reset} ${cacheCount} files`,
    );
  } catch (error) {
    console.error(
      `${timestamp()} ${colors.red}❌ Error reading cache directory:${colors.reset}`,
      error,
    );
  }
}
validateCache();

interface CacheItem {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  system?: string;
  stopSequences?: string[];
}

export async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadItem(key: string): Promise<CacheItem | null> {
  const hash = await hashKey(key);
  const filePath = `${CACHE_DIR}/${hash}.json`;
  console.log("checking cache file:", filePath);
  try {
    const cacheData = await Deno.readTextFile(filePath);
    console.log(
      `${timestamp()} ${colors.green}📦 Cache loaded:${colors.reset} ${
        filePath.slice(
          -12,
        )
      }`,
    );
    console.log("returning data:", cacheData);
    return JSON.parse(cacheData);
  } catch {
    console.log("cache file not found:", filePath);
    return null;
  }
}

export async function saveItem(key: string, data: CacheItem): Promise<void> {
  const hash = await hashKey(key);
  const filePath = `${CACHE_DIR}/${hash}.json`;
  console.log(
    `${timestamp()} ${colors.green}💾 Cache saved:${colors.reset} ${filePath}`,
  );
  await ensureDir(CACHE_DIR);
  await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
}
