import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { ProtocolError } from "../v2.ts";
import {
  DEFAULT_WIRE_CHUNK_SIZE,
  DEFAULT_WIRE_REASSEMBLY_CAP,
  getWireChunkingConfig,
  resetWireChunkingConfig,
  setWireChunkingConfig,
  splitWireMessage,
  WireChunker,
  WireChunkingError,
  WireReassembler,
} from "../v2/wire-chunking.ts";

/** An encoded payload of exactly `units` UTF-16 code units. */
const payloadOf = (units: number): string =>
  `fvj1:${"a".repeat(units - "fvj1:".length)}`;

/** The frames a connection with no traffic behind it sends for `payload`. */
const framesFor = (payload: string): string[] =>
  splitWireMessage(payload, new WireChunker());

type ParsedFrame = {
  streamId: number;
  index: number;
  count: number;
  slice: string;
};

/** Reads a chunk frame's header fields and the slice behind them. */
const parseFrame = (frame: string): ParsedFrame => {
  const header = /^fvc1:(\d+):(\d+):(\d+):/.exec(frame);
  if (header === null) throw new Error(`Not a chunk frame: ${frame}`);
  return {
    streamId: Number(header[1]),
    index: Number(header[2]),
    count: Number(header[3]),
    slice: frame.slice(header[0].length),
  };
};

/** What each `accept()` call returned, in the order the frames were fed. */
const acceptAll = (frames: readonly string[]): (string | null)[] => {
  const reassembler = new WireReassembler();
  return frames.map((frame) => reassembler.accept(frame));
};

/** The text as it survives a UTF-8 encode and decode. */
const throughUtf8 = (text: string): string =>
  new TextDecoder().decode(new TextEncoder().encode(text));

/**
 * The payload the last frame completes, given that no earlier one does. Each
 * frame makes the UTF-8 round trip a text socket puts it through, so a slice
 * cut inside a surrogate pair loses the pair here as it would on the wire.
 */
const reassemble = (frames: readonly string[]): string => {
  const results = acceptAll(frames.map(throughUtf8));
  expect(results.slice(0, -1)).toEqual(new Array(frames.length - 1).fill(null));
  const last = results[results.length - 1];
  if (last === null) throw new Error("The frames left a stream unfinished.");
  return last;
};

/** The `code` of the {@link WireChunkingError} that `run` throws. */
const errorCodeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof WireChunkingError) return error.code;
    throw error;
  }
  throw new Error("Nothing was thrown.");
};

