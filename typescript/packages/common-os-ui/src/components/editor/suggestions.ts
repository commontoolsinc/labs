import { EditorView, Decoration } from "prosemirror-view";
import * as plugin from "./prosemirror/suggestions-plugin.js";
import { Rect, createRect } from "../../shared/position.js";
import { clamp } from "../../shared/number.js";
import { unknown, ValueMsg } from "../../shared/store.js";
import * as dummy from "../../shared/dummy.js";
import * as completion from "./completion.js";
import { executeCommand, replaceWithText } from "./prosemirror/utils.js";

const freeze = Object.freeze;

export type Suggestion = plugin.Suggestion;
export const createSuggestion = plugin.createSuggestion;

export type ActiveUpdateMsg = plugin.ActiveUpdateMsg;
export const createActiveUpdateMsg = plugin.createActiveUpdateMsg;

export type InactiveUpdateMsg = plugin.InactiveUpdateMsg;
export const createInactiveUpdateMsg = plugin.createInactiveUpdateMsg;

export type DestroyMsg = plugin.DestroyMsg;
export const createDestroyMsg = plugin.createDestroyMsg;

export type EnterMsg = plugin.EnterMsg;
export const createEnterMsg = plugin.createEnterMsg;

export type TabMsg = plugin.TabMsg;
export const createTabMsg = plugin.createTabMsg;

export type ArrowUpMsg = plugin.ArrowUpMsg;
export const createArrowUpMsg = plugin.createArrowUpMsg;

export type ArrowDownMsg = plugin.ArrowDownMsg;
export const createArrowDownMsg = plugin.createArrowDownMsg;

export type ClickCompletionMsg = ValueMsg<"clickCompletion", completion.Model>;

export const createClickCompletionMsg = (
  value: completion.Model,
): ClickCompletionMsg =>
  freeze({
    type: "clickCompletion",
    value,
  });

export type InfoMsg = ValueMsg<"info", string>;

export const createInfoMsg = (value: string): InfoMsg =>
  freeze({
    type: "info",
    value,
  });

export type Msg =
  | ActiveUpdateMsg
  | InactiveUpdateMsg
  | DestroyMsg
  | ArrowUpMsg
  | ArrowDownMsg
  | TabMsg
  | EnterMsg
  | ClickCompletionMsg
  | InfoMsg;

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
    case "info":
      console.info(msg.value);
      return state;
    default:
      return unknown(state, msg);
  }
};

export const fx = (view: EditorView) => (state: Model, msg: Msg) => {
  switch (msg.type) {
    case "enter":
      return [
        replaceFx(
          view,
          state.active,
          state.completions.at(state.selectedCompletion)?.text ?? null,
        ),
      ];
    case "tab":
      return [
        replaceFx(
          view,
          state.active,
          state.completions.at(state.selectedCompletion)?.text ?? null,
        ),
      ];
    case "clickCompletion":
      return [replaceFx(view, state.active, msg.value.text)];
    default:
      return [];
  }
};

const replaceFx =
  (
    view: EditorView,
    suggestion: Suggestion | null,
    completion: string | null,
  ) =>
  async () => {
    if (suggestion == null) {
      return createInfoMsg("No active suggestion to replace");
    }
    if (completion == null) {
      return createInfoMsg("No completion to replace");
    }
    executeCommand(
      view,
      replaceWithText(suggestion.from, suggestion.to, completion),
    );
    return createInfoMsg("Replaced suggestion with completion");
  };

/**
 * Specialized version of `suggestionsPlugin` that takes care of wiring
 * plugin lifecycle callbacks to store
 */
export const suggestionsStorePlugin = ({
  pattern,
  decoration,
  send,
}: {
  pattern: RegExp;
  decoration: (suggestion: Suggestion) => Decoration;
  send: (msg: Msg) => void;
}) =>
  plugin.suggestionsPlugin({
    pattern,
    decoration,
    reducer: (_view, msg): boolean => {
      switch (msg.type) {
        case "activeUpdate":
          send(msg);
          return true;
        case "inactiveUpdate":
          send(msg);
          return true;
        case "destroy":
          send(msg);
          return true;
        case "arrowUp":
          send(msg);
          return true;
        case "arrowDown":
          send(msg);
          return true;
        case "enter":
          send(msg);
          return true;
        case "tab":
          send(msg);
          return true;
        default:
          return false;
      }
    },
  });
