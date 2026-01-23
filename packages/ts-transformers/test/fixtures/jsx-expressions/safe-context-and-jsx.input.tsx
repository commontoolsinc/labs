/// <cts-enable />
// deno-lint-ignore-file no-unused-vars
import { handler, computed } from "commontools";

// Test: && with JSX inside handler callback should transform to when()
const MyHandler = handler<Event, { show: boolean }>((_event, { show }) => {
  return <div>{computed(() => show) && <span>Content</span>}</div>;
});

// Test: || with JSX inside handler callback should transform to unless()
const MyHandler2 = handler<Event, { value: string | null }>((_event, { value }) => {
  return <div>{computed(() => value) || <span>Fallback</span>}</div>;
});
