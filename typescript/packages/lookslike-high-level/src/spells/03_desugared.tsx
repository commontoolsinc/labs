import { h, behavior, $, Reference } from "@commontools/common-system";

export default behavior({
  init: {
    select: {
      self: $.self,
    },
    where: [{ Not: { Case: [$.self, "clicks", $._] } }],
    update({ self }: { self: Reference }) {
      return [{ Upsert: [self, "clicks", 0] }];
    },
  },
  increment: {
    select: {
      self: $.self,
      clicks: $.clicks,
      event: $.event,
    },
    where: [
      { Case: [$.self, "clicks", $.clicks] },
      { Case: [$.self, "~/on/increment", $.event] },
    ],
    update({ self, clicks }: { self: Reference; clicks: number }) {
      return [{ Upsert: [self, "clicks", clicks + 1] }];
    },
  },
  decrement: {
    select: {
      self: $.self,
      clicks: $.clicks,
      event: $.event,
    },
    where: [
      { Case: [$.self, "clicks", $.clicks] },
      { Case: [$.self, "~/on/decrement", $.event] },
    ],
    update({ self, clicks }: { self: Reference; clicks: number }) {
      return [{ Upsert: [self, "clicks", clicks - 1] }];
    },
  },
  view: {
    select: {
      self: $.self,
      clicks: $.clicks,
    },
    where: [{ Case: [$.self, "clicks", $.clicks] }],
    update({ self, clicks }: { self: Reference; clicks: number }) {
      return [
        {
          Upsert: [
            self,
            "~/common/ui",
            <div title={`Clicks ${clicks}`} entity={self}>
              <output>{clicks}</output>
              <button onclick="~/on/increment">Increment</button>
              <button onclick="~/on/decrement">Decrement</button>
            </div> as any,
          ],
        },
      ];
    },
  },
});
