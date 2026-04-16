/**
 * Pool of instances of some specific type, which can be `acquire()`d and
 * `release()`d, with support for recovering insstances which were never
 * `release()` before their owners got GCed.
 *
 */
export class InstancePool<T extends WeakKey> {
  /** The instance pool. */
  #pool: T[] = [];

  /** Finalization registry which repools "lost" instances. */
  #repooler = new FinalizationRegistry((instance: T) => {
    if (this.#pool.indexOf(instance) === -1) {
      this.#pool.push(instance);
    }
  });

  /**
   * Gets a freshly-initialized instance, or throws an error indicating that
   * no instance is available.
   */
  acquire(owner: WeakKey): T {
    if (!this.canAcquire()) {
      throw new Error("No instances available.");
    }

    const result = this.#pool.pop()!;
    this._initInstance(result);

    this.#repooler.register(owner, result, result);

    return result;
  }

  /**
   * Adds a new instance to the pool.
   */
  add(instance: T) {
    this.#pool.push(instance);
  }

  /**
   * Is there an instance available for acquisition?
   */
  canAcquire() {
    return this.#pool.length !== 0;
  }

  /**
   * Releases a previously-acquired instance.
   */
  release(instance: T) {
    this.#repooler.unregister(instance);
    this.#pool.push(instance);
  }

  /**
   * Performs any necessary initialization of an instance. May be overridden
   * by subclasses. Does nothing by default.
   */
  protected _initInstance(instance: T) {
    // This space intentionally left blank.
  }
}
