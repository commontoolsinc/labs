import { Cell, getCell, storage } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import { Identity } from "@commontools/identity";

// System space ID (shared across integrations)
export const SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";

// Generic schema for integration cells
export const integrationCellSchema = {
  type: "object" as const,
  properties: {
    charms: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          space: { type: "string" as const },
          charmId: { type: "string" as const },
          integration: { type: "string" as const },
        },
        required: ["space", "charmId", "integration"],
      },
      default: [],
    },
  },
  required: ["charms"],
};

// // Base integration schema type
// export interface BaseIntegrationSchema {
//   charms: Array<{
//     space: string;
//     charmId: string;
//     integration: string;
//   }>;
// }

// /**
//  * Base Integration class that can be extended by specific integrations
//  */
// export abstract class BaseIntegration implements Integration {
//   abstract id: string;
//   abstract name: string;
//   abstract cellCauseName: string;

//   /**
//    * Get integration cell
//    */
//   async getIntegrationCell(): Promise<Cell<BaseIntegrationSchema>> {
//     const signer = await Identity.fromPassphrase(env.OPERATOR_PASS);
//     storage.setSigner(signer);

//     const integrationCell = getCell<BaseIntegrationSchema>(
//       SYSTEM_SPACE_ID,
//       this.cellCauseName,
//       integrationCellSchema,
//     );

//     storage.syncCell(integrationCell, true);
//     await storage.synced();

//     return integrationCell;
//   }

//   /**
//    * Initialize the integration
//    */
//   async initialize(): Promise<void> {
//     const integrationCell = await this.getIntegrationCell();

//     log(`Initializing ${this.id} integration`);

//     if (integrationCell.get().charms.length > 0) {
//       log(`${this.id} cell already exists, skipping initialization`);
//       return;
//     }

//     log(`Initializing ${this.id} cell with empty array`);
//     integrationCell.set({ charms: [] });
//     await storage.synced();
//   }

//   /**
//    * Fetch charms for this integration
//    */
//   async fetchIntegrationCharms(): Promise<{ space: DID; charmId: string }[]> {
//     const integrationCell = await this.getIntegrationCell();
//     const cellData = integrationCell.get();

//     return cellData.charms.map((entry) => ({
//       space: entry.space as DID,
//       charmId: entry.charmId,
//     })) || [];
//   }

//   /**
//    * Get the integration cell configuration
//    */
//   getIntegrationConfig(): IntegrationCellConfig {
//     return {
//       id: this.id,
//       name: this.name,
//       spaceId: SYSTEM_SPACE_ID,
//       cellCauseName: this.cellCauseName,
//       fetchCharms: () => this.fetchIntegrationCharms(),
//     };
//   }

//   /**
//    * Add a charm to this integration
//    */
//   async addCharm(space: string, charmId: string): Promise<boolean> {
//     const integrationCell = await this.getIntegrationCell();

//     // Get current charms data
//     const charmsData = integrationCell.get();

//     // Check if this charm is already in the list to avoid duplicates
//     const exists = charmsData.charms.some(
//       (charm) => charm.space === space && charm.charmId === charmId,
//     );

//     if (!exists) {
//       // Add the new charm to the list
//       charmsData.charms.push({ space, charmId });

//       // Update the cell
//       integrationCell.set(charmsData);

//       // Ensure changes are synced
//       await storage.synced();
//       return true; // Added
//     }

//     return false; // Already exists
//   }
// }

// // Integration registry
// const integrations = new Map<string, Integration>();

// /**
//  * Load all integrations explicitly (typechecking!)
//  */
// export function loadIntegrations(): void {
//   try {
//     // Register integrations explicitly
//     registerIntegration(gmailIntegration);
//     registerIntegration(discordIntegration);

//     log(`Loaded ${integrations.size} integrations`);
//   } catch (error) {
//     const errorMessage = error instanceof Error ? error.message : String(error);
//     log(`Error loading integrations: ${errorMessage}`);
//   }
// }

// /**
//  * Get all available integrations
//  */
// export function getAvailableIntegrations(): Integration[] {
//   return Array.from(integrations.values());
// }

// /**
//  * Get available integration IDs
//  */
// export function getAvailableIntegrationIds(): string[] {
//   return Array.from(integrations.keys());
// }

// /**
//  * Get an integration by ID
//  */
// export function getIntegration(id: string): Integration | undefined {
//   return integrations.get(id);
// }

// /**
//  * Register a new integration
//  */
// export function registerIntegration(integration: Integration): void {
//   integrations.set(integration.id, integration);
// }

// // Load integrations on module import
// loadIntegrations();
