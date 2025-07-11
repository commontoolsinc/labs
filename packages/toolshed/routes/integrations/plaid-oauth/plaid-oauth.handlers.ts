import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  BackgroundIntegrationRoute,
  CreateLinkTokenRoute,
  ExchangeTokenRoute,
  RefreshAccountsRoute,
  RemoveItemRoute,
  SyncTransactionsRoute,
} from "./plaid-oauth.routes.ts";
import {
  createBackgroundIntegrationErrorResponse,
  createBackgroundIntegrationSuccessResponse,
  createExchangeErrorResponse,
  createExchangeSuccessResponse,
  createLinkTokenErrorResponse,
  createLinkTokenSuccessResponse,
  createPlaidClient,
  createRefreshErrorResponse,
  createRefreshSuccessResponse,
  createRemoveErrorResponse,
  createRemoveSuccessResponse,
  createSyncErrorResponse,
  createSyncSuccessResponse,
  getAuthData,
  getPlaidItem,
  type PlaidItem,
  removePlaidItem,
  upsertPlaidItem,
} from "./plaid-oauth.utils.ts";
import { setBGCharm } from "@commontools/background-charm";
import {
  type NormalizedLink,
  parseLink,
  type SigilLink,
} from "@commontools/runner";
import { runtime } from "@/index.ts";
import env from "@/env.ts";
import { CountryCode } from "plaid";

/**
 * Plaid Create Link Token Handler
 * Creates a Link token for initiating Plaid Link
 */
export const createLinkToken: AppRouteHandler<CreateLinkTokenRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid create link token request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return createLinkTokenErrorResponse(c, "Missing authCellId in request");
    }

    const plaidClient = createPlaidClient();

    // Create a user ID for Plaid (can be any stable string)
    const userId = "commontools-user";

    // Create link token request
    const linkTokenRequest: any = {
      user: {
        client_user_id: userId,
      },
      client_name: "Common Tools",
      products: payload.products || ["transactions"],
      country_codes: (payload.countryCodes || ["US"]) as CountryCode[],
      language: "en",
    };

    const response = await plaidClient.linkTokenCreate(linkTokenRequest);
    const { link_token, expiration } = response.data;

    logger.info(
      {
        linkToken: link_token.substring(0, 20) + "...",
        expiration,
      },
      "Created Plaid link token",
    );

    return c.json({
      linkToken: link_token,
      expiration,
    });
  } catch (error: any) {
    logger.error({ error }, "Failed to create link token");

    // Extract Plaid error details if available
    if (error.response?.data) {
      const plaidError = error.response.data;
      return c.json({
        error: plaidError.error_message || "Failed to create link token",
        error_code: plaidError.error_code,
        error_type: plaidError.error_type,
        display_message: plaidError.display_message,
      }, 400);
    }

    return createLinkTokenErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to create link token",
    );
  }
};

/**
 * Plaid Exchange Token Handler
 * Exchanges a public token for an access token and stores account data
 */
