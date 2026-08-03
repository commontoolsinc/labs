import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface RolloutInput {
  count: Writable<number | Default<0>>;
}

export interface RolloutOutput {
  count: Writable<number>;
  doubled: number;
}

const increment = handler<unknown, { count: Writable<number> }>(
  (_event, { count }) => count.set(count.get() + 1),
);

export default pattern<RolloutInput, RolloutOutput>(({ count }) => {
  const doubled = computed(() => count.get() * 2);
  return {
    [NAME]: "Server-primary rollout fixture",
    [UI]: (
      <div>
        <cf-button id="rollout-increment" onClick={increment({ count })}>
          Increment
        </cf-button>
        <div id="rollout-count">count:{count}</div>
        <div id="rollout-doubled">doubled:{doubled}</div>
      </div>
    ),
    count,
    doubled,
  };
});
