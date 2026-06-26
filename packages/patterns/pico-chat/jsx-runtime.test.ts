export const Fragment = Symbol("Fragment");

export function jsx(type: unknown, props: Record<string, unknown> | null) {
  return { type, props: props ?? {} };
}

export const jsxs = jsx;
