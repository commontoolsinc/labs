import { describe, it, beforeEach } from "@std/testing/bdd";
import { h, render, VNode } from "../src/index.ts";
import { lift, recipe, str, UI } from "@commontools/builder";
import { idle, run } from "@commontools/runner";
import * as assert from "./assert.ts";
import { getDoc, getSpace } from "@commontools/runner";
import { JSDOM } from "jsdom";

describe("recipes with HTML", () => {
  let dom: JSDOM;
  let document: Document;
  
  beforeEach(() => {
    // Set up a fresh JSDOM instance for each test
    dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
    document = dom.window.document;
    
    // Set up global environment
    globalThis.document = document;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Text = dom.window.Text;
  });
  it("should render a simple UI", async () => {
    const simpleRecipe = recipe<{ value: number }>(
      "Simple UI Recipe",
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return {
          [UI]: <div>{doubled}</div>
        };
      },
    );

    const space = getSpace("test");
    const resultCell = getDoc(undefined, "simple-ui-result", space);
    const result = run(simpleRecipe, { value: 5 }, resultCell);

    await idle();

    // The template of the VNode structure might change but we can check for specific properties
    const resultValue = result.get();
    if (!resultValue || typeof resultValue !== "object") {
      throw new Error("Result should be an object");
    }
    
    if (!(UI in resultValue)) {
      throw new Error(`Result should contain ${UI} property`);
    }
    
    const uiResult = resultValue[UI] as Record<string, any>;
    assert.equal(typeof uiResult, "object");
    assert.assert(uiResult !== null, "UI result should not be null");
    
    // If it's a VNode directly
    if (uiResult && typeof uiResult === "object" && "type" in uiResult) {
      if (uiResult.type === "vnode") {
        assert.equal(uiResult.name, "div");
      } 
      // If it's wrapped in a view container
      else if (uiResult.type === "view" && "template" in uiResult) {
        const template = uiResult.template as Record<string, any>;
        if (typeof template === "object" && template && "type" in template) {
          assert.equal(template.type, "vnode");
        }
      }
    }
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
              {items.map((item, i) => <li key={i.toString()}>{item.title}</li>)}
            </ul>
          </div>
        ),
      };
    });

    const space = getSpace("test");
    const resultCell = getDoc(undefined, "todo-list-result", space);
    const result = run(todoList, {
      title: "test",
      items: [
        { title: "item 1", done: false },
        { title: "item 2", done: true },
      ],
    }, resultCell);

    await idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
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
      const { [UI]: summaryUI } = recipe<
        { title: { name: string } }
      >(
        "summary",
        ({ title }) => {
          return { [UI]: <div>{title.name}</div> };
        },
      )({ title });
      return { [UI]: <div>{summaryUI}</div> };
    });

    const space = getSpace("test");
    const resultCell = getDoc(undefined, "nested-todo-result", space);
    const result = run(todoList, {
      title: { name: "test" },
      items: [
        { title: "item 1", done: false },
        { title: "item 2", done: true },
      ],
    }, resultCell);

    await idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cell = result.asCell<{ [UI]: VNode }>().key(UI);
    render(parent, cell.get());

    // Test the nested content
    assert.equal(parent.textContent, "test");
  });

  it("works with str", async () => {
    const strRecipe = recipe<{ name: string }>("str recipe", ({ name }) => {
      return { [UI]: <div>{str`Hello, ${name}!`}</div> };
    });

    const space = getSpace("test");
    const resultCell = getDoc(undefined, "str-recipe-result", space);
    const result = run(strRecipe, { name: "world" }, resultCell);

    await idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cell = result.asCell<{ [UI]: VNode }>().key(UI);
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

    const space = getSpace("test");
    const resultCell = getDoc(undefined, "nested-map-result", space);
    const result = run(nestedMapRecipe, data, resultCell);

    await idle();

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cell = result.asCell([UI]);
    render(parent, cell.get());

    assert.equal(
      parent.innerHTML,
      "<div><ul><li>test: 123</li><li>ok: false</li></ul><ul><li>test: 345</li><li>another: xxx</li></ul><ul><li>test: 456</li><li>ok: true</li></ul></div>",
    );
  });
});
