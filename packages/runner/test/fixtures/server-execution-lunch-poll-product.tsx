import { computed, Default, pattern, type PerSpace } from "commonfabric";

interface LunchPollProjectionInput {
  voteCount?: PerSpace<number | Default<0>>;
}

// Product-shaped data projection used by the shared-execution rollout test.
// The full lunch poll exposes `voteCount`, but its entity-backed Vote[]
// traversal is intentionally outside the v1 static server scope. Demand the
// product-derived scalar so this fixture isolates shared attempt ownership.
export default pattern<LunchPollProjectionInput, number>(
  ({ voteCount }) => computed(() => voteCount ?? 0),
);
