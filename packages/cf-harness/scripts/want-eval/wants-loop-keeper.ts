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

/**
 * The signals that end a run, each with the status it exits with: 128 and
 * the signal's number, as a shell reports a process the signal killed.
 */
export const EXIT_SIGNALS: readonly (readonly [Deno.Signal, number])[] = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
];

/**
 * Archives the marker on any of `EXIT_SIGNALS` before exiting with its
 * status. A run a signal ends does not unwind to its `finally`, so each
 * handler awaits the same cleanup the loop does: one already under way is
 * waited on, and a filing in flight is archived once it returns. An archive
 * that fails is reported through `report`, and the run exits all the same.
 */
export const archiveOnExitSignals = (
  cleanup: () => Promise<void>,
  listen: (signal: Deno.Signal, handler: () => void) => void,
  exit: (code: number) => void,
  report: (message: string) => void,
): void => {
  for (const [signal, code] of EXIT_SIGNALS) {
    listen(signal, () => {
      cleanup().catch((error) =>
        report(
          `archiving the marker failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      ).finally(() => exit(code));
    });
  }
};
