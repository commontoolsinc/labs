import { Charm } from "@commontools/charm";
import { Cell, getCell, storage } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import { Integration, IntegrationCellConfig } from "../types.ts";
import { log } from "../utils.ts";
import { Identity } from "@commontools/identity";
import { env } from "../config.ts";
export const SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";
export const CELL_CAUSE = "discord-integration-2025-03-18";

export const discordIntegrationCharmsSchema = {
  type: "object" as const,
  properties: {
    charms: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          space: { type: "string" as const },
          charmId: { type: "string" as const },
        },
        required: ["space", "charmId"],
      },
      default: [],
    },
  },
  required: ["charms"],
};
/**
 * Discord integration for the Background Charm Service
 */

// Define the schema type for reuse
interface DiscordIntegrationSchema {
  charms: Array<{
    space: string;
    charmId: string;
  }>;
}

export class DiscordIntegration implements Integration {
  id = "discord";
  name = "Discord Integration";

  async getDiscordIntegrationCell(): Promise<Cell<DiscordIntegrationSchema>> {
    const signer = await Identity.fromPassphrase(env.OPERATOR_PASS);
    storage.setSigner(signer);

    const charmsCell = getCell<DiscordIntegrationSchema>(
      SYSTEM_SPACE_ID,
      CELL_CAUSE,
      discordIntegrationCharmsSchema,
    );

    storage.syncCell(charmsCell, true);
    await storage.synced();

    return charmsCell;
  }

  /**
   * Initialize the Discord integration
   */
  async initialize(): Promise<void> {
    const integrationCell = await this.getDiscordIntegrationCell();

    console.log("existingData", integrationCell.get());
    console.log("cell id", integrationCell.entityId);

    if (integrationCell.get().charms.length > 0) {
      console.log("Cell already exists, skipping initialization");
    }

    console.log("Initializing cell");
    integrationCell.set({ charms: [] });
    await storage.synced();
  }

  async fetchDiscordIntegrationCharms(): Promise<
    { space: DID; charmId: string }[]
  > {
    const integrationCell = await this.getDiscordIntegrationCell();
    const cellData = integrationCell.get();

    return cellData.charms.map((entry) => ({
      space: entry.space as DID,
      charmId: entry.charmId,
    })) || [];
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
      fetchCharms: () => this.fetchDiscordIntegrationCharms(),
    };
  }
}

// Export the integration instance
export default new DiscordIntegration();
