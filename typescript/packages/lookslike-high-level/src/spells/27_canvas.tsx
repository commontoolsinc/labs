import { h, Session, refer, $ } from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm as CharmComponent, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, list, resolve, tagWithSchema } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { log } from "../sugar/activity.js";
import { Charm, charmViewer } from "./19_process_manager.jsx";

type PickEvent = {
  detail: { value: Reference; label: string };
};

const StackItem = z.object({
  charm: Charm,
  order: z.number(),
});

const StackLayout = z.object({
  items: z.array(StackItem),
  "~/common/ui/picker": UiFragment.describe("find Charms to display"),
  "~/common/ui/list": UiFragment.describe("stack items"),
});

export const canvasLayout = typedBehavior(
  StackLayout.pick({
    "~/common/ui/list": true,
    "~/common/ui/picker": true,
  }),
  {
    render: ({
      self,
      "~/common/ui/list": stackList,
      "~/common/ui/picker": stackPicker,
    }) => (
      <div entity={self} title="Canvas Layout">
        <h1>Canvas Layout</h1>
        {subview(stackPicker)}
        <br />
        {subview(stackList)}
      </div>
    ),
    rules: schema => ({
      init: initRules.init,

      renderPicker: list(Charm, Charm.pick({ name: true }))
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/picker",
                (
                  <div>
                    <common-picker
                      items={items.map(item => ({
                        value: item.self,
                        label: item.name + " (" + item.self.toString() + ")",
                      }))}
                      onpick="~/on/pick"
                    />
                    <button onclick="~/on/close-all">Close All</button>
                  </div>
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      onCloseAll: {
        select: {
          self: $.self,
          items: [
            {
              self: $.item,
              event: $.event,
              charm: {
                self: $.charm,
                name: $.name,
                spell: {
                  self: $.spell,
                  sourceCode: $.sourceCode,
                },
              },
            },
          ],
        },
        where: [
          { Case: [$.self, "~/on/close-all", $.event] },
          { Case: [$.self, "items", $.item] },
          { Case: [$.item, "charm", $.charm] },
          { Case: [$.charm, "spell", $.spell] },
          { Case: [$.charm, "name", $.name] },
          { Case: [$.spell, "sourceCode", $.sourceCode] },
        ],
        update: ({ self, event, items }) => {
          return [
            ...items.map(item => ({ Retract: [self, "items", item.self] })),
            { Upsert: [self, "~/common/ui/list", <div></div>] },
          ];
        },
      },

      onPick: event("~/on/pick").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<PickEvent>(event);
        const charm = ev.detail;
        const item = { charm: charm.value, order: Date.now() };

        const { self: itemId, instructions } = importEntity(item, StackItem);
        cmd.add(...instructions);

        cmd.add(
          ...Transact.assert(self, {
            items: itemId,
          }),
        );
      }),

      renderStack: {
        select: {
          self: $.self,
          items: [
            {
              self: $.item,
              charm: {
                self: $.charm,
                name: $.name,
                spell: {
                  self: $.spell,
                  sourceCode: $.sourceCode,
                },
              },
            },
          ],
        },
        where: [
          { Case: [$.self, "items", $.item] },
          { Case: [$.item, "charm", $.charm] },
          { Case: [$.charm, "spell", $.spell] },
          { Case: [$.charm, "name", $.name] },
          { Case: [$.spell, "sourceCode", $.sourceCode] },
        ],
        update({ self, items }) {
          console.log(items);

          return [
            {
              Upsert: [
                self,
                "~/common/ui/list",
                (
                  <div style="display: flex; overflow-x: scroll; width: 100%;">
                    <common-canvas-layout>
                      {items.map(item => (
                        <div id={item.self.toString()} key={item.self}>
                          <CharmComponent
                            self={item.charm.self}
                            spell={charmViewer as any}
                          />
                        </div>
                      ))}
                    </common-canvas-layout>
                  </div>
                ) as any,
              ],
            },
          ];
        },
      },

      // renderStack: resolve(StackLayout.pick({ items: true }))
      //   .update(({ self, items }) => {
      //     console.log(items);
      //     items = items.filter(item => !!(item as any).charm.spell);

      //     return [
      //       {
      //         Upsert: [
      //           self,
      //           "~/common/ui/list",
      //           (
      //             <div style="display: flex; overflow-x: scroll; width: 100%">
      //               {items.map(item => (
      //                 <div key={item.order} style="min-width: 512px">
      //                   <pre>{JSON.stringify(item, null, 2)}</pre>
      //                 </div>
      //               ))}
      //             </div>
      //           ) as any,
      //         ],
      //       },
      //     ];
      //   })
      //   .commit(),
    }),
  },
);
