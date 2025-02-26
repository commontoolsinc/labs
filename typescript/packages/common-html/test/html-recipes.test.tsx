import { describe, it } from "@std/testing/bdd";
import { h, render, VNode } from "../src/index.ts";
import { recipe, lift, str, UI } from "@commontools/builder";
import { run, idle } from "@commontools/runner";
import * as assert from "./assert.ts";

describe("recipes with HTML", () => {
  it("renders a simple UI", async () => {
    const simpleRecipe = recipe<{ value: number }>("Simple UI Recipe", ({ value }) => {
      const doubled = lift((x: number) => x * 2)(value);
      return { [UI]: <div>{doubled}</div> };
    });

    const result = run(simpleRecipe, { value: 5 });

    await idle();

    assert.matchObject(result.get(), {
      [UI]: {
        type: "view",
        template: {
          type: "vnode",
          name: "div",
          props: {},
          children: [{ type: "binding" }],
        },
      },
    });
  });

  it("works with mapping over a list", async () => {
    const todoList = recipe<{
      title: string;
      items: { title: string; done: boolean }[];
    }>("todo list", ({ title, items }) => {
      title.setDefault("untitled");
      return {
        [UI]: (
          <div>
            <h1>{title}</h1>
            <ul>
              {items.map((item) => (
                <li>{item.title}</li>
              ))}
            </ul>
          </div>
        ),
      };
    });

    const result = run(todoList, {
      title: "test",
      items: [
        { title: "item 1", done: false },
        { title: "item 2", done: true },
      ],
    });

    await idle();

    const parent = document.createElement("div");
    const cell = result.asCell<{ [UI]: VNode }>().key(UI);
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
      const { [UI]: summaryUI } = recipe<{ title: { name: string } }, { [UI]: VNode }>(
        "summary",
        ({ title }) => {
          return { [UI]: <div>{title.name}</div> };
        },
      )({ title });
      return { [UI]: <div>{summaryUI}</div> };
    });

    const result = run(todoList, {
      title: { name: "test" },
      items: [
        { title: "item 1", done: false },
        { title: "item 2", done: true },
      ],
    });

    await idle();

    const parent = document.createElement("div");
    const cell = result.asCell<{ [UI]: VNode }>().key(UI);
    render(parent, cell.get());

    assert.equal(parent.innerHTML, "<div><div>test</div></div>");
  });

  it("works with str", async () => {
    const strRecipe = recipe<{ name: string }>("str recipe", ({ name }) => {
      return { [UI]: <div>{str`Hello, ${name}!`}</div> };
    });

    const result = run(strRecipe, { name: "world" });

    await idle();

    const parent = document.createElement("div");
    const cell = result.asCell<{ [UI]: VNode }>().key(UI);
    render(parent, cell.get());

    assert.equal(parent.innerHTML, "<div>Hello, world!</div>");
  });

  it("works with nested maps of non-objects", async () => {
    const entries = lift((row: object) => Object.entries(row));

    const data = [
      { test: 123, ok: false },
      { test: 345, another: "xxx" },
      { test: 456, ok: true },
    ];

    const nestedMapRecipe = recipe<any[]>("nested map recipe", (data) => ({
      [UI]: (
        <div>
          {data.map((row) => (
            <ul>
              {entries(row).map(([k, v]) => (
                <li>
                  {k}: {v}
                </li>
              ))}
            </ul>
          ))}
        </div>
      ),
    }));

    const result = run(nestedMapRecipe, data);

    await idle();

    const parent = document.createElement("div");
    const cell = result.asCell([UI]);
    render(parent, cell.get());

    assert.equal(
      parent.innerHTML,
      "<div><ul><li>test: 123</li><li>ok: false</li></ul><ul><li>test: 345</li><li>another: xxx</li></ul><ul><li>test: 456</li><li>ok: true</li></ul></div>",
    );
  });
});
