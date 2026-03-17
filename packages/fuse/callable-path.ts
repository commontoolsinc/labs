export interface MountedCallablePath {
  spaceName: string;
  rootKind: "pieces" | "entities";
  rootName: string;
  cellProp: "input" | "result";
  cellKey: string;
  callableKind: "handler" | "tool";
}

export function parseMountedCallablePath(
  path: string,
): MountedCallablePath | null {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;

  const segments = normalized.split("/");
  if (segments.length !== 5) return null;

  const [spaceName, rootKind, rootName, cellProp, fileName] = segments;
  if (!spaceName || !rootName) return null;
  if (rootKind !== "pieces" && rootKind !== "entities") return null;
  if (cellProp !== "input" && cellProp !== "result") return null;

  const match = /^(.+)\.(handler|tool)$/.exec(fileName);
  if (!match) return null;

  const [, cellKey, callableKind] = match;
  if (!cellKey) return null;

  return {
    spaceName,
    rootKind,
    rootName,
    cellProp,
    cellKey,
    callableKind: callableKind as "handler" | "tool",
  };
}
