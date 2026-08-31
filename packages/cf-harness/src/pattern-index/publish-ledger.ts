import type {
  HarnessPatternIndexClientFactory,
  PatternIndexPublishRequest,
} from "./client.ts";
import { PATTERN_DISCOVERABILITY_REASONS } from "./publish-render-gate.ts";

/**
 * One session's contributions to the pattern index, retaining one candidate
 * per capability rather than publishing every iteration as a candidate.
 *
 * ## The problem this exists for
 *
 * A pattern-author that iterates runs the same capability three or four times
 * before it is happy. Each successful run published, and since the source
 * differs slightly between iterations each is a different content-addressed
 * identity, so none deduplicates against the others. About a third of the
 * index is that: near-duplicates produced by iteration rather than by use,
 * several of which occupy consecutive slots in one search and crowd
 * everything else out of it.
 *
 * ## What it does instead
 *
 * Every iteration is still RECORDED — nothing an authoring session produced
 * is lost, and `getPattern` and `cf:pattern:` answer for all of it. The
 * request decides whether the retained candidate is discoverable; ordinary
 * authored runs record it, while curated seeding requests discoverability.
 *
 * A staged request is held. Staging the same capability again publishes the
 * one being displaced immediately, as `discoverable: false`, and holds the
 * new one. What is still held when the session ends is published with the
 * discoverability the caller requested. So a session that authored a
 * capability four times leaves four records and at most one search result.
 *
 * A staged request naming a held entry among its `dependencies` publishes
 * that dependency first, with its requested discoverability, since it is not
 * being superseded — the index refuses a publication whose dependency it does
 * not hold, so a
 * session composing an atom it authored earlier needs that atom in the index
 * before the composite arrives. An entry published that way becomes the
 * `priorPatternId` of the next iteration staged under the same capability,
 * which is the one case where two entries from one session both reach the
 * index through the front door.
 *
 * ## What this costs, stated rather than discovered
 *
 * **A session that dies before its flush loses the latest iteration of each
 * capability it was still holding** — one entry per capability, not the
 * session's whole output, since every superseded iteration was already sent
 * when it was displaced. A publication that fails at the index is logged and
 * does not bear on the run.
 *
 * **Two different capabilities described in identical words collapse**, the
 * later one taking the retained slot and the earlier being recorded. The
 * key is the model's own description and hashtags, which is also what the
 * index ranks a search against — so two entries this key cannot tell apart
 * are two entries a search cannot tell apart either.
 */
export interface PatternIndexPublicationLedger {
  /**
   * Holds `request` as this session's offer for its capability, publishing
   * anything it displaces as non-discoverable. Never throws and never awaits:
   * a contribution to a shared catalog does not bear on the run that made it.
   */
  stage(request: PatternIndexPublishRequest): void;

  /**
   * Publishes everything still held, ordered so that a held entry another
   * held entry names among its `dependencies` goes first. A request whose
   * turn never comes is still published, after everything that could be
   * ordered — nothing here produces a cycle, since a dependency is the
   * content-addressed identity of something that already compiled, but the
   * ordering does not assume it.
   */
  flush(): Promise<void>;
}

/**
 * What counts as one capability: the description and hashtags the model gave,
 * normalized for case and whitespace, with hashtags order-independent.
 */
export const patternCapabilityKey = (
  request: PatternIndexPublishRequest,
): string =>
  JSON.stringify([
    request.description.trim().toLowerCase().replace(/\s+/g, " "),
    [...request.hashtags]
      .map((hashtag) => hashtag.trim().toLowerCase())
      .sort(),
  ]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createPatternIndexPublicationLedger = (
  getClient: HarnessPatternIndexClientFactory,
  options: { onError?: (message: string) => void } = {},
): PatternIndexPublicationLedger => {
  const onError = options.onError ??
    ((message: string) => console.error(message));
  const held = new Map<string, PatternIndexPublishRequest>();
  const publishedByKey = new Map<string, string>();
  // Publications are serialized behind one chain so a dependency staged
  // before its dependent is also SENT before it, without any caller awaiting
  // a publish.
  let chain: Promise<void> = Promise.resolve();

  const send = (
    key: string,
    request: PatternIndexPublishRequest,
    supersede: boolean,
  ): void => {
    publishedByKey.set(key, request.patternId);
    // A render-gate reason is more informative than displacement and stays on
    // a superseded entry. The generic automatic-recording reason is replaced:
    // supersession specifically explains why an earlier iteration is not the
    // retained candidate.
    const automaticReason =
      PATTERN_DISCOVERABILITY_REASONS["recorded-automatically"];
    const body = supersede
      ? {
        ...request,
        nonDiscoverable: request.nonDiscoverable?.reason === automaticReason
          ? { reason: PATTERN_DISCOVERABILITY_REASONS.superseded }
          : request.nonDiscoverable ??
            { reason: PATTERN_DISCOVERABILITY_REASONS.superseded },
      }
      : request;
    chain = chain.then(async () => {
      try {
        const client = await getClient();
        const response = await client.publishPattern(body);
        if (response.created) {
          await client.recordEvent({
            patternId: response.patternId,
            eventType: "created",
          });
        }
      } catch (error) {
        onError(
          `run_pattern could not publish the pattern it ran to the pattern index: ${
            errorMessage(error)
          }`,
        );
      }
    });
  };

  return {
    stage(request) {
      const dependencies = new Set(request.dependencies ?? []);
      if (dependencies.size > 0) {
        for (const [key, pending] of [...held]) {
          if (dependencies.has(pending.patternId)) {
            held.delete(key);
            // Not superseded: something depends on it, so it is a part of
            // this session's output in its own right.
            send(key, pending, false);
          }
        }
      }
      const key = patternCapabilityKey(request);
      const displaced = held.get(key);
      if (displaced !== undefined) {
        held.delete(key);
        send(key, displaced, true);
      }
      const prior = publishedByKey.get(key);
      held.set(
        key,
        prior === undefined || prior === request.patternId
          ? request
          : { ...request, priorPatternId: prior },
      );
    },
    async flush() {
      // Dependency order, not staging order. Staging order happens to be
      // right whenever a dependency was authored before the entry composing
      // it — which a `cf:pattern:` import needing to resolve at compile time
      // forces — but the index rejects a publication whose dependency it does
      // not hold, so the ordering is made rather than relied upon.
      //
      // A pass rather than a loop-until-no-progress: `stage()` already sends
      // any held entry a later request names among its dependencies, so no
      // two held entries can name each other and the ordering has no residue
      // case to fall back on. Counting each entry's held dependencies and
      // sending in that order cannot leave anything unsent, which is a
      // property of the shape rather than a claim about the input.
      const pending = [...held];
      held.clear();
      const heldIds = new Set(pending.map(([, request]) => request.patternId));
      const depth = ([, request]: [string, PatternIndexPublishRequest]) =>
        (request.dependencies ?? []).filter((id) => heldIds.has(id)).length;
      for (
        const [key, request] of pending.sort((a, b) => depth(a) - depth(b))
      ) {
        send(key, request, false);
      }
      await chain;
    },
  };
};
