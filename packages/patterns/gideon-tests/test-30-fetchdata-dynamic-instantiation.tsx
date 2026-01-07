/// <cts-enable />
/**
 * Test Pattern for Superstition #30
 *
 * Tests whether fetchData() can be dynamically instantiated inside .map()
 *
 * Claim:
 * - fetchData() calls cannot be created dynamically inside .map() or reactive callbacks
 * - Framework requires fetchData to be statically defined at pattern evaluation time
 * - Dynamic instantiation causes "Frame mismatch" errors or undefined results
 *
 * This pattern tests:
 * 1. Static fetchData at top level (control - should work)
 * 2. fetchData inside .map() with expression callback (claimed to fail)
 */
import { computed, Default, NAME, pattern, UI } from "commontools";
import { fetchData } from "commontools";

interface Repo {
  id: string;
  name: string;
}

interface InputSchema {
  repos: Default<Repo[], [
    { id: "1"; name: "react" },
    { id: "2"; name: "vue" },
    { id: "3"; name: "angular" },
  ]>;
}

interface Input {
  repos: Repo[];
}

export default pattern<InputSchema, Input>(({ repos }) => {
  // Approach 1: Static fetchData at top level (control - should work)
  // Uses computed URL that changes based on first repo
  const staticUrl = computed(() =>
    repos[0] ? `https://api.github.com/repos/facebook/${repos[0].name}` : ""
  );
  const staticFetch = fetchData({ url: staticUrl, mode: "json" });

  // Approach 2: fetchData inside .map() - expression callback (no block syntax)
  // This is claimed to fail with frame mismatch or return undefined
  const dynamicFetches = repos.map((repo) =>
    fetchData({
      url: computed(() => `https://api.github.com/repos/facebook/${repo.name}`),
      mode: "json",
    })
  );

  // Display results
  const staticResult = computed(() =>
    staticFetch.pending
      ? "Loading..."
      : staticFetch.error
      ? `Error: ${staticFetch.error}`
      : staticFetch.result
      ? `Stars: ${
        (staticFetch.result as { stargazers_count?: number })
          .stargazers_count ?? "N/A"
      }`
      : "No data"
  );

  return {
    [NAME]: "Test #30: fetchData Dynamic Instantiation",
    [UI]: (
      <div
        style={{ fontFamily: "system-ui", padding: "20px", maxWidth: "800px" }}
      >
        <h2>Superstition #30 Test: fetchData Dynamic Instantiation</h2>

        <div
          style={{
            backgroundColor: "#f0f0f0",
            padding: "15px",
            borderRadius: "8px",
            marginBottom: "20px",
          }}
        >
          <h3>Claim Being Tested:</h3>
          <ul>
            <li>
              <code>fetchData()</code> cannot be created inside{" "}
              <code>.map()</code>
            </li>
            <li>
              Framework requires static allocation at pattern body top level
            </li>
            <li>
              Dynamic instantiation causes frame mismatch or undefined results
            </li>
          </ul>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {/* Static fetchData (Control) */}
          <div
            style={{
              border: "2px solid #27ae60",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#27ae60" }}>1. Static fetchData (Control)</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              fetchData at top level with computed URL
            </code>
            <div style={{ marginBottom: "10px" }}>
              <strong>URL:</strong> {staticUrl}
            </div>
            <div style={{ marginBottom: "10px" }}>
              <strong>Result:</strong> {staticResult}
            </div>
            <div style={{ fontSize: "12px", color: "#666" }}>
              <strong>Pending:</strong>{" "}
              {computed(() => String(staticFetch.pending))}
            </div>
          </div>

          {/* Dynamic fetchData */}
          <div
            style={{
              border: "2px solid #e74c3c",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#e74c3c" }}>2. Dynamic fetchData (Test)</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              fetchData inside .map() callback
            </code>
            <div>
              {dynamicFetches.map((fetch, index) => (
                <div
                  key={index}
                  style={{
                    marginBottom: "10px",
                    padding: "8px",
                    backgroundColor: "#f9f9f9",
                    borderRadius: "4px",
                  }}
                >
                  <strong>Repo {index + 1}:</strong>
                  <div style={{ fontSize: "12px" }}>
                    Pending: {computed(() => String(fetch.pending))}
                    {" | "}
                    Error:{" "}
                    {computed(() => fetch.error ? String(fetch.error) : "none")}
                    {" | "}
                    Result: {computed(() =>
                      fetch.result
                        ? `Stars: ${
                          (fetch.result as { stargazers_count?: number })
                            .stargazers_count ?? "N/A"
                        }`
                        : "No data"
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{
            backgroundColor: "#fff3cd",
            padding: "15px",
            borderRadius: "8px",
            border: "1px solid #ffc107",
          }}
        >
          <h3>Expected Behavior (if superstition is TRUE):</h3>
          <ul>
            <li>
              <strong style={{ color: "#27ae60" }}>Static:</strong>{" "}
              Should work - shows star count
            </li>
            <li>
              <strong style={{ color: "#e74c3c" }}>Dynamic:</strong>{" "}
              Should FAIL - undefined, error, or frame mismatch
            </li>
          </ul>
          <p>
            <strong>If superstition is FALSE:</strong>{" "}
            Both should show star counts.
          </p>
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "15px",
            backgroundColor: "#f8f9fa",
            borderRadius: "8px",
          }}
        >
          <h3>Test Repos:</h3>
          <ul>
            {repos.map((repo, index) => (
              <li key={index}>{repo.name} (id: {repo.id})</li>
            ))}
          </ul>
        </div>
      </div>
    ),
    repos,
  };
});
