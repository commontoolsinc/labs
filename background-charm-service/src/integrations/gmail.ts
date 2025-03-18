import { Charm } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import {
  CELL_CAUSE,
  getGmailIntegrationCharmsCell,
  initializeGmailIntegrationCharmsCell,
  SYSTEM_SPACE_ID,
} from "@commontools/utils";
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
  private async fetchGmailIntegrationCharms(): Promise<
    { space: DID; charmId: string }[]
  > {
    const charms = await getGmailIntegrationCharmsCell();
    return charms.get().map((entry) => ({
      space: entry.space as DID,
      charmId: entry.charmId,
    }));
  }

  /**
   * Get the integration cell configuration
   */
  getIntegrationConfig(): IntegrationCellConfig {
    return {
      id: this.id,
      name: this.name,
      spaceId: SYSTEM_SPACE_ID,
      cellCauseName: CELL_CAUSE,
      fetchCharms: () => this.fetchGmailIntegrationCharms(),
    };
  }
}

// Export the integration instance
export default new GmailIntegration();
