import { computed, Default, pattern, type PerSpace } from "commonfabric";

interface GroupChatProjectionInput {
  roomCount?: PerSpace<number | Default<0>>;
}

// Product-shaped data projection used by the shared-execution rollout test.
// The full group-chat product computes a room-count label in UI and returns its
// entity-backed rooms directly. Demand the product-derived scalar so this
// fixture isolates shared attempt ownership from dynamic entity traversal.
export default pattern<GroupChatProjectionInput, number>(
  ({ roomCount }) => computed(() => roomCount ?? 0),
);
