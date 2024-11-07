import { h, behavior, $, Reference } from "@commontools/common-system";

export const source = { clicker: { v: 30 } };

export const rules = behavior({
  init: {
    select: {
      self: $.self,
    },
    where: [
      // ...
      { Not: { Case: [$.self, "clicks", $._] } },
    ],
    update: ({ self }) => {
      console.log(self);

      return [{ Assert: [self, "clicks", 0] }];
    },
  },
  view: {
    select: { self: $.self, count: $.count },
    where: [{ Case: [$.self, "clicks", $.count] }],
    update: ({ count, self }: { count: number; self: Reference }) => {
      return [
        {
          Assert: [
            self,
            "~/common/ui",
            <div title={`Clicks ${count}`} data-source={`${self}`}>
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
      self: $.self,
      count: $.count,
      event: $.event,
    },
    where: [
      {
        Case: [$.self, "clicks", $.count],
      },
      {
        Case: [$.self, "~/on/click", $.event],
      },
    ],
    update: ({
      self,
      count,
      event,
    }: {
      self: Reference;
      count: number;
      event: any;
    }) => {
      return [
        {
          Upsert: [self, "clicks", count + 1],
        },
      ];
    },
  },
});

export const spawn = (input: {} = source) => rules.spawn(input);
