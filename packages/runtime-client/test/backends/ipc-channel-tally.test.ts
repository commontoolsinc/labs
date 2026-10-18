import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";

import {
  IPC_SAMPLE_STRIDE,
  IpcChannelTally,
} from "@/backends/ipc-channel-tally.ts";

describe("IpcChannelTally", () => {
  describe("instance members", () => {
    describe("note()", () => {
      it("measures the first message and one in every stride after, and counts the rest", () => {
        const tally = new IpcChannelTally();
        const encoded = ["marker", { text: "hello" }];
        const { bytes } = approximateJsonSize(encoded);
        for (let sent = 0; sent < IPC_SAMPLE_STRIDE + 1; sent++) {
          tally.note(encoded);
        }

        expect(tally.snapshot()).toEqual({
          messages: IPC_SAMPLE_STRIDE + 1,
          sampledMessages: 2,
          sampledBytes: bytes * 2,
          approxBytes: bytes * (IPC_SAMPLE_STRIDE + 1),
        });
      });
    });

    describe("add()", () => {
      it("adds another channel's counts to this one's", () => {
        const tally = new IpcChannelTally();
        tally.note("one");
        tally.add({
          messages: 10,
          sampledMessages: 1,
          sampledBytes: 95,
          approxBytes: 950,
        });

        expect(tally.snapshot()).toEqual({
          messages: 11,
          sampledMessages: 2,
          sampledBytes: 100,
          approxBytes: 550,
        });
      });
    });

    describe("snapshot()", () => {
      it("returns zero bytes for a channel that carried nothing", () => {
        expect(new IpcChannelTally().snapshot()).toEqual({
          messages: 0,
          sampledMessages: 0,
          sampledBytes: 0,
          approxBytes: 0,
        });
      });

      it("scales the sampled bytes to every message, measured or not", () => {
        const tally = new IpcChannelTally();
        const large = "x".repeat(1_000);
        tally.note(large);
        for (let sent = 1; sent < IPC_SAMPLE_STRIDE; sent++) tally.note("y");

        const sizes = tally.snapshot();
        expect(sizes.sampledMessages).toBe(1);
        expect(sizes.approxBytes).toBe(
          approximateJsonSize(large).bytes * IPC_SAMPLE_STRIDE,
        );
      });
    });
  });
});
