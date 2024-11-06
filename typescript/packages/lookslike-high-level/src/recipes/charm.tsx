import { NAME, UI, recipe } from "@commontools/common-builder";
import { refer, $ } from "synopsys";
import * as DOM from "@gozala/co-dom";
import { h } from "@commontools/common-html";
import z from "zod";

export const on = (
  event: DOM.EncodedEvent["type"],
  attribute: string = `~/on/${event}`,
) =>
  DOM.on(event, {
    /**
     *
     * @param {DOM.EncodedEvent} event
     */
    decode(event) {
      return {
        message: /** @type {DB.Fact} */ [
          attribute,
          /** @type {any & DB.Entity} */ event,
        ],
      };
    },
  });

const entity = refer({ clicker: { v: 10 } });

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
            DOM.div(
              [],
              [
                DOM.div([], [DOM.text(String(count))]),
                DOM.button(
                  [on("click", "~/on/click")],
                  [DOM.text("Click me!")],
                ),
              ],
            ),
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
          Retract: [entity, "clicks", count],
        },
        {
          Assert: [entity, "clicks", count + 1],
        },
      ];
    },
  },
};

export const charmExample = recipe(z.object({}), () => {
  return {
    [NAME]: "Charm",
    [UI]: <common-charm spell={() => Clicker} entity={() => entity} />,
  };
});
