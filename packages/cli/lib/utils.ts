import { isAbsolute, join } from "@std/path";

export function absPath(relpath: string, cwd = Deno.cwd()): string {
  // TODO(js): homedir check is not cross platform
  if (isAbsolute(relpath) || relpath[0] === "~") {
    // Do not join a home dir or absolute path
    return relpath;
  }
  return join(cwd, relpath);
}

// Helper function to safely stringify objects with circular references
export function safeStringify(obj: any, maxDepth = 4): string {
  const seen = new WeakSet();

  const stringify = (value: any, depth = 0): any => {
    if (depth > maxDepth) {
      return "<max depth reached>";
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    if (seen.has(value)) {
      return "<circular reference>";
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => stringify(item, depth + 1));
    }

    const result: any = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = stringify(val, depth + 1);
    }

    return result;
  };

  try {
    return JSON.stringify(stringify(obj), null, 2);
  } catch (error) {
    return `<error stringifying object: ${(error as Error)?.message}>`;
  }
}
