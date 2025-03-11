import { Plugin } from "vite";
import prefixPlugin from "./prefixPlugin.ts";
import mainPlugin from "./resolvePlugin.ts";
import { DenoResolveResult } from "./resolver.ts";

export default function deno(): Plugin[] {
  const cache = new Map<string, DenoResolveResult>();

  return [prefixPlugin(cache), mainPlugin(cache)];
}
