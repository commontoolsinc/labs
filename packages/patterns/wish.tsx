/// <cts-enable />
import { derive, Opaque, wish } from "commontools";

export function schemaifyWish<T>(path: string, def: Opaque<T>) {
  return derive<T, T>(wish<T>(path, def), (i) => i);
}