describe("wire-chunking", () => {
  afterEach(() => {
    resetWireChunkingConfig();
  });

  describe("splitWireMessage()", () => {
    it("returns a payload under the chunk size as one unchanged frame", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = payloadOf(10);
      expect(framesFor(payload)).toEqual([payload]);
    });

    it("returns a payload of exactly the chunk size as one unchanged frame", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = payloadOf(16);
      expect(framesFor(payload)).toEqual([payload]);
    });

    it("splits a payload one code unit over the chunk size into two frames", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const frames = framesFor(payloadOf(17));
      expect(frames.length).toBe(2);
      expect(frames.map((frame) => parseFrame(frame).slice.length))
        .toEqual([16, 1]);
    });

    it("cuts an exact multiple of the chunk size into full slices", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const frames = framesFor(payloadOf(48));
      expect(frames.map((frame) => parseFrame(frame).slice.length))
        .toEqual([16, 16, 16]);
    });

    it("numbers the frames of one message from 0 under a single stream identifier", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const parsed = framesFor(payloadOf(40)).map(parseFrame);
      expect(parsed.map((frame) => frame.index)).toEqual([0, 1, 2]);
      expect(parsed.map((frame) => frame.count)).toEqual([3, 3, 3]);
      expect(new Set(parsed.map((frame) => frame.streamId)).size).toBe(1);
    });

    it("numbers one connection's streams upward from 0", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const chunker = new WireChunker();
      const streamIds = [payloadOf(40), payloadOf(40), payloadOf(40)].map(
        (payload) => parseFrame(splitWireMessage(payload, chunker)[0]).streamId,
      );
      expect(streamIds).toEqual([0, 1, 2]);
    });

    it("numbers each connection's streams without regard to another's", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const one = new WireChunker();
      const other = new WireChunker();
      const streamIdOn = (chunker: WireChunker) =>
        parseFrame(splitWireMessage(payloadOf(40), chunker)[0]).streamId;
      expect([streamIdOn(one), streamIdOn(other), streamIdOn(one)])
        .toEqual([0, 0, 1]);
    });

    it("moves a slice boundary back off a high surrogate", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      // The astral character occupies code units 15 and 16, so an unmoved
      // boundary at 16 would split the pair.
      const payload = `fvj1:${"a".repeat(10)}\u{1F600}${"b".repeat(20)}`;
      const frames = framesFor(payload);
      expect(frames.map((frame) => parseFrame(frame).slice.length))
        .toEqual([15, 16, 6]);
      expect(parseFrame(frames[1]).slice.startsWith("\u{1F600}")).toBe(true);
    });

    it("returns frames that each survive a UTF-8 round trip", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = `fvj1:${"a".repeat(10)}\u{1F600}${"b".repeat(20)}`;
      for (const frame of framesFor(payload)) {
        expect(throughUtf8(frame)).toBe(frame);
      }
    });
  });

  describe("round-trip", () => {
    it("returns a payload under the chunk size unchanged", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = payloadOf(10);
      expect(reassemble(framesFor(payload))).toBe(payload);
    });

    it("returns a payload of exactly the chunk size unchanged", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = payloadOf(16);
      expect(reassemble(framesFor(payload))).toBe(payload);
    });

    it("returns a payload over the chunk size unchanged", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = payloadOf(101);
      expect(reassemble(framesFor(payload))).toBe(payload);
    });

    it("returns a payload of an exact multiple of the chunk size unchanged", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = payloadOf(64);
      expect(reassemble(framesFor(payload))).toBe(payload);
    });

    it("returns a payload split inside a surrogate pair unchanged", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      const payload = `fvj1:${"a".repeat(10)}\u{1F600}${"b".repeat(20)}`;
      const reassembled = reassemble(framesFor(payload));
      expect(reassembled).toBe(payload);
      expect(throughUtf8(reassembled)).toBe(payload);
    });

    it("returns a payload of astral characters throughout unchanged", () => {
      setWireChunkingConfig({ chunkSize: 9 });
      const payload = `fvj1:${"\u{1F600}\u{10348}".repeat(30)}`;
      const frames = framesFor(payload);
      for (const frame of frames) expect(throughUtf8(frame)).toBe(frame);
      expect(reassemble(frames)).toBe(payload);
    });

    it("returns a payload cut at the smallest chunk size unchanged", () => {
      setWireChunkingConfig({ chunkSize: 2 });
      const payload = `fvj1:\u{1F600}\u{10348}`;
      const frames = framesFor(payload);
      for (const frame of frames) expect(throughUtf8(frame)).toBe(frame);
      expect(frames.map((frame) => parseFrame(frame).slice.length))
        .toEqual([2, 2, 1, 2, 2]);
      expect(reassemble(frames)).toBe(payload);
    });
  });

  describe("WireReassembler", () => {
    describe("instance members", () => {
      describe("accept()", () => {
        it("returns an unchunked frame unchanged", () => {
          const payload = payloadOf(1000);
          expect(new WireReassembler().accept(payload)).toBe(payload);
        });

        it("returns `null` for every frame but the last of a stream", () => {
          setWireChunkingConfig({ chunkSize: 16 });
          const results = acceptAll(framesFor(payloadOf(40)));
          expect(results.slice(0, -1)).toEqual([null, null]);
          expect(results[2]).toBe(payloadOf(40));
        });

        it("returns the payload of a stream that follows a completed one", () => {
          setWireChunkingConfig({ chunkSize: 16 });
          const chunker = new WireChunker();
          const reassembler = new WireReassembler();
          for (const frame of splitWireMessage(payloadOf(40), chunker)) {
            reassembler.accept(frame);
          }
          const second = payloadOf(35);
          let completed: string | null = null;
          for (const frame of splitWireMessage(second, chunker)) {
            completed = reassembler.accept(frame);
          }
          expect(completed).toBe(second);
        });

        it("throws a `ProtocolError` for a framing violation", () => {
          expect(() => new WireReassembler().accept("fvc1:0:1:2:body"))
            .toThrow(ProtocolError);
        });

        it("throws `malformed-header` for a header missing a field", () => {
          expect(errorCodeOf(() => new WireReassembler().accept("fvc1:0:0")))
            .toBe("malformed-header");
        });

        it("throws `malformed-header` for a non-decimal header field", () => {
          expect(
            errorCodeOf(() => new WireReassembler().accept("fvc1:x:0:2:body")),
          ).toBe("malformed-header");
        });

        it("throws `malformed-header` for a count of 1", () => {
          expect(
            errorCodeOf(() => new WireReassembler().accept("fvc1:0:0:1:body")),
          ).toBe("malformed-header");
        });

        it("throws `malformed-header` for an index past the count", () => {
          expect(
            errorCodeOf(() => new WireReassembler().accept("fvc1:0:2:2:body")),
          ).toBe("malformed-header");
        });

        it("throws `malformed-header` for a count that changes mid-stream", () => {
          const reassembler = new WireReassembler();
          reassembler.accept("fvc1:7:0:3:one");
          expect(errorCodeOf(() => reassembler.accept("fvc1:7:1:4:two")))
            .toBe("malformed-header");
        });

        it("throws `unexpected-index` for a stream opening past index 0", () => {
          expect(
            errorCodeOf(() => new WireReassembler().accept("fvc1:0:1:3:body")),
          ).toBe("unexpected-index");
        });

        it("throws `unexpected-index` for a gap in the indexes", () => {
          const reassembler = new WireReassembler();
          reassembler.accept("fvc1:7:0:3:one");
          expect(errorCodeOf(() => reassembler.accept("fvc1:7:2:3:three")))
            .toBe("unexpected-index");
        });

        it("throws `unexpected-index` for a repeated index", () => {
          const reassembler = new WireReassembler();
          reassembler.accept("fvc1:7:0:3:one");
          expect(errorCodeOf(() => reassembler.accept("fvc1:7:0:3:one")))
            .toBe("unexpected-index");
        });

        it("throws `interleaved-frame` for an unchunked frame inside a stream", () => {
          const reassembler = new WireReassembler();
          reassembler.accept("fvc1:7:0:3:one");
          expect(errorCodeOf(() => reassembler.accept(payloadOf(20))))
            .toBe("interleaved-frame");
        });

        it("throws `interleaved-frame` for a second stream inside a stream", () => {
          const reassembler = new WireReassembler();
          reassembler.accept("fvc1:7:0:3:one");
          expect(errorCodeOf(() => reassembler.accept("fvc1:8:0:2:other")))
            .toBe("interleaved-frame");
        });

        it("throws `reassembly-cap-exceeded` for a stream past the cap", () => {
          setWireChunkingConfig({ chunkSize: 8, reassemblyCap: 12 });
          const frames = framesFor(payloadOf(24));
          const reassembler = new WireReassembler();
          expect(reassembler.accept(frames[0])).toBe(null);
          expect(errorCodeOf(() => reassembler.accept(frames[1])))
            .toBe("reassembly-cap-exceeded");
        });
      });

      describe("reset()", () => {
        it("drops the open stream, so an unchunked frame passes through", () => {
          const reassembler = new WireReassembler();
          reassembler.accept("fvc1:7:0:3:one");
          reassembler.reset();
          const payload = payloadOf(20);
          expect(reassembler.accept(payload)).toBe(payload);
        });

        it("drops the open stream, so a new stream may open at index 0", () => {
          setWireChunkingConfig({ chunkSize: 16 });
          const reassembler = new WireReassembler();
          reassembler.accept("fvc1:7:0:3:one");
          reassembler.reset();
          const payload = payloadOf(40);
          let completed: string | null = null;
          for (const frame of framesFor(payload)) {
            completed = reassembler.accept(frame);
          }
          expect(completed).toBe(payload);
        });
      });
    });
  });

  describe("setWireChunkingConfig()", () => {
    it("leaves a size the override omits at its default", () => {
      setWireChunkingConfig({ chunkSize: 16 });
      expect(getWireChunkingConfig()).toEqual({
        chunkSize: 16,
        reassemblyCap: DEFAULT_WIRE_REASSEMBLY_CAP,
      });
    });

    it("throws given a chunk size below two code units", () => {
      // A one-unit slice cannot hold a surrogate pair, so no boundary rule
      // keeps a pair whole at that size.
      expect(() => setWireChunkingConfig({ chunkSize: 1 })).toThrow(RangeError);
      expect(() => setWireChunkingConfig({ chunkSize: 0 })).toThrow(RangeError);
    });

    it("throws given a reassembly cap below one code unit", () => {
      expect(() => setWireChunkingConfig({ reassemblyCap: -1 }))
        .toThrow(RangeError);
    });
  });

  describe("getWireChunkingConfig()", () => {
    it("returns the deployment defaults before any override", () => {
      expect(getWireChunkingConfig()).toEqual({
        chunkSize: DEFAULT_WIRE_CHUNK_SIZE,
        reassemblyCap: DEFAULT_WIRE_REASSEMBLY_CAP,
      });
    });
  });

  describe("resetWireChunkingConfig()", () => {
    it("returns both sizes to their defaults", () => {
      setWireChunkingConfig({ chunkSize: 16, reassemblyCap: 32 });
      resetWireChunkingConfig();
      expect(getWireChunkingConfig()).toEqual({
        chunkSize: DEFAULT_WIRE_CHUNK_SIZE,
        reassemblyCap: DEFAULT_WIRE_REASSEMBLY_CAP,
      });
    });
  });
});
