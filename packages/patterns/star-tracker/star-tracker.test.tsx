/// <cts-enable />
/**
 * Test Pattern: Star Tracker
 *
 * Tests the repo management functionality:
 * - Initial state (empty repos list)
 * - Adding repos via addText + addRepos action
 * - Duplicate detection
 * - Removing repos
 * - Parsing various repo formats (owner/repo, github.com URLs)
 *
 * Note: fetchData (GitHub API) is not tested here since it requires network.
 *
 * Run: deno task ct test packages/patterns/star-tracker/star-tracker.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import StarTracker from "./star-tracker.tsx";

export default pattern(() => {
  const tracker = StarTracker({ repos: [], githubToken: "" });

  // === Actions ===

  const action_add_one_repo = action(() => {
    tracker.addRepos.send("facebook/react");
  });

  const action_add_multiple = action(() => {
    tracker.addRepos.send("vuejs/vue\nsveltejs/svelte");
  });

  const action_add_duplicate = action(() => {
    tracker.addRepos.send("facebook/react");
  });

  const action_add_via_url = action(() => {
    tracker.addRepos.send("github.com/denoland/deno");
  });

  // Remove a repo
  const action_remove_react = action(() => {
    tracker.removeRepo.send({ owner: "facebook", repo: "react" });
  });

  // Remove another repo
  const action_remove_vue = action(() => {
    tracker.removeRepo.send({ owner: "vuejs", repo: "vue" });
  });

  // === Assertions ===

  const assert_initial_empty = computed(() => {
    const repos = tracker.repos;
    return Array.isArray(repos) && repos.length === 0;
  });

  const assert_has_one_repo = computed(() => {
    const repos = tracker.repos;
    if (!Array.isArray(repos) || repos.length !== 1) return false;
    const r = repos[0];
    return r && r.owner === "facebook" && r.repo === "react";
  });

  const assert_has_three_repos = computed(() => {
    const repos = tracker.repos;
    return Array.isArray(repos) &&
      repos.filter((r) => r && r.owner).length === 3;
  });

  const assert_still_three_after_dup = computed(() => {
    const repos = tracker.repos;
    return Array.isArray(repos) &&
      repos.filter((r) => r && r.owner).length === 3;
  });

  const assert_has_four_repos = computed(() => {
    const repos = tracker.repos;
    return Array.isArray(repos) &&
      repos.filter((r) => r && r.owner).length === 4;
  });

  const assert_deno_present = computed(() => {
    const repos = tracker.repos;
    if (!Array.isArray(repos)) return false;
    return repos.some((r) => r && r.owner === "denoland" && r.repo === "deno");
  });

  const assert_react_removed = computed(() => {
    const repos = tracker.repos;
    if (!Array.isArray(repos)) return false;
    return !repos.some(
      (r) => r && r.owner === "facebook" && r.repo === "react",
    );
  });

  const assert_three_after_remove = computed(() => {
    const repos = tracker.repos;
    return Array.isArray(repos) &&
      repos.filter((r) => r && r.owner).length === 3;
  });

  const assert_two_after_remove_vue = computed(() => {
    const repos = tracker.repos;
    return Array.isArray(repos) &&
      repos.filter((r) => r && r.owner).length === 2;
  });

  // === Test Sequence ===
  return {
    tests: [
      // Initial state
      { assertion: assert_initial_empty },

      // Add one repo
      { action: action_add_one_repo },
      { assertion: assert_has_one_repo },

      // Add multiple repos
      { action: action_add_multiple },
      { assertion: assert_has_three_repos },

      // Duplicate detection
      { action: action_add_duplicate },
      { assertion: assert_still_three_after_dup },

      // Add via URL format
      { action: action_add_via_url },
      { assertion: assert_has_four_repos },
      { assertion: assert_deno_present },

      // Remove repos
      { action: action_remove_react },
      { assertion: assert_react_removed },
      { assertion: assert_three_after_remove },

      { action: action_remove_vue },
      { assertion: assert_two_after_remove_vue },
    ],
    tracker,
  };
});
