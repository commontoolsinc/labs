import { refer, SchemaPathSelector } from "@commontools/memory";
import { MapSet } from "@commontools/builder/traverse";

// This class helps us maintain a client model of our server side subscriptions
export class SelectorTracker<K> {
  private refTracker = new MapSet<string, string>();
  private selectors = new Map<string, SchemaPathSelector>();

  constructor(protected toKey: (doc: K) => string) {
  }

  add(doc: K, selector: SchemaPathSelector | undefined) {
    if (selector === undefined) {
      return;
    }
    const selectorRef = refer(JSON.stringify(selector)).toString();
    this.refTracker.add(this.toKey(doc), selectorRef);
    this.selectors.set(selectorRef, selector);
  }

  has(doc: K): boolean {
    return this.refTracker.has(this.toKey(doc));
  }

  hasSelector(doc: K, selector: SchemaPathSelector): boolean {
    const selectorRefs = this.refTracker.get(this.toKey(doc));
    if (selectorRefs !== undefined) {
      const selectorRef = refer(JSON.stringify(selector)).toString();
      return selectorRefs.has(selectorRef);
    }
    return false;
  }

  get(doc: K): IteratorObject<SchemaPathSelector> {
    const selectorRefs = this.refTracker.get(this.toKey(doc)) ?? [];
    return selectorRefs.values().map((selectorRef) =>
      this.selectors.get(selectorRef)!
    );
  }
}
