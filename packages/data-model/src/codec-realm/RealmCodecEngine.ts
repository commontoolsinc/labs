import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { BaseCodecEngine } from "@/codec-common/BaseCodecEngine.ts";
import type { ReconstructionContext } from "@/codec-interface/interface.ts";
import {
  REALM_FORMAT_VERSION,
  type RealmCodecValue,
  type RealmEncodedValue,
  type RealmFormatMarker,
  type RealmTaggedValue,
} from "./interface.ts";

/**
 * Whole-value codec engine for the realm-crossing wire format: the form a
 * fabric value takes when it is handed to `structuredClone()` or
 * `postMessage()` to reach another realm.
 *
 * The counterpart to `JsonCodecEngine`, and the two divide along what their
 * transports carry. JSON reaches a `string`, so every type JavaScript has and
 * JSON lacks -- `bigint`, `undefined`, the special numbers, bytes, patterns --
 * is written out as tagged text, and a `/`-prefixed key in user data has to be
 * escaped clear of the tags. Cloning carries all of those but `symbol`, and
 * carries them with their types intact, so most of a value passes through
 * untouched and tagging is reserved for what genuinely needs it.
 *
 * **An encoded value is `[marker, tree]`**, and the marker is what makes every
 * tagged form beneath it recognizable. It is a fresh object per `encode()`
 * call, repeated at slot zero of each tagged form, and a receiver takes it from
 * the outer envelope and recognizes the rest by `===` against it. Structured
 * cloning preserving shared references is what carries that across; the marker
 * being younger than the value it encodes, and confined to the engine until
 * that encode returns, is what keeps a payload from containing one.
 * {@link RealmFormatMarker} states all three.
 *
 * The marker carries a version string, and `decode()` refuses an outer
 * envelope whose marker is not this build's. That holds the boundary it exists
 * for: worker IPC within one process, where both ends are the same build.
 * `postMessage()` also spans tabs, windows and frames, any of which could pair
 * two deployments, and a payload from one this build does not understand is
 * refused rather than walked.
 *
 * Two pieces of `JsonCodecEngine` have no counterpart here, each because the
 * transport does the work directly:
 *
 * * **No escaping.** `/quote` and `/object` exist because a JSON object is the
 *   only container JSON has, so a tag and a user's data compete for the same
 *   shape. Here they compete for the same shape too -- a tagged form is an
 *   ordinary three-element array -- and identity settles it instead, which
 *   costs nothing on the wire where escaping costs a rewrite of the object
 *   around it.
 * * **No `/hole`.** Cloning preserves a sparse array's length and its absent
 *   indices, so a hole crosses as a hole.
 *
 * Both walks are copy-on-write: a subtree in which nothing changed is returned
 * by identity rather than rebuilt. A payload holding no `FabricSpecialObject`
 * and no symbol is therefore handed to the transport exactly as it arrived --
 * the same object, not a reconstruction of it -- and copied once by the
 * transport instead of twice. The outer envelope stops that one layer in -- the
 * outermost value is always the two-element wrapper -- which costs two
 * allocations per call, the wrapper and the marker, and no rebuild of
 * anything beneath it. That is the ordinary case
 * for plain data, and it makes the walk's cost proportional to what actually
 * needs encoding rather than to the size of the value. `JsonCodecEngine` never
 * faces the choice, having to reach text.
 *
 * **`decode()` cedes its input**, and **a decoded tree carries no guarantee of
 * being usable again**. The engine retains what it likes of the tree, and two
 * retentions are deliberate: a subtree needing no decoding comes back by
 * identity, and a byte-carrying value takes over the `ArrayBuffer` it arrived
 * in rather than copying it. Every container it returns is frozen, retained
 * and rebuilt alike; an `ArrayBuffer` cannot be, which is what makes ceding it
 * a requirement rather than a courtesy. A call that raised consumed the tree
 * as thoroughly as one that returned, a refusal being able to arrive after a
 * buffer is already detached.
 *
 * Nothing detects a second `decode()` or sets out to defeat one -- the
 * guarantee is withheld, not enforced -- and which trees survive follows from
 * what they carry. Bytes are the case where it definitely fails: taking a
 * buffer over detaches it, so a second call cannot reconstruct what the first
 * did, and the attempt is settled against leniency like any other refusal,
 * strict raising and lenient yielding a `ProblematicValue` where the bytes
 * would have been. `FabricBytes` and `FabricHash` are the classes that reach
 * that path, directly or nested anywhere beneath; a tree holding neither
 * happens to decode repeatedly, which is a fact about these containers rather
 * than a promise. On the boundary this format exists for none of it costs a
 * caller anything -- the tree is the receiver's own clone of a value it will
 * not be handed again, which is the whole reason the copy can be elided -- but
 * a caller wanting two readings of one payload keeps the value it decoded, not
 * the tree it decoded from.
 *
 * **Cycles are refused by both walks**, and **a shared reference survives
 * exactly where nothing beneath it needed encoding**, per Section 1.6 of the
 * formal spec, which requires an engine to say which of these it does. Neither
 * answer comes from the transport, which would carry either faithfully; both
 * come from the walk.
 *
 * The two walks refuse a cycle differently, and for the reason they differ
 * everywhere else. Encoding raises: the value is a local caller's, and a cycle
 * in it is that caller's bug. Decoding reports, settled against `lenient`,
 * because a cycle arriving on a channel is untrusted data like any other
 * malformation -- and cloning delivers one faithfully, so a peer can send one.
 * Leniently the report lands at the cycle, leaving the rest of the value
 * intact.
 *
 * Copy-on-write is what preserves the sharing it preserves. A subtree needing
 * no encoding comes back by identity, so every position that held the one
 * object still holds it. Where a shared subtree does need encoding, each
 * position rebuilds it on its own, and the encoding has two equal objects
 * where the value had one -- structure that a receiver cannot tell from two
 * that were always distinct.
 *
 * TODO(danfuzz): A memo from each visited object to its encoded counterpart
 * closes both at once: a repeat visit yields the node already built for it,
 * which preserves sharing through a rebuild and lets a back-edge resolve
 * instead of recursing. It has to reach `BaseCodecEngine`'s walk state rather
 * than living here, since a cycle can run through a codec-matched object as
 * readily as through a container.
 */
