import { html } from "@commontools/common-html";
import { recipe, NAME, UI, isolated, str, lift } from "@commontools/common-builder";

const concat = isolated<{ a: string; b: string }, { result: string }>(
  { a: { tag: "string", val: "hola" }, b: { tag: "string", val: "mundo" } },
  { result: "string" },
  ({ a, b }) => ({ result: `${a} ${b}` })
);

const tap = isolated<{ data: string }, { result: string }>(
  { data: { tag: "string", val: "[]" } },
  { result: "string" },
  ({ data }) => {
    const parsed = JSON.parse(data);
    const uniqueUrls = new Set();
    if (Array.isArray(parsed.items)) {
      parsed.items.forEach(item => {
        if (item && typeof item === 'object' && 'import/url' in item) {
          uniqueUrls.add(item['import/url']);
        }
      });
    }
    const urls = Array.from(uniqueUrls);
    return { result: "unique URLs: " + JSON.stringify(urls) };
  }
);

const stringify = lift(({ obj }) => {
  console.log("stringify", obj);
  return JSON.stringify(obj || {}, null, 2);
});

export const workbench = recipe<{ a: string; b: string; data: any; }>(
  "isolated hello world",
  ({ a, b, data }) => {
    a.setDefault("hello");
    b.setDefault("world");
    data.setDefault([{ a: "yello", b: "world" }]);

    const { result: concatenated } = tap({ data: stringify({ obj: { items: data } }) });

    return {
      [NAME]: str`${a} ${b}`,
      [UI]: html`<div>

          <div>${concatenated}</div>

          <pre>${stringify({ obj: data })}</pre></div>
          `,
      concatenated,
    };
  }
);
