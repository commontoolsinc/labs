/// <cts-enable />
/**
 * CT-1341 minimal repro: fetchData cells trigger "Invalid fact.value with no value"
 *
 * Deploy:
 *   deno task ct piece new repro-ct-1341.tsx -i <key> -a http://localhost:8000 -s repro-1341
 *
 * Open in browser, then check the toolshed console for:
 *   Error: Invalid fact.value with no value
 *
 * Root cause: fetchData (and fetchProgram, streamData) call setSourceCell()
 * on freshly created cells without writing an initial value first.
 * This produces facts like { source: { "/": "..." } } with no "value" key.
 * PR #3039's stricter validation in loadFactsForDoc throws on these.
 *
 * Compare with map/filter/flatmap builtins which call result.send([])
 * before setSourceCell(), ensuring the fact always has a value.
 */
import { pattern, fetchData, NAME, UI } from "commontools";

const app = pattern(({}) => {
  const data = fetchData<any>({
    url: "https://api.github.com/repos/anthropics/anthropic-sdk-python",
    mode: "json",
  });

  return {
    [NAME]: "CT-1341 Repro",
    result: data.result,
    pending: data.pending,
    error: data.error,
    [UI]: (
      <div>
        <h2>CT-1341 Repro</h2>
        <p>Check toolshed console for "Invalid fact.value with no value"</p>
        <p>Pending: {data.pending ? "true" : "false"}</p>
        <p>Error: {data.error ? String(data.error) : "none"}</p>
        <p>Result: {data.result ? "got data" : "no data"}</p>
      </div>
    ),
  };
});

export default app;