export class RealmCodecEngine
  extends BaseCodecEngine<RealmCodecValue, RealmEncodedValue> {
  /**
   * The marker for the encode or decode in progress, or `undefined` outside
   * one.
   *
   * A field, unlike the walk's `seen` set, and for a reason that does not
   * apply to that one. `seen` is per-node state, and holding it in a field is
   * how an arm comes to forget to enter or leave a node; the marker is a
   * per-call constant, set at one place and read at one place, with no arm
   * that can silently skip it. What both share is the save-and-restore, so
   * that a codec reaching back through a public entry point cannot leave the
   * outer call without its own.
   */
  #marker: RealmFormatMarker | undefined;

  //
  // Instance members
  //

  /**
   * @inheritDoc
   *
   * Mints this call's marker and returns `[marker, walkedTree]`. The tree
   * inside is still copy-on-write, so a payload needing no encoding is the
   * caller's own object rather than a reconstruction of it; what the outer
   * envelope costs is two allocations per call, the wrapper and the marker,
   * and what it buys is a receiver able to tell this form from anything else
   * on the channel, and to tell which build wrote it.
   *
   * The marker is created here, after `value` exists, which is the whole of
   * why neither an outer envelope nor a tagged form can be forged from within
   * a payload. See {@link RealmFormatMarker}.
   */
  override encode(value: FabricValue): RealmEncodedValue {
    // Saved and restored rather than set and cleared, so that an encode
    // reached from inside another one cannot leave the outer call marker-less.
    const outer = this.#marker;

    this.#marker = Object.freeze([REALM_FORMAT_VERSION] as const);

    try {
      return [this.#marker, this.encodeValue(value)];
    } finally {
      this.#marker = outer;
    }
  }

  /**
   * @inheritDoc
   *
   * Takes the marker from the outer envelope and walks what it wraps. That
   * envelope is the one place this method takes instruction from the data, so
   * it is checked in full before anything is read from it: two elements, and a
   * one-element array in slot zero holding this format's version. What cloning
   * carries but this format never emits is refused where it is found, by
   * `decodeValue()`.
   *
   * Checking the marker's contents buys little in practice, since a payload
   * from the same build always satisfies it and recognition never reads it
   * afterwards. It is cheap, though, and it is what keeps the adoption below
   * from being a cast that outruns what was checked -- an arbitrary object
   * adopted as a marker would leave every tagged form beneath unrecognized and
   * a foreign tree decoding as ordinary data rather than being refused.
   *
   * Adopting the sender's marker is what makes recognition work across the
   * boundary. The receiver's own objects are no use -- a marker minted here is
   * a different object from the one that crossed -- and cloning having
   * preserved the sender's sharing, the object in slot zero is the same object
   * that sits in slot zero of every tagged form beneath it.
   *
   * **`data` is ceded to this method**, which retains whatever parts of it it
   * likes, so a caller must not use it afterwards. Two retentions are
   * deliberate: a subtree needing no decoding comes back by identity rather
   * than rebuilt, and a `FabricBytes` takes over the buffer it arrived in.
   * Every container this returns is frozen, retained and rebuilt alike; the
   * byte buffer cannot be, which is what makes ceding it a requirement rather
   * than a courtesy. Taking a buffer over detaches it, so a tree carrying
   * bytes cannot be decoded a second time, such a call raising when strict and
   * yielding a `ProblematicValue` when lenient. No tree is guaranteed to
   * survive a decode; one holding no bytes merely happens to.
   *
   * Across the boundary that costs a caller nothing, the tree being the
   * receiver's own clone of a sender's value. Same-realm it is visible:
   * `encode()` returns unchanged subtrees by identity too, so
   * `decode(encode(value))` can hand back the very objects that went in, and
   * `value` is frozen as deeply as the walk reached.
   */
  override decode(
    data: RealmEncodedValue,
    context: ReconstructionContext,
  ): FabricValue {
    if (!Array.isArray(data) || (data.length !== 2)) {
      return this.reportMalformed(
        "",
        toCompactDebugString(data, 50),
        "not a value this format emits: expected a two-element outer envelope",
      );
    }

    const marker = data[0];

    if (
      !Array.isArray(marker) || (marker.length !== 1) ||
      (marker[0] !== REALM_FORMAT_VERSION)
    ) {
      return this.reportMalformed(
        "",
        toCompactDebugString(data, 50),
        `not a value this format emits: expected an outer envelope headed by a ${
          backtickQuote(REALM_FORMAT_VERSION)
        } marker`,
      );
    }

    const outer = this.#marker;

    this.#marker = marker as RealmFormatMarker;

    try {
      // A set is started here because this format's transport is the tree
      // itself, so a peer can hand one over with a cycle in it.
      // `JsonCodecEngine` starts none, its input being the product of a parse.
      return this.decodeValue(data[1] as RealmCodecValue, context, new Set());
    } finally {
      this.#marker = outer;
    }
  }

  /**
   * @inheritDoc
   *
   * @throws If there is no marker to build a tagged form around, which is the
   *   case outside an encode and a decode both. Note what it therefore does
   *   *not* catch: during a decode the field holds the sender's marker, so a
   *   tag wrapped there would be wrapped under that one rather than refused.
   *   Nothing reaches it that way -- `decodeTagged()` never encodes -- and the
   *   guard is here for the case it does cover, a tagged form built with no
   *   marker at all being one nothing could recognize.
   */
  protected override wrapTag(
    tag: string,
    state: RealmCodecValue,
  ): RealmTaggedValue {
    const marker = this.#marker;

    if (marker === undefined) {
      throw new Error("Cannot wrap a tag outside an encode.");
    }

    return [marker, tag, state];
  }

  /**
   * @inheritDoc
   *
   * Holes need no representation: cloning carries a sparse array's length and
   * its absent indices directly, so skipping an absent index here leaves it
   * absent in the result.
   */
  protected override encodeArray(
    value: readonly FabricValue[],
    seen: Set<object>,
  ): RealmCodecValue {
    RealmCodecEngine.enterOrThrow(seen, value);

    const length = value.length;
    let result: RealmCodecValue[] | undefined;

    for (let i = 0; i < length; i++) {
      if (!(i in value)) {
        continue;
      }

      const original = value[i]!;
      const encoded = this.encodeValue(original, seen);

      if (result !== undefined) {
        result[i] = encoded;
      } else if (!Object.is(encoded, original)) {
        // The first element that changed: copy what came before it, holes and
        // all, and write into the copy from here on.
        result = new Array<RealmCodecValue>(length);
        for (let j = 0; j < i; j++) {
          if (j in value) {
            result[j] = value[j] as RealmCodecValue;
          }
        }
        result[i] = encoded;
      }
    }

    seen.delete(value);
    return result ?? (value as RealmCodecValue);
  }

  /**
   * @inheritDoc
   *
   * Keys are visited in their own order rather than sorted. JSON sorts to make
   * its text canonical, which is what lets an encoding be hashed and compared
   * as bytes; cloning preserves key order and nothing here is compared that
   * way, so sorting would buy nothing and would force a rebuild of every
   * object.
   *
   * A `/`-prefixed key needs no escaping either, this format reserving no key
   * at all. A name this runtime reserves is still refused: the rebuild below
   * cannot reproduce one, and a silent reshaping is worse than a refusal.
   */
  protected override encodePlainObject(
    value: Record<string, FabricValue>,
    seen: Set<object>,
  ): RealmCodecValue {
    RealmCodecEngine.enterOrThrow(seen, value);

    const keys = Object.keys(value);
    let result: Record<string, RealmCodecValue> | undefined;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;

      // Checked on every object, not just the ones that get rebuilt, so that
      // the answer does not depend on whether some sibling happened to change.
      RealmCodecEngine.assertEncodableKey(key);

      const original = value[key]!;
      const encoded = this.encodeValue(original, seen);

      if (result !== undefined) {
        result[key] = encoded;
      } else if (!Object.is(encoded, original)) {
        result = {};
        for (let j = 0; j < i; j++) {
          result[keys[j]!] = value[keys[j]!] as RealmCodecValue;
        }
        result[key] = encoded;
      }
    }

    seen.delete(value);
    return result ?? (value as RealmCodecValue);
  }

  /**
   * @inheritDoc
   *
   * Every object node goes through the guard, whichever arm then takes it. The
   * tagged form needs it as much as a container does: `decodeTagged()` walks
   * the state again for a nonterminal codec, for a tag no codec claims, and
   * for a tag that is not one, so a graph of tagged forms can close a cycle
   * with no plain container in it at all, and cloning carries such a graph
   * faithfully.
   */
  protected override decodeValue(
    data: RealmCodecValue,
    context: ReconstructionContext,
    seen?: Set<object>,
  ): FabricValue {
    // Self-representing primitives pass straight through. A `symbol` and a
    // function are not among them and are refused here rather than returned:
    // cloning carries neither, so neither can reach this across the boundary
    // -- but `decode()` is callable in the realm that built its argument, and
    // what this format never emits is refused wherever it is found rather
    // than only where a transport would have stopped it. `encode()` refuses
    // both too, from the other side.
    if (data === null) {
      return null;
    }

    if ((typeof data === "symbol") || (typeof data === "function")) {
      return this.reportMalformed(
        "",
        toCompactDebugString(data, 50),
        `Cannot decode ${typeof data}: not a form this format emits.`,
      );
    }

    if (typeof data !== "object") {
      return data as FabricValue;
    }

    if (seen !== undefined) {
      const cycle = this.enterOrReport(seen, data);
      if (cycle !== null) {
        return cycle;
      }
    }

    try {
      const unwrapped = this.#unwrapTag(data);

      if (unwrapped !== null) {
        return this.decodeTagged(
          unwrapped.tag,
          unwrapped.state,
          context,
          seen,
        );
      } else if (Array.isArray(data)) {
        return this.#decodeArray(data, context, seen);
      } else if (isPlainObject(data)) {
        return this.#decodePlainObject(data, context, seen);
      }

      // Wire data is untrusted, and cloning carries a good deal this format
      // never emits -- a bare `Uint8Array`, a `Date`, a multi-entry `Map` --
      // all of which reach here.
      return this.reportMalformed(
        "",
        data,
        `Cannot decode ${
          backtickQuote(toCompactDebugString(data, 50))
        }: not a form this format emits.`,
      );
    } finally {
      seen?.delete(data);
    }
  }

  /**
   * Decodes an array. Holes arrive as holes and are left alone, so there is no
   * run-length form to validate, and so no count off the wire that could name
   * a length an array cannot hold.
   *
   * Frozen on the way out whether it was rebuilt or passed through, per what
   * {@link #decode} says a caller cedes to it.
   */
  #decodeArray(
    data: readonly RealmCodecValue[],
    context: ReconstructionContext,
    seen: Set<object> | undefined,
  ): FabricValue {
    const length = data.length;
    let result: FabricValue[] | undefined;

    for (let i = 0; i < length; i++) {
      if (!(i in data)) {
        continue;
      }

      const original = data[i]!;
      const decoded = this.decodeValue(original, context, seen);

      if (result !== undefined) {
        result[i] = decoded;
      } else if (!Object.is(decoded, original)) {
        result = new Array<FabricValue>(length);
        for (let j = 0; j < i; j++) {
          if (j in data) {
            result[j] = data[j] as FabricValue;
          }
        }
        result[i] = decoded;
      }
    }

    return Object.freeze(result ?? (data as FabricValue));
  }

  /**
   * Decodes a plain object. A `/`-prefixed key needs no attention, unlike
   * under JSON: this format reserves no key at all, its tags living in a
   * container a payload cannot produce.
   *
   * Frozen on the way out whether it was rebuilt or passed through, per what
   * {@link #decode} says a caller cedes to it.
   */
  #decodePlainObject(
    data: Record<string, RealmCodecValue>,
    context: ReconstructionContext,
    seen: Set<object> | undefined,
  ): FabricValue {
    const keys = Object.keys(data);
    let result: Record<string, FabricValue> | undefined;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;

      if (isUnsafeObjectKey(key)) {
        return this.reportReservedKey(key, data);
      }

      const original = data[key]!;
      const decoded = this.decodeValue(original, context, seen);

      if (result !== undefined) {
        result[key] = decoded;
      } else if (!Object.is(decoded, original)) {
        result = {};
        for (let j = 0; j < i; j++) {
          result[keys[j]!] = data[keys[j]!] as FabricValue;
        }
        result[key] = decoded;
      }
    }

    return Object.freeze(result ?? (data as FabricValue));
  }

  /**
   * Unwraps a tagged wire representation. Returns `{ tag, state }`, or `null`
   * if `data` is not one. The `state` is extracted directly from `data`.
   *
   * Slot zero decides, and only by identity: an array of the right length
   * whose first element is some *other* object -- or an equal-looking marker
   * some payload built for itself -- is a payload's own array and is walked as
   * one. Nothing about the shape is evidence, which is why the comparison is
   * `===` and not a structural test.
   *
   * With no marker in hand there is nothing to compare against, so nothing is
   * a tagged form. Stated rather than left to `===`: `undefined` is a value
   * this format carries directly, so a payload can put one in slot zero for
   * free, and identity against an absent marker would match it. The walk
   * reaches here only from `decode()`, which always has one, and this is the
   * counterpart to `wrapTag()` refusing to build a tagged form without one.
   *
   * The tag is handed over as it was found, of whatever type.
   * {@link RealmTaggedValue} says a tag is a `string`, but that describes what
   * this format _emits_, and decoding is where data from somewhere else
   * arrives. Whether what sits there is a tag belongs to `decodeTagged()`,
   * which asks it the same way for every format and settles the answer against
   * `lenient`.
   */
  #unwrapTag(
    data: RealmCodecValue,
  ): { tag: any; state: RealmCodecValue } | null {
    if (
      (this.#marker === undefined) || !Array.isArray(data) ||
      (data.length !== 3) || (data[0] !== this.#marker)
    ) {
      return null;
    }

    return { tag: data[1], state: data[2] as RealmCodecValue };
  }
}
