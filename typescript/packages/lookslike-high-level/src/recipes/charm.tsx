import { NAME, UI, recipe } from "@commontools/common-builder";
import { refer, $ } from "synopsys";
import * as DOM from "@gozala/co-dom";
import { h } from "@commontools/common-html";
import z from "zod";

const entity = refer({ clicker: {} });

const Clicker = {
  init: {
    select: {},
    where: [{ Not: { Case: [entity, "clicks", $.count] } }],
    update: ({}) => {
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
            DOM.div([], [DOM.text(String(count))]),
          ],
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
