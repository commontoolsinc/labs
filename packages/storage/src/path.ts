export type Path = string[];
export type PathKey = string;

export function keyPath(tokens: Path): PathKey {
  // Thin wrapper over JSON.stringify to centralize encoding.
  return JSON.stringify(tokens);
}