export const exchangeToken: AppRouteHandler<ExchangeTokenRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid token exchange request");

    if (!payload.publicToken || !payload.authCellId) {
      logger.error("Missing required fields in request payload");
      return createExchangeErrorResponse(
        c,
        "Missing publicToken or authCellId in request",
      );
    }

    const plaidClient = createPlaidClient();

    // Exchange public token for access token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: payload.publicToken,
    });

    const { access_token, item_id } = exchangeResponse.data;

    logger.info({ itemId: item_id }, "Exchanged public token for access token");

    // Fetch account details
    const accountsResponse = await plaidClient.accountsGet({
      access_token,
    });

    const { accounts, item } = accountsResponse.data;

    // Get institution details (use metadata if provided, otherwise fetch)
    let institutionId = payload.metadata?.institution?.institutionId;
    let institutionName = payload.metadata?.institution?.name;

    if (!institutionId && item.institution_id) {
      try {
        const institutionResponse = await plaidClient.institutionsGetById({
          institution_id: item.institution_id,
          country_codes: ["US"] as CountryCode[],
        });
        institutionId = institutionResponse.data.institution.institution_id;
        institutionName = institutionResponse.data.institution.name;
      } catch (error) {
        logger.warn(
          { error },
          "Failed to fetch institution details, using defaults",
        );
        institutionId = item.institution_id || "unknown";
        institutionName = "Unknown Institution";
      }
    }

    // Prepare item data for storage
    const plaidItem: PlaidItem = {
      accessToken: access_token,
      itemId: item_id,
      institutionId: institutionId || "unknown",
      institutionName: institutionName || "Unknown Institution",
      accounts: accounts.map((account) => ({
        accountId: account.account_id,
        name: account.name,
        mask: account.mask || "",
        type: account.type,
        subtype: account.subtype || "",
        balances: {
          available: account.balances.available,
          current: account.balances.current,
          limit: account.balances.limit,
          isoCurrencyCode: account.balances.iso_currency_code,
          unofficialCurrencyCode: account.balances.unofficial_currency_code,
        },
      })),
      products: item.available_products || ["accounts", "transactions"],
      consentExpirationTime: item.consent_expiration_time || null,
      lastUpdated: new Date().toISOString(),
      lastSyncCursor: null,
    };

    // Save to auth cell
    await upsertPlaidItem(payload.authCellId, plaidItem);

    // Add this charm to the Plaid integration charms cell
    try {
      const authCellLink = typeof payload.authCellId === "string"
        ? JSON.parse(payload.authCellId) as SigilLink
        : payload.authCellId as SigilLink;
      const parsedLink = parseLink(authCellLink) as NormalizedLink;
      const space = parsedLink.space;
      const integrationCharmId = payload.integrationCharmId;

      if (space && integrationCharmId) {
        logger.info(
          { space, integrationCharmId },
          "Adding Plaid integration charm",
        );

        await setBGCharm({
          space,
          charmId: integrationCharmId,
          integration: "plaid",
          runtime,
        });
      }
    } catch (error) {
      logger.warn(
        { error },
        "Failed to add charm to Plaid integrations, continuing anyway",
      );
    }

    return createExchangeSuccessResponse(c, item_id);
  } catch (error) {
    logger.error({ error }, "Failed to exchange token");
    return createExchangeErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to exchange token",
    );
  }
};

/**
 * Plaid Refresh Accounts Handler
 * Refreshes account balances and metadata
 */
export const refreshAccounts: AppRouteHandler<RefreshAccountsRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid refresh accounts request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return createRefreshErrorResponse(c, "Missing authCellId in request");
    }

    const plaidClient = createPlaidClient();
    const authData = await getAuthData(payload.authCellId);
    let updatedItems = 0;

    // Filter items to refresh
    const itemsToRefresh = payload.itemId
      ? authData.items.filter((item) => item.itemId === payload.itemId)
      : authData.items;

    if (itemsToRefresh.length === 0) {
      logger.warn("No items found to refresh");
      return createRefreshSuccessResponse(c, 0);
    }

    // Refresh each item
    for (const item of itemsToRefresh) {
      try {
        const accountsResponse = await plaidClient.accountsGet({
          access_token: item.accessToken,
        });

        const { accounts } = accountsResponse.data;

        // Update item with fresh account data
        const updatedItem: PlaidItem = {
          accessToken: item.accessToken,
          itemId: item.itemId,
          institutionId: item.institutionId,
          institutionName: item.institutionName,
          accounts: accounts.map((account) => ({
            accountId: account.account_id,
            name: account.name,
            mask: account.mask || "",
            type: account.type,
            subtype: account.subtype || "",
            balances: {
              available: account.balances.available,
              current: account.balances.current,
              limit: account.balances.limit,
              isoCurrencyCode: account.balances.iso_currency_code,
              unofficialCurrencyCode: account.balances.unofficial_currency_code,
            },
          })),
          products: item.products,
          consentExpirationTime: item.consentExpirationTime,
          lastUpdated: new Date().toISOString(),
          lastSyncCursor: item.lastSyncCursor,
        };

        await upsertPlaidItem(payload.authCellId, updatedItem);
        updatedItems++;
      } catch (error) {
        logger.error(
          { error, itemId: item.itemId },
          "Failed to refresh accounts for item",
        );
        // Continue with other items even if one fails
      }
    }

    return createRefreshSuccessResponse(c, updatedItems);
  } catch (error) {
    logger.error({ error }, "Failed to refresh accounts");
    return createRefreshErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to refresh accounts",
    );
  }
};

/**
 * Plaid Sync Transactions Handler
 * Syncs transactions using the /transactions/sync endpoint
 */
