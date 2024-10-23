// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { html, render, View } from "@commontools/common-html";
import { recipe, lift, str, UI } from "@commontools/common-builder";
import { run } from "../src/runner.js";
import { idle } from "../src/scheduler.js";

describe("recipes with HTML", () => {
  it("renders a simple UI", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple UI Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { [UI]: html`<div>${doubled}</div>` };
      }
    );

    const result = run(simpleRecipe, { value: 5 });

    await idle();

    expect(result.get()).toMatchObject({
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
        [UI]: html`<div>
          <h1>${title}</h1>
          <ul>
            ${items.map((item) => html`<li>${item.title}</li>`)}
          </ul>
        </div>`,
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
    const cell = result.asSimpleCell<{ [UI]: View }>().key(UI);
    render(parent, cell.get());

    expect(parent.innerHTML).toBe(
      "<div><h1>test</h1><ul><li>item 1</li><li>item 2</li></ul></div>"
    );
  });

  it.only("works with paths on nested recipes", async () => {
    const todoList = recipe<{
      title: { name: string };
      items: { title: string; done: boolean }[];
    }>("todo list", ({ title }) => {
      const { [UI]: summaryUI } = recipe<
        { title: { name: string } },
        { [UI]: View }
      >("summary", ({ title }) => {
        return { [UI]: html`<div>${title.name}</div>` };
      })({ title });
      return { [UI]: html`<div>${summaryUI}</div>` };
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
    const cell = result.asSimpleCell<{ [UI]: View }>().key(UI);
    render(parent, cell.get());

    expect(parent.innerHTML).toBe("<div><div>test</div></div>");
  });

  it("works with str", async () => {
    const strRecipe = recipe<{ name: string }>("str recipe", ({ name }) => {
      return { [UI]: html`<div>${str`Hello, ${name}!`}</div>` };
    });

    const result = run(strRecipe, { name: "world" });

    await idle();

    const parent = document.createElement("div");
    const cell = result.asSimpleCell<{ [UI]: View }>().key(UI);
    render(parent, cell.get());

    expect(parent.innerHTML).toBe("<div>Hello, world!</div>");
  });

  it("works with nested maps of non-objects", async () => {
    const entries = lift((row: object) => Object.entries(row));

    const data = [
      { test: 123, ok: false },
      { test: 345, another: "xxx" },
      { test: 456, ok: true },
    ];

    const nestedMapRecipe = recipe<any[]>("nested map recipe", (data) => ({
      [UI]: html`<div>
        ${data.map(
          (row) => html`<ul>
            ${entries(row).map(([k, v]) => html`<li>${k}: ${v}</li>`)}
          </ul>`
        )}
      </div>`,
    }));

    const result = run(nestedMapRecipe, data);

    await idle();

    const parent = document.createElement("div");
    const cell = result.asSimpleCell([UI]);
    render(parent, cell.get());

    expect(parent.innerHTML).toBe(
      "<div><ul><li>test: 123</li><li>ok: false</li></ul><ul><li>test: 345</li><li>another: xxx</li></ul><ul><li>test: 456</li><li>ok: true</li></ul></div>"
    );
  });
});
