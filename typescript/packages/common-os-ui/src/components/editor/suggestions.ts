/** Suggestion actions, model and update */
import { Suggestion, UpdateMsg } from "./suggestions-plugin.js";
import { Rect, createRect } from "../../shared/position.js";
import { clamp } from "../../shared/number.js";
import { unknown } from "../../shared/store.js";
import * as dummy from "../../shared/dummy.js";

const freeze = Object.freeze;

export type Completion = {
  id: string;
  text: string;
};

export const createCompletion = (id: string, text: string): Completion =>
  freeze({
    id,
    text,
  });

export type State = {
  active: Suggestion | null;
  coords: Rect;
  selectedCompletion: number;
  completions: Array<Completion>;
};

export const createUpdateMsg = (update: UpdateMsg | null) =>
  freeze({
    type: "update",
    update,
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

export type Msg =
  | ReturnType<typeof createUpdateMsg>
  | ReturnType<typeof createDestroyMsg>
  | ReturnType<typeof createArrowUpMsg>
  | ReturnType<typeof createArrowDownMsg>
  | ReturnType<typeof createTabMsg>
  | ReturnType<typeof createEnterMsg>;

export const init = () =>
  freeze({
    active: null,
    coords: createRect(0, 0, 0, 0),
    selectedCompletion: 0,
    completions: [],
  });

const updateUpdate = (state: State, update: UpdateMsg | null): State => {
  if (update) {
    return freeze({
      ...state,
      active: update.active,
      coords: update.coords,
      selectedCompletion: 0,
      completions: dummy
        .titles(5)
        .map((title) => createCompletion(dummy.id(), title)),
    });
  } else {
    return freeze({
      ...state,
      active: null,
      selectedCompletion: 0,
    });
  }
};

const updateSelectedCompletion = (state: State, offset: number): State => {
  return freeze({
    ...state,
    selectedCompletion: clamp(
      0,
      Math.max(state.completions.length - 1, 0),
      state.selectedCompletion + offset,
    ),
  });
};

export const update = (state: State, msg: Msg): State => {
  switch (msg.type) {
    case "update":
      return updateUpdate(state, msg.update);
    case "arrowUp":
      return updateSelectedCompletion(state, 1);
    case "arrowDown":
      return updateSelectedCompletion(state, -1);
    default:
      return unknown(state, msg);
  }
};
