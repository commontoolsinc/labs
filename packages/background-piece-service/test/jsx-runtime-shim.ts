export function jsx(type: unknown, props: unknown, key?: unknown) {
  return { type, props, key };
}

export const jsxs = jsx;
export const Fragment = Symbol("Fragment");
