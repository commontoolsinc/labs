import { Charm } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import { getGmailIntegrationCharms, initializeGmailIntegrationCharmsCell } from "@commontools/utils";
import { Integration, IntegrationCellConfig } from "../types.ts";
import { log } from "../utils.ts";

/**
 * Gmail integration for the Background Charm Service
 */
export class GmailIntegration implements Integration {
  id = "gmail";
  name = "Gmail Integration";

  /**
   * Initialize the Gmail integration
   */
  async initialize(): Promise<void> {
    await initializeGmailIntegrationCharmsCell();
    log("Initialized Gmail integration charms cell with empty array");
  }

  /**
   * Fetch Gmail integration charms
   */
  private async fetchGmailIntegrationCharms(): Promise<{ space: DID; charmId: string }[]> {
    const charms = await getGmailIntegrationCharms();
    return charms.map((entry) => ({
      space: entry.space as DID,
      charmId: entry.charmId,
    }));
  }

  /**
   * Validate a Gmail integration charm
   */
  private isValidGmailCharm(charm: Cell<Charm>): boolean {
    const googleUpdater = charm.key("googleUpdater");
    const auth = charm.key("auth");
    return !!(googleUpdater && auth);
  }

  /**
   * Get the integration cell configuration
   */
  getIntegrationConfig(): IntegrationCellConfig {
    return {
      id: this.id,
      name: this.name,
      spaceId: "system",
      cellId: "gmail-integration-charms",
      fetchCharms: () => this.fetchGmailIntegrationCharms(),
      isValidIntegrationCharm: (charm) => this.isValidGmailCharm(charm),
    };
  }
}

// Export the integration instance
export default new GmailIntegration();