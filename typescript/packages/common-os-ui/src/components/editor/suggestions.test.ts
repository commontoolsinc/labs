import * as assert from "node:assert/strict";
import { createRect } from "../../shared/position.js";
import * as suggestions from "./suggestions.js";
import * as suggestionsPlugin from "./prosemirror/suggestions-plugin.js";
import * as completion from "./completion.js";

describe("suggestions.update", () => {
  it("should handle activeUpdateMsg", () => {
    const suggestion = suggestionsPlugin.createSuggestion(0, 5, true, "Hello");

    const updateMsg = suggestions.createActiveUpdateMsg({
      active: suggestionsPlugin.createSuggestion(0, 5, true, "Hello"),
      coords: createRect(10, 20, 100, 50),
    });

    const initialState = suggestions.model();
    const newState = suggestions.update(initialState, updateMsg);

    assert.deepStrictEqual(newState.active, suggestion);
    assert.deepStrictEqual(newState.coords, createRect(10, 20, 100, 50));
    assert.strictEqual(newState.selectedCompletion, 0);
    assert.strictEqual(newState.completions.length, 0);
  });

  it("should handle inactiveUpdateMsg", () => {
    const updateMsg = suggestions.createInactiveUpdateMsg();

    const initialState = suggestions.model();
    const newState = suggestions.update(initialState, updateMsg);

    assert.strictEqual(newState.active, null);
    assert.strictEqual(newState.selectedCompletion, 0);
  });

  it("should handle arrowUp message", () => {
    const initialState = suggestions.model();

    const stateWithCompletions = {
      ...initialState,
      completions: [
        completion.model({ id: "1", text: "First" }),
        completion.model({ id: "2", text: "Second" }),
        completion.model({ id: "3", text: "Third" }),
      ],
      selectedCompletion: 1,
    };

    const arrowUpMsg = suggestions.createArrowUpMsg();

    const newState = suggestions.update(stateWithCompletions, arrowUpMsg);

    assert.strictEqual(newState.selectedCompletion, 0);
  });

  it("should handle arrowDown message", () => {
    const initialState = suggestions.model();

    const stateWithCompletions = {
      ...initialState,
      completions: [
        completion.model({ id: "1", text: "First" }),
        completion.model({ id: "2", text: "Second" }),
        completion.model({ id: "3", text: "Third" }),
      ],
      selectedCompletion: 1,
    };

    const arrowDownMsg = suggestions.createArrowDownMsg();

    const newState = suggestions.update(stateWithCompletions, arrowDownMsg);

    assert.strictEqual(newState.selectedCompletion, 2);
  });

  it("should clamp selectedCompletion within bounds", () => {
    const initialState = suggestions.model();

    const stateWithCompletions = {
      ...initialState,
      completions: [
        completion.model({ id: "1", text: "First" }),
        completion.model({ id: "2", text: "Second" }),
        completion.model({ id: "3", text: "Third" }),
      ],
      selectedCompletion: 0,
    };

    const arrowUpMsg = suggestions.createArrowUpMsg();
    const newState1 = suggestions.update(stateWithCompletions, arrowUpMsg);
    assert.strictEqual(newState1.selectedCompletion, 0);

    const arrowDownMsg = suggestions.createArrowDownMsg();
    const newState2 = suggestions.update(
      { ...stateWithCompletions, selectedCompletion: 2 },
      arrowDownMsg,
    );
    assert.strictEqual(newState2.selectedCompletion, 2);
  });

  it("should return the same state for unknown message types", () => {
    const initialState = suggestions.model();
    const unknownMsg = { type: "unknown" } as unknown as suggestions.Msg;

    const nextState = suggestions.update(initialState, unknownMsg);
    assert.strictEqual(nextState, initialState);
  });
});
