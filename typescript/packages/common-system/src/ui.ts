import { service } from "./adapter.js";
import { Reference, Task, $ } from "./db.js";
import * as DOM from "@gozala/co-dom";
import * as Session from "./session.js";

export interface Mount {
  vdom: DOM.Node<{}> | null;
  mount: HTMLElement;
  dispatch: (fact: [attribute: string, event: Event]) => Task.Task<unknown>;
}

export const UI = "~/common/ui";

export default service({
  render: {
    select: {
      mount: $.mount,
      ui: $.ui,
    },
    where: [
      { Case: [$.entity, UI, $.ui] },
      { Case: [$.entity, "~/ui/mount", $.mount] },
    ],
    *perform({ mount, ui }: { mount: Reference; ui: Reference }) {
      console.log("Render");
      const view = Session.resolve(mount) as Mount;
      const vdom = Session.resolve(ui) as DOM.Node<{}>;
      if (view.vdom === null) {
        view.vdom = DOM.virtualize(view.mount);
      }
      if (vdom !== view.vdom) {
        const delta = DOM.diff(view.vdom, vdom);
        DOM.patch(view.mount, view.vdom, delta, {
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
