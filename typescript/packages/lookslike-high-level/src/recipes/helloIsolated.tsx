import { recipe, NAME, UI, isolated, str } from "@commontools/common-builder";
import { h } from "../jsx.js";
const concat = isolated<{ a: string; b: string }, { result: string }>(
  { a: { tag: "string", val: "hola" }, b: { tag: "string", val: "mundo" } },
  { result: "string" },
  ({ a, b }) => ({ result: `${a} ${b}` })
);

export const helloIsolated = recipe<{ a: string; b: string }>(
  "isolated hello world",
  ({ a, b }) => {
    a.setDefault("hello");
    b.setDefault("world");

    const { result: concatenated } = concat({ a, b });

    return {
      [NAME]: str`${a} ${b}`,
      [UI]: <div>{concatenated}</div>,
      concatenated,
    };
  }
);