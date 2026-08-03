import { computed, Default, pattern, type PerSpace } from "commonfabric";

interface LunchPollDerivedScalarInput {
  voteCount?: PerSpace<number | Default<0>>;
}

// This intentionally is not the full literal lunch-poll product. It isolates
// the directly demanded vote-count projection that lunch-poll exposes so the
// rollout test can prove shared server authority independently of entity-backed
// traversal. The full product's transform and firewall remain covered by the
// literal product-fixture test.
export default pattern<LunchPollDerivedScalarInput, number>(
  ({ voteCount }) => computed(() => voteCount ?? 0),
);
