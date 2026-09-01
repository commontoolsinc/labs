/**
 * The deployment a process is connected to, held so that a connection to a
 * second one fails by name instead of silently taking the first one's place.
 *
 * Opening a connection writes settings that belong to the deployment into
 * state that belongs to the process: the endpoint an LLM call reaches, the
 * base URL a pattern's relative `fetch` resolves against, and the ambient
 * experimental flags a runtime applies. None of it is scoped to the
 * connection that wrote it, so a connection to a different deployment
 * rewrites all of it while the first connection carries on — against the
 * second deployment's settings, and reporting nothing.
 *
 * One deployment per process is the limit taken in place of scoping those
 * globals per connection, and this is where it is enforced.
 * `docs/plans/shuttle/runtime-integration.md` records what the limit costs a
 * long-lived process that holds a connection, and where the scoping work
 * belongs when a caller needs more than one.
 */

/**
 * The deployment claimed, normalized for comparison, or `null` while this
 * process has claimed none.
 */
let claimed: string | null = null;

/**
 * Helper for {@link claimProcessDeployment}, which normalizes `apiUrl` for
 * comparison, returning it as written when it does not parse — an unusable
 * API URL is the connection's error to raise rather than this one's.
 */
function deploymentKey(apiUrl: string): string {
  try {
    return new URL(apiUrl).href;
  } catch {
    return apiUrl;
  }
}

/**
 * Claims the deployment at `apiUrl` as this process's, and throws when a
 * different one is already claimed. Claiming the deployment already held is
 * what every connection after the first does, and passes.
 *
 * A claim stands whether or not the connection it was made for opens: a
 * connection that fails on the way up has written those settings already.
 *
 * What it catches is a second deployment, not a second connection: two
 * connections to one deployment write the same settings and go unremarked,
 * as does everything else one process's connections share.
 */
export function claimProcessDeployment(apiUrl: string): void {
  const key = deploymentKey(apiUrl);
  if (claimed === null) {
    claimed = key;
    return;
  }
  if (claimed === key) return;
  throw new Error(
    `This process is connected to \`${claimed}\`, so a connection to ` +
      `\`${key}\` is refused: the settings a connection writes are the ` +
      `process's rather than the connection's, which is one deployment ` +
      `per process.`,
  );
}

/** Forgets the claimed deployment. For tests that drive several claims. */
export function resetProcessDeployment(): void {
  claimed = null;
}
