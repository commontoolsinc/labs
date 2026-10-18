/**
 * The count of what one outbound channel of the worker has carried, kept at
 * the send site so the sizes read can say which port the serialization
 * traffic crossed. Measuring a message walks its encoding, which costs about
 * a tenth of what encoding and cloning it cost, so one message in
 * {@link IPC_SAMPLE_STRIDE} is measured and the rest are counted.
 */

import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";

import type { IpcChannelSizes } from "@/protocol/mod.ts";

/** How many messages apart the measured ones are; a channel's first is one. */
export const IPC_SAMPLE_STRIDE = 16;

/** Counts the messages of one channel and measures a sample of them. */
export class IpcChannelTally {
  #messages = 0;
  #sampledMessages = 0;
  #sampledBytes = 0;

  /**
   * Counts `encoded`, handed to the channel's `postMessage`, and measures it
   * when it falls on the stride.
   */
  note(encoded: unknown): void {
    if (this.#messages % IPC_SAMPLE_STRIDE === 0) {
      this.#sampledMessages++;
      this.#sampledBytes += approximateJsonSize(encoded).bytes;
    }
    this.#messages++;
  }

  /** Adds what another channel carried, for a tally that stands for several. */
  add(sizes: IpcChannelSizes): void {
    this.#messages += sizes.messages;
    this.#sampledMessages += sizes.sampledMessages;
    this.#sampledBytes += sizes.sampledBytes;
  }

  /** What the channel has carried so far. */
  snapshot(): IpcChannelSizes {
    return {
      messages: this.#messages,
      sampledMessages: this.#sampledMessages,
      sampledBytes: this.#sampledBytes,
      approxBytes: this.#sampledMessages === 0 ? 0 : Math.round(
        this.#sampledBytes / this.#sampledMessages * this.#messages,
      ),
    };
  }
}
