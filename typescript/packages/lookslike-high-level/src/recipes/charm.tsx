import { h, behavior, refer, $ } from "@commontools/common-system";

export const source = { clicker: { v: 22 } };

const entity = refer(source);

export const rules = behavior({
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
            <div title={`Clicks ${count}`}>
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
});

export const spawn = (input = source) => rules.spawn(input);
