/**
 * Keeping one marker want for the length of its phases, and archiving it on
 * whichever way out comes first: the loop's own path, its `finally`, or an
 * interrupt. `wants-loop.ts` hands it the filing and archiving it does
 * through the service.
 */

/** One marker want's filing and its one cleanup. */
export interface MarkerKeeper {
  /** Files the marker and returns its want id. Called once. */
  file(): Promise<string>;

  /**
   * Archives the marker, once, however many callers ask: every call returns
   * the same promise. A filing still in flight is waited on and what it
   * filed is archived. The want counts as kept until its archive succeeds.
   */
  cleanup(): Promise<void>;

  /** The want filed and not yet archived, if there is one. */
  kept(): string | undefined;
}

/**
 * A keeper over `fileWant`, which files the marker and returns its id, and
 * `archiveWant`, which archives a filed want.
 */
export const markerKeeper = (
  fileWant: () => Promise<string>,
  archiveWant: (id: string) => Promise<void>,
): MarkerKeeper => {
  let filing: Promise<string> | undefined;
  let kept: string | undefined;
  let cleaning: Promise<void> | undefined;
  return {
    file() {
      if (filing !== undefined) throw new Error("the marker is filed once");
      if (cleaning !== undefined) {
        throw new Error("the marker is not filed after its cleanup began");
      }
      filing = fileWant().then((id) => {
        kept = id;
        return id;
      });
      return filing;
    },
    cleanup() {
      cleaning ??= (async () => {
        if (filing !== undefined) {
          // A filing that failed kept nothing; its own caller reports why.
          await filing.catch(() => undefined);
        }
        if (kept === undefined) return;
        await archiveWant(kept);
        kept = undefined;
      })();
      return cleaning;
    },
    kept: () => kept,
  };
};
