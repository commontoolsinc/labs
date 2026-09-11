/**
 * Shared doubles for the `value-visit` tests: a visitor that records every
 * call it receives, and builders for the result forms a test hands back.
 *
 * The recorder dispatches every value to its subtype method and recurses into
 * containers the way `ContainerIteratingVisitor` does by default, so a test
 * that wants the default walk sets nothing, and one that wants a different
 * decision at one hook assigns the matching `on*` property.
 */

import type { Primitive } from "@commonfabric/utils/types";

import {
  type FabricArray,
  type FabricContainerValue,
  type FabricInstance,
  type FabricPlainObject,
  type FabricPrimitive,
} from "@/interface.ts";
import { type PrimitiveValueTag } from "@/value-tags.ts";
import {
  type BaselineVisitResult,
  ContainerIteratingVisitor,
  type DispatchingVisitorResult,
  DO_VISIT_SUBTYPE,
  type LeafVisitorResult,
} from "@/value-visit";

/** One recorded call into a `Recorder`. */
export type Event = [name: string, ...args: unknown[]];

/**
 * Visitor that dispatches every value to its subtype method, recurses into
 * containers the way `ContainerIteratingVisitor` does by default, and records
 * each call it receives. Each hook can be overridden per test by assigning the
 * matching `on*` property.
 */
export class Recorder extends ContainerIteratingVisitor<unknown, unknown> {
  readonly events: Event[] = [];

  /**
   * The values handed to `isDomainExtra()`, in order. Kept apart from
   * `events` so that the recorded dispatch sequence is the visit alone.
   */
  readonly domainChecks: unknown[] = [];

  onIsDomainExtra?: (value: unknown) => boolean;
  onValue?: (value: unknown) => DispatchingVisitorResult<unknown, unknown>;
  onCycle?: (
    value: unknown,
    originalDepth: number,
    thisDepth: number,
  ) => LeafVisitorResult<unknown, unknown>;
  onArray?: (value: FabricArray) => LeafVisitorResult<unknown, unknown>;
  onPlainObject?: (
    value: FabricPlainObject,
  ) => LeafVisitorResult<unknown, unknown>;
  onInstance?: (value: FabricInstance) => LeafVisitorResult<unknown, unknown>;
  onPrimitive?: (
    value: unknown,
    tag: PrimitiveValueTag,
  ) => LeafVisitorResult<unknown, unknown>;
  onNonFabric?: (value: unknown) => LeafVisitorResult<unknown, unknown>;
  onVisitedElement?: (
    index: number,
    value: unknown,
  ) => BaselineVisitResult<unknown>;
  onVisitedGap?: (start: number, count: number) => BaselineVisitResult<unknown>;
  onVisitedMapping?: (
    key: unknown,
    value: unknown,
  ) => BaselineVisitResult<unknown>;

  /** The names of the recorded calls, in order. */
  get names(): string[] {
    return this.events.map((e) => e[0]);
  }

  override isDomainExtra(value: unknown): value is unknown {
    // The domain is `unknown`, so everything outside `FabricValue` is in it.
    this.domainChecks.push(value);
    return this.onIsDomainExtra ? this.onIsDomainExtra(value) : true;
  }

  override visitValue(
    value: unknown,
  ): DispatchingVisitorResult<unknown, unknown> {
    this.events.push(["value", value]);
    return this.onValue ? this.onValue(value) : DO_VISIT_SUBTYPE;
  }

  override visitCycle(
    value: unknown,
    originalDepth: number,
    thisDepth: number,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["cycle", value, originalDepth, thisDepth]);
    return this.onCycle
      ? this.onCycle(value, originalDepth, thisDepth)
      : undefined;
  }

  override visitFabricContainer(
    value: FabricContainerValue,
  ): DispatchingVisitorResult<unknown, unknown> {
    this.events.push(["container", value]);
    return DO_VISIT_SUBTYPE;
  }

  override visitFabricArray(
    value: FabricArray,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["array", value]);
    return this.onArray ? this.onArray(value) : super.visitFabricArray(value);
  }

  override visitFabricPlainObject(
    value: FabricPlainObject,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["object", value]);
    return this.onPlainObject
      ? this.onPlainObject(value)
      : super.visitFabricPlainObject(value);
  }

  override visitFabricInstance(
    value: FabricInstance,
  ): LeafVisitorResult<unknown, unknown> {
    // Unlike the other container hooks, this one does not defer to the
    // superclass by default: the engine cannot yet iterate an instance, so
    // the default here is to stop.
    this.events.push(["instance", value]);
    return this.onInstance ? this.onInstance(value) : undefined;
  }

  override visitPrimitive(
    value: Primitive | FabricPrimitive,
    tag: PrimitiveValueTag,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["primitive", value, tag]);
    return this.onPrimitive ? this.onPrimitive(value, tag) : undefined;
  }

  override visitNonFabricValue(
    value: unknown,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["nonFabric", value]);
    return this.onNonFabric ? this.onNonFabric(value) : undefined;
  }

  override visitedArrayElement(
    array: FabricArray,
    index: number,
    value: unknown,
  ): BaselineVisitResult<unknown> {
    this.events.push(["visitedElement", array, index, value]);
    return this.onVisitedElement
      ? this.onVisitedElement(index, value)
      : undefined;
  }

  override visitedArrayGap(
    array: FabricArray,
    start: number,
    count: number,
  ): BaselineVisitResult<unknown> {
    this.events.push(["visitedGap", array, start, count]);
    return this.onVisitedGap ? this.onVisitedGap(start, count) : undefined;
  }

  override visitedMapping(
    container: FabricPlainObject | FabricInstance,
    key: unknown,
    value: unknown,
  ): BaselineVisitResult<unknown> {
    this.events.push(["visitedMapping", container, key, value]);
    return this.onVisitedMapping
      ? this.onVisitedMapping(key, value)
      : undefined;
  }
}

/** Returns a `mainResult` form carrying the given value. */
export function mainResult<T>(value: T): { type: "mainResult"; value: T } {
  return { type: "mainResult", value };
}

/** Returns a `replace` form carrying the given value. */
export function replace<T>(value: T): { type: "replace"; value: T } {
  return { type: "replace", value };
}

/** Returns a plain-object chain of the given depth ending in `leaf`. */
export function chain(depth: number, leaf: unknown): unknown {
  let result = leaf;
  for (let i = 0; i < depth; i++) {
    result = { child: result };
  }
  return result;
}
