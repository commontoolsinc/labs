import { service } from "./adapter.js";
import { Task, $ } from "./db.js";
import * as DOM from "@gozala/co-dom";
import * as Session from "./session.js";
import { Reference } from "merkle-reference";

export interface Mount {
  vdom: DOM.Node<{}> | null;
  renderMount: HTMLElement;
  dispatch: (fact: [attribute: string, event: Event]) => Task.Task<unknown>;
}

export const UI = "~/common/ui";
export const MOUNT = "~/ui/mount";

/**
 * UI is a service that observes entities that have `~/common/ui` and
 * `~/ui/mount` attributes and renders VDOM assigned to the `~/common/ui`
 * in a `.mount` of the `Charm` custom element assigned to the `~/ui/mount`
 * attribute.
 *
 * `Charm` custom element sets `~/ui/mount` attribute on the entity bound to
 * it when element is connected to the DOM and unsets it when element is
 * disconnected from the DOM.
 */
export default service({
  render: {
    select: {
      mount: $.mount,
      ui: $.ui,
    },
    where: [
      { Case: [$.entity, UI, $.ui] },
      { Case: [$.entity, MOUNT, $.mount] },
    ],
    *perform({ mount, ui }: { mount: Reference; ui: Reference }) {
      const view = Session.resolve(mount) as Mount;
      const vdom = Session.resolve(ui) as DOM.Node<{}>;
      if (view.vdom === null) {
        view.vdom = DOM.virtualize(view.renderMount);
      }
      if (vdom !== view.vdom) {
        const delta = DOM.diff(view.vdom, vdom);
        DOM.patch(view.renderMount, view.vdom, delta, {
          send(fact: [attribute: string, event: Event]) {
            Task.perform(view.dispatch(fact));
          },
        });
        view.vdom = vdom;
      }

      return [];
    },
  },
});
