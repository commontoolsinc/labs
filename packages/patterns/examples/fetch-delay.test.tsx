// Pattern-test for the CT-1768 fetch-mock `delayMs` (Robin/ubik2's suggestion):
// a mock can return after a fixed real-time delay, so a fetchJson isn't resolved
// instantly. `runtime.settled()` (driven by `{ settle: true }`) still awaits the
// delayed fetch, so the result is observed deterministically once it lands.
import { computed, fetchJson, pattern, resultOf } from "commonfabric";

export const fetchMocks = [
  {
    urlIncludes: "/api/slow",
    contentType: "application/json",
    body: '{"v":7}',
    delayMs: 50,
  },
];

export default pattern(() => {
  const url = computed(() => "https://example.test/api/slow");
  const fetched = fetchJson<{ v: number }>({ url });
  const result = resultOf(fetched);
  const result_is_7 = computed(() => result.v === 7);
  return {
    tests: [
      { settle: true }, // awaits the delayed fetch to completion
      { assertion: result_is_7 },
    ],
    fetched,
  };
});
