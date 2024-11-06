import { NAME, UI, recipe } from "@commontools/common-builder";
import { refer, $ } from "synopsys";
import { html } from "@commontools/common-html";
import { h } from "@commontools/common-system";
import z from "zod";

const entity = refer({ clicker: { v: 22 } });

const Clicker = {
  init: {
    select: {},
    where: [{ Not: { Case: [entity, "clicks", $.count] } }],
    update: () => {
      return [{ Assert: [entity, "clicks", 0] }];
    },
  },
  view: {
    select: { count: $.count },
    where: [{ Case: [entity, "clicks", $.count] }],
    update: ({ count }: { count: number }) => {
      return [
        {
          Assert: [
            entity,
            "~/common/ui",
            <div>
              <div>{count}</div>
              <button onclick="~/on/click">Click me!</button>
            </div>,
          ],
        },
      ];
    },
  },
  onclick: {
    select: {
      count: $.count,
      event: $.event,
    },
    where: [
      {
        Case: [entity, "clicks", $.count],
      },
      {
        Case: [entity, "~/on/click", $.event],
      },
    ],
    update: ({ count, event }: { count: number; event: any }) => {
      return [
        {
          Upsert: [entity, "clicks", count + 1],
        },
      ];
    },
  },
};

export const charmExample = recipe(z.object({}), () => {
  return {
    [NAME]: "Charm",
    [UI]: html`<common-charm spell=${() => Clicker} entity=${() => entity} />`,
  };
});
