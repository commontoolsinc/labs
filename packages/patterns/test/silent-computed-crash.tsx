/// <cts-enable />
import { computed, Default, pattern, UI } from "commonfabric";

export default pattern<{ value?: Default<string, "hello"> }>(({ value }) => {
  // This computed will fail silently (console.log in computed)
  const poisoned = computed(() => {
    console.log("debug:", value);
    // force an error thrown directly as another repro case if console.log doesn't throw
    throw new Error("I am a poisoned computed");
    // deno-lint-ignore no-unreachable
    return `got: ${value}`;
  });

  // This computed is fine
  const healthy = computed(() => `healthy: ${value}`);

  return {
    $NAME: "Silent Computed Crash Repro",
    [UI]: (
      <div
        style={{
          padding: "20px",
          fontFamily: "monospace",
          border: "1px solid red",
        }}
      >
        <h3>Silent computed crash repro</h3>
        <div>1. Direct value: {value}</div>
        <div>2. Healthy computed: {healthy}</div>
        <div>3. Poisoned computed: {poisoned}</div>
        <div>4. Static text with poisoned: PREFIX-{poisoned}-SUFFIX</div>
        <div>5. This should always render</div>
      </div>
    ),
  };
});
