import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type FabrichatBenchmarkRooms,
  seedFabrichatBenchmarkRooms,
} from "../integration/fabrichat-room-bench-support.ts";

describe("fabrichat-room-bench-support", () => {
  describe("seedFabrichatBenchmarkRooms()", () => {
    it("seeds one room at a time and returns after every seed", async () => {
      type Label = keyof FabrichatBenchmarkRooms<string>;
      const gates = {
        read: Promise.withResolvers<void>(),
        send: Promise.withResolvers<void>(),
        react: Promise.withResolvers<void>(),
      };
      const started = {
        read: Promise.withResolvers<void>(),
        send: Promise.withResolvers<void>(),
        react: Promise.withResolvers<void>(),
      };
      const order: Label[] = [];
      let active = 0;
      let maximumActive = 0;
      let returned = false;

      const roomsPromise = seedFabrichatBenchmarkRooms(async (label) => {
        order.push(label);
        active++;
        maximumActive = Math.max(maximumActive, active);
        started[label].resolve();
        try {
          await gates[label].promise;
          return `${label} room`;
        } finally {
          active--;
        }
      });
      void roomsPromise.then(() => returned = true);

      await started.read.promise;
      expect(order).toEqual(["read"]);
      expect(active).toBe(1);
      expect(returned).toBe(false);

      gates.read.resolve();
      await started.send.promise;
      expect(order).toEqual(["read", "send"]);
      expect(active).toBe(1);
      expect(returned).toBe(false);

      gates.send.resolve();
      await started.react.promise;
      expect(order).toEqual(["read", "send", "react"]);
      expect(active).toBe(1);
      expect(returned).toBe(false);

      gates.react.resolve();
      expect(await roomsPromise).toEqual({
        read: "read room",
        send: "send room",
        react: "react room",
      });
      expect(maximumActive).toBe(1);
      expect(returned).toBe(true);
    });
  });
});