export const syncTransactions: AppRouteHandler<SyncTransactionsRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid sync transactions request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return createSyncErrorResponse(c, "Missing authCellId in request");
    }

    const plaidClient = createPlaidClient();
    const authData = await getAuthData(payload.authCellId);
    const allAddedTransactions: any[] = [];
    const allModifiedTransactions: any[] = [];
    const allRemovedIds: string[] = [];
    let hasMoreOverall = false;

    // Filter items to sync
    const itemsToSync = payload.itemId
      ? authData.items.filter((item) => item.itemId === payload.itemId)
      : authData.items;

    if (itemsToSync.length === 0) {
      logger.warn("No items found to sync");
      return createSyncSuccessResponse(c, 0, 0, 0, false);
    }

    // Sync transactions for each item
    for (const item of itemsToSync) {
      try {
        let hasMore = true;
        let cursor = item.lastSyncCursor;

        // Continue syncing until no more updates
        while (hasMore) {
          const syncRequest: any = {
            access_token: item.accessToken,
            count: payload.count || 500,
          };

          if (cursor) {
            syncRequest.cursor = cursor;
          }

          const syncResponse = await plaidClient.transactionsSync(syncRequest);
          const {
            added,
            modified,
            removed,
            next_cursor,
            has_more,
          } = syncResponse.data;

          // Collect the actual transaction data
          allAddedTransactions.push(...added);
          allModifiedTransactions.push(...modified);
          allRemovedIds.push(...removed.map((r: any) => r.transaction_id));

          cursor = next_cursor;
          hasMore = has_more;

          // Break after one batch if we're not syncing everything
          if (!env.PLAID_SYNC_ALL_TRANSACTIONS) {
            break;
          }
        }

        // Update the item's sync cursor
        const updatedItem: PlaidItem = {
          accessToken: item.accessToken,
          itemId: item.itemId,
          institutionId: item.institutionId,
          institutionName: item.institutionName,
          accounts: item.accounts as PlaidItem["accounts"],
          products: item.products,
          consentExpirationTime: item.consentExpirationTime,
          lastSyncCursor: cursor,
          lastUpdated: new Date().toISOString(),
        };

        await upsertPlaidItem(payload.authCellId, updatedItem);

        if (hasMore) hasMoreOverall = true;
      } catch (error) {
        logger.error(
          { error, itemId: item.itemId },
          "Failed to sync transactions for item",
        );
        // Continue with other items even if one fails
      }
    }

    // Return the actual transaction data
    return c.json({
      success: true,
      message: "Transactions synced successfully",
      added: allAddedTransactions,
      modified: allModifiedTransactions,
      removed: allRemovedIds,
      hasMore: hasMoreOverall,
    }, 200);
  } catch (error) {
    logger.error({ error }, "Failed to sync transactions");
    return createSyncErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to sync transactions",
    );
  }
};

/**
 * Plaid Remove Item Handler
 * Removes a connected bank account
 */
export const removeItem: AppRouteHandler<RemoveItemRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid remove item request");

    if (!payload.authCellId || !payload.itemId) {
      logger.error("Missing required fields in request payload");
      return createRemoveErrorResponse(
        c,
        "Missing authCellId or itemId in request",
      );
    }

    const plaidClient = createPlaidClient();

    // Get the item to remove
    const item = await getPlaidItem(payload.authCellId, payload.itemId);
    if (!item) {
      logger.warn({ itemId: payload.itemId }, "Item not found");
      return createRemoveErrorResponse(c, "Item not found");
    }

    // Remove from Plaid
    try {
      await plaidClient.itemRemove({
        access_token: item.accessToken,
      });
    } catch (error) {
      logger.error(
        { error, itemId: payload.itemId },
        "Failed to remove item from Plaid, continuing with local removal",
      );
    }

    // Remove from auth cell
    await removePlaidItem(payload.authCellId, payload.itemId);

    return createRemoveSuccessResponse(c);
  } catch (error) {
    logger.error({ error }, "Failed to remove item");
    return createRemoveErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to remove item",
    );
  }
};

/**
 * Background Integration Handler
 * Sets up background sync for Plaid
 */
export const backgroundIntegration: AppRouteHandler<
  BackgroundIntegrationRoute
> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();

    await setBGCharm({
      space: payload.space,
      charmId: payload.charmId,
      integration: payload.integration,
      runtime,
    });

    return createBackgroundIntegrationSuccessResponse(c, "success");
  } catch (error) {
    logger.error({ error }, "Failed to process background integration request");
    return createBackgroundIntegrationErrorResponse(
      c,
      "Failed to process background integration request",
    );
  }
};
