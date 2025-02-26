import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRect } from "../src/shared/position.ts";
import * as suggestions from "../src/components/editor/suggestions.ts";
import * as suggestionsPlugin from "../src/components/editor/prosemirror/suggestions-plugin.ts";
import * as completion from "../src/components/editor/completion.ts";

describe("suggestions.update", () => {
  it("should handle activeUpdateMsg", () => {
    const suggestion = suggestionsPlugin.createSuggestion(0, 5, true, "Hello");

    const updateMsg = suggestions.createActiveUpdateMsg({
      active: suggestionsPlugin.createSuggestion(0, 5, true, "Hello"),
      coords: createRect(10, 20, 100, 50),
    });

    const initialState = suggestions.model();
    const newState = suggestions.update(initialState, updateMsg);

    expect(newState.active).toEqual(suggestion);
    expect(newState.coords).toEqual(createRect(10, 20, 100, 50));
    expect(newState.selectedCompletion).toEqual(0);
    expect(newState.completions.length).toEqual(0);
  });

  it("should handle inactiveUpdateMsg", () => {
    const updateMsg = suggestions.createInactiveUpdateMsg();

    const initialState = suggestions.model();
    const newState = suggestions.update(initialState, updateMsg);

    expect(newState.active).toBeNull();
    expect(newState.selectedCompletion).toEqual(0);
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

    expect(newState.selectedCompletion).toEqual(0);
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

    expect(newState.selectedCompletion).toEqual(2);
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
    expect(newState1.selectedCompletion).toEqual(0);

    const arrowDownMsg = suggestions.createArrowDownMsg();
    const newState2 = suggestions.update(
      { ...stateWithCompletions, selectedCompletion: 2 },
      arrowDownMsg,
    );
    expect(newState2.selectedCompletion).toEqual(2);
  });

  it("should return the same state for unknown message types", () => {
    const initialState = suggestions.model();
    const unknownMsg = { type: "unknown" } as unknown as suggestions.Msg;

    const nextState = suggestions.update(initialState, unknownMsg);
    expect(nextState).toEqual(initialState);
  });
});
