import { equal as assertEqual } from "node:assert/strict";
import {
  html,
  isTemplate
} from "../html.js";

describe("html", () => {
  it("creates a template object", () => {
    const template = html`<div>${"name"}</div>`;
    assertEqual(isTemplate(template), true);
  });

  it("freezes the template object", () => {
    const template = html`<div>${"name"}</div>`;
    assertEqual(Object.isFrozen(template), true);
    assertEqual(Object.isFrozen(template.template), true);
    assertEqual(Object.isFrozen(template.context), true);
  });
});