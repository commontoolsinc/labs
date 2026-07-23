/** Redacts structural write paths to a fixed, content-free vocabulary. */
export function writePathShape(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return "$root";
  return segments.map((segment) => {
    if (segment === "value") return "value";
    if (segment === "metadata") return "metadata";
    if (/^\d+$/.test(segment)) return "#";
    return "*";
  }).join("/");
}
