import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { render, VNode } from "../src/index.ts";
import {
  type Cell,
  createBuilder,
  type IExtendedStorageTransaction,
  Opaque,
  Runtime,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import * as assert from "./assert.ts";
import { JSDOM } from "jsdom";
import { Identity } from "@commontools/identity";
import { h } from "@commontools/api";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("recipes with HTML", () => {
  let dom: JSDOM;
  let document: Document;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let str: ReturnType<typeof createBuilder>["commontools"]["str"];
  let UI: ReturnType<typeof createBuilder>["commontools"]["UI"];

  beforeEach(() => {
    // Set up a fresh JSDOM instance for each test
    dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
    document = dom.window.document;

    // Set up global environment
    globalThis.document = document;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Text = dom.window.Text;

    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder(runtime);
    ({ lift, recipe, str, UI } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });
  it("should render a simple UI", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple UI Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { [UI]: h("div", null, doubled) };
      },
    );

    const result = runtime.run(
      tx,
      simpleRecipe,
      { value: 5 },
      runtime.getCell(space, "simple-ui-result", undefined, tx),
    );
    tx.commit();

    await runtime.idle();
    const resultValue = result.get();

    assert.matchObject(resultValue, {
      [UI]: {
        type: "vnode",
        name: "div",
        props: {},
        children: [10],
      },
    });
  });

  it("works with mapping over a list", async () => {
    type Item = { title: string; done: boolean };
    const todoList = recipe<{
      title: string;
      items: Item[];
    }>("todo list", ({ title, items }) => {
      title.setDefault("untitled");
      return {
        [UI]: h(
          "div",
          null,
          h("h1", null, title),
          h(
            "ul",
            null,
            items.map((item: Opaque<Item>, i: Opaque<number>) =>
              h("li", { key: i.toString() }, item.title)
            ) as VNode[],
          ),
        ),
      };
    });

    const result = runtime.run(
      tx,
      todoList,
      {
        title: "test",
        items: [
          { title: "item 1", done: false },
          { title: "item 2", done: true },
        ],
      },
      runtime.getCell(space, "todo-list-result", undefined, tx),
    ) as Cell<{ [UI]: VNode }>;
    tx.commit();

    await runtime.idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cell = result.key(UI);
    render(parent, cell.get());

    assert.equal(
      parent.innerHTML,
      "<div><h1>test</h1><ul><li>item 1</li><li>item 2</li></ul></div>",
    );
  });

  it("works with paths on nested recipes", async () => {
    const todoList = recipe<{
      title: { name: string };
      items: { title: string; done: boolean }[];
    }>("todo list", ({ title }) => {
      const { [UI]: summaryUI } = recipe<
        { title: { name: string } },
        { [UI]: VNode }
      >(
        "summary",
        ({ title }) => {
          return { [UI]: h("div", null, title.name) };
        },
      )({ title });
      return { [UI]: h("div", null, summaryUI as VNode) };
    });

    const result = runtime.run(
      tx,
      todoList,
      {
        title: { name: "test" },
        items: [
          { title: "item 1", done: false },
          { title: "item 2", done: true },
        ],
      },
      runtime.getCell(space, "nested-todo-result", undefined, tx),
    ) as Cell<{ [UI]: VNode }>;
    tx.commit();

    await runtime.idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cell = result.key(UI);
    render(parent, cell);

    assert.equal(parent.innerHTML, "<div><div>test</div></div>");
  });

  it("works with str", async () => {
    const strRecipe = recipe<{ name: string }>("str recipe", ({ name }) => {
      return { [UI]: h("div", null, str`Hello, ${name}!`) };
    });

    const result = runtime.run(
      tx,
      strRecipe,
      { name: "world" },
      runtime.getCell(space, "str-recipe-result", undefined, tx),
    ) as Cell<{ [UI]: VNode }>;
    tx.commit();

    await runtime.idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cell = result.key(UI);
    render(parent, cell.get());

    assert.equal(parent.textContent, "Hello, world!");
  });

  it("works with nested maps of non-objects", async () => {
    const entries = lift((row: object) => Object.entries(row));

    const data = [
      { test: 123, ok: false },
      { test: 345, another: "xxx" },
      { test: 456, ok: true },
    ];

    const nestedMapRecipe = recipe<Record<string, unknown>[]>(
      "nested map recipe",
      (data) => ({
        [UI]: h(
          "div",
          null,
          data.map((row: Opaque<Record<string, unknown>>) =>
            h(
              "ul",
              null,
              entries(row).map((input: Opaque<[string, unknown]>) =>
                h("li", null, [input[0] as string, ": ", input[1] as VNode])
              ) as VNode[],
            )
          ) as VNode[],
        ),
      }),
    );

    const result = runtime.run(
      tx,
      nestedMapRecipe,
      data,
      runtime.getCell(space, "nested-map-result", undefined, tx),
    ) as Cell<{ [UI]: VNode }>;
    tx.commit();

    await runtime.idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cell = result.key(UI);
    render(parent, cell.get());

    assert.equal(
      parent.innerHTML,
      "<div><ul><li>test: 123</li><li>ok: false</li></ul><ul><li>test: 345</li><li>another: xxx</li></ul><ul><li>test: 456</li><li>ok: true</li></ul></div>",
    );
  });
});
