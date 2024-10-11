/** Suggestion actions, model and update */
import { Suggestion } from "./prosemirror/suggestions-plugin.js";
import { Rect, createRect } from "../../shared/position.js";
import { clamp } from "../../shared/number.js";
import { unknown } from "../../shared/store.js";
import * as dummy from "../../shared/dummy.js";
import * as completion from "./completion.js";

const freeze = Object.freeze;

export const createActiveUpdateMsg = ({
  active,
  coords,
}: {
  active: Suggestion;
  coords: Rect;
}) =>
  freeze({
    type: "activeUpdate",
    active,
    coords,
  });

export const createInactiveUpdateMsg = () =>
  freeze({
    type: "inactiveUpdate",
  });

export const createDestroyMsg = () => freeze({ type: "destroy" });

export const createArrowUpMsg = () =>
  freeze({
    type: "arrowUp",
  });

export const createArrowDownMsg = () =>
  freeze({
    type: "arrowDown",
  });

export const createTabMsg = () =>
  freeze({
    type: "tab",
  });

export const createEnterMsg = () =>
  freeze({
    type: "enter",
  });

export const createClickCompletionMsg = (value: completion.Model) =>
  freeze({
    type: "clickCompletion",
    value,
  });

export type Msg =
  | ReturnType<typeof createActiveUpdateMsg>
  | ReturnType<typeof createInactiveUpdateMsg>
  | ReturnType<typeof createDestroyMsg>
  | ReturnType<typeof createArrowUpMsg>
  | ReturnType<typeof createArrowDownMsg>
  | ReturnType<typeof createTabMsg>
  | ReturnType<typeof createEnterMsg>
  | ReturnType<typeof createClickCompletionMsg>;

export type Model = {
  active: Suggestion | null;
  coords: Rect;
  selectedCompletion: number;
  completions: Array<completion.Model>;
};

export const model = (): Model =>
  freeze({
    active: null,
    coords: createRect(0, 0, 0, 0),
    selectedCompletion: 0,
    completions: [],
  });

const updateActiveUpdate = (
  state: Model,
  active: Suggestion,
  coords: Rect,
): Model => {
  return freeze({
    ...state,
    active,
    coords,
    selectedCompletion: 0,
    completions: dummy
      .titles(3)
      .map((text) => completion.model({ id: dummy.id(), text })),
  });
};

const updateInactiveUpdate = (state: Model): Model => {
  return freeze({
    ...state,
    active: null,
    selectedCompletion: 0,
  });
};

const updateSelectedCompletion = (state: Model, offset: number): Model => {
  return freeze({
    ...state,
    selectedCompletion: clamp(
      state.selectedCompletion + offset,
      0,
      Math.max(state.completions.length - 1, 0),
    ),
  });
};

export const update = (state: Model, msg: Msg): Model => {
  switch (msg.type) {
    case "activeUpdate":
      return updateActiveUpdate(state, msg.active, msg.coords);
    case "inactiveUpdate":
      return updateInactiveUpdate(state);
    case "arrowUp":
      return updateSelectedCompletion(state, -1);
    case "arrowDown":
      return updateSelectedCompletion(state, 1);
    case "enter":
      return state;
    case "tab":
      return state;
    case "clickCompletion":
      return state;
    case "destroy":
      return state;
    default:
      return unknown(state, msg);
  }
};
