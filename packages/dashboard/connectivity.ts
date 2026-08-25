/**
 * Records whether this dashboard process has received a response from a public
 * host. Production checks wait for that evidence before interpreting their own
 * failures as outages.
 */

let confirmed = false;

/** Records that the dashboard has received a response from a public host. */
export function confirmDashboardConnectivity(): void {
  confirmed = true;
}

/** Returns whether this process has confirmed public connectivity. */
export function dashboardConnectivityConfirmed(): boolean {
  return confirmed;
}

/** Sets the connectivity state for a test and returns its restorer. */
export function setDashboardConnectivityForTest(value: boolean): () => void {
  const previous = confirmed;
  confirmed = value;
  return () => {
    confirmed = previous;
  };
}
