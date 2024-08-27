import { describe, it, expect } from "vitest";
import { html, render, View } from "@commontools/common-html";
import { recipe, lift, UI } from "../../src/builder/index.js";
import { run } from "../../src/runner/runner.js";
import { idle } from "../../src/runner/scheduler.js";

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
    const cell = result.asSimpleCell<View>([UI]);
    render(parent, cell.get());

    expect(parent.innerHTML).toBe(
      "<div><h1>test</h1><ul><li>item 1</li><li>item 2</li></ul></div>"
    );
  });
});
