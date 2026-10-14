import { estimateFabricValueSize } from "@commonfabric/data-model";
import { hashSchema } from "@commonfabric/data-model-schema";
import { LRUCache } from "@commonfabric/utils/cache";

import { immutableSnapshot, isImmutableCellId } from "./immutable-cell.ts";
import type { URI } from "./sigil-types.ts";
import { addressKey, type NormalizedFullLink } from "./link-types.ts";
import { schemaRegistryEpoch } from "./schema-registry.ts";

/** What a node binding is computed from, which is what the memo keys on. */
export type NodeBindingSubject = {
  /** The node bound, by identity. */
  node: object;

  /** The pattern holding the node, by identity. */
  pattern: object;

  /**
   * Any further object the binding is computed from, by identity: the
   * pattern a pattern node's module resolved to, which a registry may
   * replace under an unchanged node.
   */
  implementation?: object;

  /** The link of the result cell the node is bound on. */
  resultLink: NormalizedFullLink;

  /** The argument link the node is bound against, when there is one. */
  argumentLink: NormalizedFullLink | undefined;

  /**
   * Whatever else decides the binding: the kind of module the node resolved
   * to, and any setting the binding reads.
   */
  variant: string;
};

/**
 * Memo of what binding a pattern's node on a result cell produces, for the
 * part of a binding that reads nothing through a transaction: the node's
 * inputs and outputs bound to the piece's argument and result documents, and
 * what derives from those alone. Such a binding is a function of its
 * {@link NodeBindingSubject}, so the one a resume pre-sync computes is the
 * one the node's instantiation needs. The pre-sync asks with
 * {@link bindingFor}, which holds the binding, and the instantiation with
 * {@link takeBindingFor}, which stops holding it: a running node keeps its
 * own bindings, so the memo holds one only between the two.
 *
 * A node and a pattern are keyed by identity, a link by the members a binding
 * reads from it: its address and its schema, the schema by content. A bound
 * link carries its schema as a reference into the schema registry, which
 * resolves only in the registry epoch that minted it, so every entry is
 * dropped when the epoch changes.
 *
 * The memo holds at most `capacity` entries, and at most `maxWeight` of key
 * length plus whatever `weigh` reports for a binding, dropping the least
 * recently used. A dropped entry costs a second computation and nothing
 * else. Every holder of a binding treats it as immutable, since the memo
 * hands the same one to each.
 */
export class NodeBindingMemo<Binding> {
  #entries: LRUCache<string, Binding>;
  #epoch = schemaRegistryEpoch();
  #subjectIds = new WeakMap<object, number>();
  #nextSubjectId = 0;

  /** Constructs an instance bounded by `options`. */
  constructor(
    options: {
      capacity: number;
      maxWeight: number;
      weigh?: (binding: Binding) => number;
    },
  ) {
    const weigh = options.weigh;
    this.#entries = new LRUCache<string, Binding>({
      capacity: options.capacity,
      maxWeight: options.maxWeight,
      weigh: (key, binding) => key.length + (weigh?.(binding) ?? 0),
    });
  }

  /** Number of bindings held. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Returns the binding for `subject`: the one held, or the result of `bind`,
   * which is then held. A `bind` that throws leaves nothing held.
   */
  bindingFor(subject: NodeBindingSubject, bind: () => Binding): Binding {
    const key = this.#currentKey(subject);
    const held = this.#entries.get(key);
    if (held !== undefined) return held;
    const binding = bind();
    this.#entries.put(key, binding);
    return binding;
  }

  /**
   * Returns the binding for `subject` and holds none for it afterwards: the
   * one held, which is dropped, or the result of `bind`.
   */
  takeBindingFor(subject: NodeBindingSubject, bind: () => Binding): Binding {
    const key = this.#currentKey(subject);
    const held = this.#entries.get(key);
    if (held === undefined) return bind();
    this.#entries.delete(key);
    return held;
  }

  /** Drops every binding held. */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * Helper for the two lookups, which returns the key `subject`'s binding is
   * held under after dropping every entry of an earlier registry epoch.
   */
  #currentKey(subject: NodeBindingSubject): string {
    const epoch = schemaRegistryEpoch();
    if (epoch !== this.#epoch) {
      this.#entries.clear();
      this.#epoch = epoch;
    }
    return this.#key(subject);
  }

  /**
   * The key `subject`'s binding is held under: its members as one JSON
   * array, so that no two subjects share a key.
   */
  #key(subject: NodeBindingSubject): string {
    return JSON.stringify([
      this.#subjectId(subject.node),
      this.#subjectId(subject.pattern),
      subject.implementation === undefined
        ? null
        : this.#subjectId(subject.implementation),
      subject.variant,
      linkMembers(subject.resultLink),
      subject.argumentLink === undefined
        ? null
        : linkMembers(subject.argumentLink),
    ]);
  }

  /** The number standing for `subject` in a key, minted on first use. */
  #subjectId(subject: object): number {
    let id = this.#subjectIds.get(subject);
    if (id === undefined) {
      id = this.#nextSubjectId++;
      this.#subjectIds.set(subject, id);
    }
    return id;
  }
}

/**
 * The members of `link` a binding reads: its address, and its schema as a
 * content hash.
 */
function linkMembers(link: NormalizedFullLink): [string, string | null] {
  return [
    addressKey(link),
    link.schema === undefined ? null : hashSchema(link.schema),
  ];
}

/** The weight of an inputs document, including a native snapshot's payload. */
export function nodeBindingInputsWeight(id: URI): number {
  return isImmutableCellId(id)
    ? id.length + estimateFabricValueSize(immutableSnapshot(id).value)
    : id.length;
}
