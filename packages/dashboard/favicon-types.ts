import type { Status } from "./types.ts";

export type FaviconStatus = Exclude<Status, "unknown">;
export type FaviconFace = FaviconStatus | "bad-crying";

export const FAVICON_FACES = [
  "good",
  "warn",
  "bad",
  "bad-crying",
] as const satisfies readonly FaviconFace[];
