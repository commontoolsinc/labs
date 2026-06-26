import { type SigilLink } from "@commonfabric/runner";
import { runtime } from "@/index.ts";
import {
  type JSONSchema,
  type Mutable,
  type Schema,
} from "@commonfabric/runner";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import env from "@/env.ts";
import {
  custodyIngest,
  durableSet,
  type VouchedChannel,
} from "@/lib/custody-ingest.ts";

// Plaid Auth Schema
export const PlaidAuthSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accessToken: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          itemId: { type: "string" },
          institutionId: { type: "string" },
          institutionName: { type: "string" },
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                accountId: { type: "string" },
                name: { type: "string" },
                mask: { type: "string" },
                type: { type: "string" },
                subtype: { type: "string" },
                balances: {
                  type: "object",
                  properties: {
                    available: { type: ["number", "null"] },
                    current: { type: ["number", "null"] },
                    limit: { type: ["number", "null"] },
                    isoCurrencyCode: { type: ["string", "null"] },
                    unofficialCurrencyCode: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          products: {
            type: "array",
            items: { type: "string" },
          },
          consentExpirationTime: { type: ["string", "null"] },
          lastUpdated: { type: "string" },
          lastSyncCursor: { type: ["string", "null"] },
        },
        required: [
          "accessToken",
          "itemId",
          "institutionId",
          "institutionName",
          "accounts",
          "products",
          "lastUpdated",
        ],
      },
      default: [],
    },
  },
  required: ["items"],
} as const satisfies JSONSchema;

// Types
export type PlaidAuthData = Mutable<Schema<typeof PlaidAuthSchema>>;

export interface PlaidItem {
  accessToken: string;
  itemId: string;
  institutionId: string;
  institutionName: string;
  accounts: Array<{
    accountId: string;
    name: string;
    mask: string;
    type: string;
    subtype: string;
    balances: {
      available: number | null;
      current: number | null;
      limit: number | null;
      isoCurrencyCode: string | null;
      unofficialCurrencyCode: string | null;
    };
  }>;
  products: string[];
  consentExpirationTime: string | null;
  lastUpdated: string;
  lastSyncCursor: string | null;
}

// Create Plaid client
export const createPlaidClient = (): PlaidApi => {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[env.PLAID_ENV || "sandbox"],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID,
        "PLAID-SECRET": env.PLAID_SECRET,
      },
    },
  });

  return new PlaidApi(configuration);
};

// Helper function to get auth cell
export async function getAuthCell(docLink: SigilLink | string) {
  try {
    const parsedDocLink = typeof docLink === "string"
      ? JSON.parse(docLink)
      : docLink;

    parsedDocLink.schema = parsedDocLink.schema ?? PlaidAuthSchema;

    const authCell = runtime.getCellFromLink(parsedDocLink);

    await authCell.sync();
    await runtime.storageManager.synced();

    return authCell;
  } catch (error) {
    throw new Error(`Failed to get auth cell: ${error}`);
  }
}

// Get auth data from the auth cell
export async function getAuthData(
  authCellDocLink: string | SigilLink,
): Promise<PlaidAuthData> {
  try {
    const authCell = await getAuthCell(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    const authData = authCell.get() as PlaidAuthData | null;

    if (!authData) {
      return { items: [] };
    }

    return authData;
  } catch (error) {
    throw new Error(`Error getting auth data: ${error}`);
  }
}

// Build the vouched-ingest channel for a Plaid auth cell. As with OAuth,
// channel/audience are recorded-not-enforced provenance: pre-grant-infra the
// channel is the cell's own space and audience records the Plaid source.
function plaidIngestChannel(
  authCell: Awaited<ReturnType<typeof getAuthCell>>,
): VouchedChannel {
  return {
    channel: authCell.getAsNormalizedFullLink().space,
    audience: "did:web:commonfabric.org#plaid",
  };
}

// Save auth data to the auth cell. Now a governed, retrying durable write
// (replacing the divergent bare `.set()` + synced, which had no retry and a
// read-modify-write race). When `ingest` is set the write is external data
// arriving from Plaid, so it mints the ExternalIngest mark via custodyIngest;
// otherwise (e.g. removing an item) it is a plain operator write with no mark.
export async function saveAuthData(
  authCellDocLink: string | SigilLink,
  authData: PlaidAuthData,
  options?: { ingest?: boolean },
) {
  try {
    const authCell = await getAuthCell(authCellDocLink);

    if (!authCell) {
      throw new Error("Auth cell not found");
    }

    if (options?.ingest) {
      await custodyIngest.set(authCell, authData, plaidIngestChannel(authCell));
    } else {
      await durableSet(authCell, authData);
    }

    return authData;
  } catch (error) {
    throw new Error(`Error saving auth data: ${error}`);
  }
}

// Add or update an item in the auth data
export async function upsertPlaidItem(
  authCellDocLink: string | SigilLink,
  item: PlaidItem,
): Promise<PlaidAuthData> {
  try {
    const authData = await getAuthData(authCellDocLink);

    // Ensure items array exists
    if (!authData.items) {
      authData.items = [];
    }

    // Find existing item index
    const existingIndex = authData.items.findIndex(
      (i) => i.itemId === item.itemId,
    );

    if (existingIndex >= 0) {
      // Update existing item
      authData.items[existingIndex] = item;
    } else {
      // Add new item
      authData.items.push(item);
    }

    // A new/updated item is Plaid data arriving from the provider — mark it.
    return await saveAuthData(authCellDocLink, authData, { ingest: true });
  } catch (error) {
    throw new Error(`Error upserting Plaid item: ${error}`);
  }
}

// Remove an item from the auth data
export async function removePlaidItem(
  authCellDocLink: string | SigilLink,
  itemId: string,
): Promise<PlaidAuthData> {
  try {
    const authData = await getAuthData(authCellDocLink);

    if (!authData.items) {
      authData.items = [];
    }

    // Filter out the item
    authData.items = authData.items.filter((i) => i.itemId !== itemId);

    return await saveAuthData(authCellDocLink, authData);
  } catch (error) {
    throw new Error(`Error removing Plaid item: ${error}`);
  }
}

// Get a specific item from auth data
export async function getPlaidItem(
  authCellDocLink: string | SigilLink,
  itemId: string,
): Promise<PlaidItem | null> {
  try {
    const authData = await getAuthData(authCellDocLink);

    if (!authData.items) {
      return null;
    }

    const item = authData.items.find((i) => i.itemId === itemId);
    return item ? item as PlaidItem : null;
  } catch (error) {
    throw new Error(`Error getting Plaid item: ${error}`);
  }
}
