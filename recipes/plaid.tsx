import {
  Cell,
  cell,
  derive,
  getRecipeEnvironment,
  h,
  handler,
  ID,
  ifElse,
  JSONSchema,
  Mutable,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "commontools";

const Classification = {
  Unclassified: "unclassified",
  Confidential: "confidential",
  Secret: "secret",
  TopSecret: "topsecret",
} as const;

const ClassificationSecret = "secret";

// Plaid Auth Schema for storing multiple bank connections
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
            ifc: { classification: [ClassificationSecret] },
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

const env = getRecipeEnvironment();

const AccountProperties = {
  accountId: {
    type: "string",
    title: "Account ID",
    description: "Unique identifier for the account",
  },
  itemId: {
    type: "string",
    title: "Item ID",
    description: "Plaid Item ID this account belongs to",
  },
  institutionName: {
    type: "string",
    title: "Institution",
    description: "Bank or financial institution name",
  },
  name: {
    type: "string",
    title: "Account Name",
    description: "Name of the account",
  },
  mask: {
    type: "string",
    title: "Account Mask",
    description: "Last 4 digits of account number",
  },
  type: {
    type: "string",
    title: "Account Type",
    description: "Type of account (e.g., depository, credit, loan)",
  },
  subtype: {
    type: "string",
    title: "Account Subtype",
    description: "Subtype of account (e.g., checking, savings, credit card)",
  },
  currentBalance: {
    type: ["number", "null"],
    title: "Current Balance",
    description: "Current balance of the account",
  },
  availableBalance: {
    type: ["number", "null"],
    title: "Available Balance",
    description: "Available balance of the account",
  },
  limit: {
    type: ["number", "null"],
    title: "Credit Limit",
    description: "Credit limit (for credit accounts)",
  },
  isoCurrencyCode: {
    type: ["string", "null"],
    title: "Currency Code",
    description: "ISO currency code",
  },
} as const;

const AccountSchema = {
  type: "object",
  properties: AccountProperties,
  required: Object.keys(AccountProperties),
  ifc: { classification: [Classification.Confidential] },
} as const satisfies JSONSchema;
type Account = Mutable<Schema<typeof AccountSchema>>;

const TransactionProperties = {
  transactionId: {
    type: "string",
    title: "Transaction ID",
    description: "Unique identifier for the transaction",
  },
  accountId: {
    type: "string",
    title: "Account ID",
    description: "Account this transaction belongs to",
  },
  itemId: {
    type: "string",
    title: "Item ID",
    description: "Plaid Item ID this transaction belongs to",
  },
  amount: {
    type: "number",
    title: "Amount",
    description:
      "Transaction amount (positive for debits, negative for credits)",
  },
  isoCurrencyCode: {
    type: ["string", "null"],
    title: "Currency Code",
    description: "ISO currency code",
  },
  unofficialCurrencyCode: {
    type: ["string", "null"],
    title: "Unofficial Currency Code",
    description: "Unofficial currency code",
  },
  date: {
    type: "string",
    title: "Date",
    description: "Transaction date (YYYY-MM-DD)",
  },
  authorizedDate: {
    type: ["string", "null"],
    title: "Authorized Date",
    description: "Date transaction was authorized",
  },
  name: {
    type: "string",
    title: "Description",
    description: "Transaction description",
  },
  merchantName: {
    type: ["string", "null"],
    title: "Merchant Name",
    description: "Cleaned merchant name",
  },
  category: {
    type: "array",
    items: { type: "string" },
    title: "Category",
    description: "Transaction category hierarchy",
  },
  pending: {
    type: "boolean",
    title: "Pending",
    description: "Whether the transaction is pending",
  },
  paymentChannel: {
    type: "string",
    title: "Payment Channel",
    description: "How the transaction was made (e.g., online, in store)",
  },
} as const;

const TransactionSchema = {
  type: "object",
  properties: TransactionProperties,
  required: Object.keys(TransactionProperties),
  ifc: { classification: [Classification.Confidential] },
} as const satisfies JSONSchema;
type Transaction = Mutable<Schema<typeof TransactionSchema>>;

type PlaidAuth = Schema<typeof PlaidAuthSchema>;

const PlaidImporterInputs = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      properties: {
        products: {
          type: "array",
          items: { type: "string" },
          default: ["transactions"],
          description: "Plaid products to request",
        },
        daysToSync: {
          type: "number",
          default: 90,
          description: "Number of days of transactions to sync",
        },
        syncLimit: {
          type: "number",
          default: 500,
          description: "Max transactions to sync per request",
        },
      },
      required: ["products", "daysToSync", "syncLimit"],
    },
    auth: PlaidAuthSchema,
  },
  required: ["settings", "auth"],
  description: "Plaid Banking Importer",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    accounts: {
      type: "array",
      items: AccountSchema,
    },
    transactions: {
      type: "array",
      items: TransactionSchema,
    },
    plaidUpdater: { asStream: true, type: "object", properties: {} },
  },
} as const satisfies JSONSchema;

// Plaid API Client
class PlaidClient {
  private auth: Cell<PlaidAuth>;

  constructor(auth: Cell<PlaidAuth>) {
    this.auth = auth;
  }

  async refreshAccounts(itemId?: string): Promise<Account[]> {
    const authData = this.auth.get();
    const allAccounts: Account[] = [];

    if (!authData.items || authData.items.length === 0) {
      console.warn("No Plaid items found");
      return allAccounts;
    }

    const itemsToRefresh = itemId
      ? authData.items.filter((item) => item.itemId === itemId)
      : authData.items;

    for (const item of itemsToRefresh) {
      try {
        const response = await fetch(
          new URL("/api/integrations/plaid-oauth/refresh-accounts", env.apiUrl),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              authCellId: JSON.stringify(
                (this.auth as any).getAsLegacyCellLink(),
              ),
              itemId: item.itemId,
            }),
          },
        );

        if (!response.ok) {
          console.error(`Failed to refresh accounts for item ${item.itemId}`);
          continue;
        }

        // Get updated auth data after refresh
        const updatedAuth = this.auth.get();
        const updatedItem = updatedAuth.items.find((i) =>
          i.itemId === item.itemId
        );

        if (updatedItem) {
          // Convert to our Account schema
          const accounts = updatedItem.accounts.map((acc) => ({
            accountId: acc.accountId || "",
            itemId: updatedItem.itemId,
            institutionName: updatedItem.institutionName,
            name: acc.name || "",
            mask: acc.mask || "",
            type: acc.type || "",
            subtype: acc.subtype || "",
            currentBalance: acc.balances?.current ?? null,
            availableBalance: acc.balances?.available ?? null,
            limit: acc.balances?.limit ?? null,
            isoCurrencyCode: acc.balances?.isoCurrencyCode ?? null,
          }));
          allAccounts.push(...accounts);
        }
      } catch (error) {
        console.error(
          `Error refreshing accounts for item ${item.itemId}: `,
          error,
        );
      }
    }

    return allAccounts;
  }

  async syncTransactions(
    existingTransactions: Transaction[],
    itemId?: string,
    count: number = 500,
  ): Promise<{
    added: Transaction[];
    modified: Transaction[];
    removed: string[];
  }> {
    const authData = this.auth.get();
    const allAdded: Transaction[] = [];
    const allModified: Transaction[] = [];
    const allRemoved: string[] = [];

    if (!authData.items || authData.items.length === 0) {
      console.warn("No Plaid items found");
      return { added: allAdded, modified: allModified, removed: allRemoved };
    }

    const itemsToSync = itemId
      ? authData.items.filter((item) => item.itemId === itemId)
      : authData.items;

    // Create a map of existing transactions for efficient lookup
    const existingMap = new Map(
      existingTransactions.map((t) => [t.transactionId, t]),
    );

    for (const item of itemsToSync) {
      try {
        const response = await fetch(
          new URL(
            "/api/integrations/plaid-oauth/sync-transactions",
            env.apiUrl,
          ),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              authCellId: JSON.stringify(
                (this.auth as any).getAsLegacyCellLink(),
              ),
              itemId: item.itemId,
              count,
            }),
          },
        );

        if (!response.ok) {
          console.error(`Failed to sync transactions for item ${item.itemId}`);
          continue;
        }

        const result = await response.json();

        // Collect the transactions with proper formatting
        if (result.added && result.added.length > 0) {
          const formattedTransactions = result.added.map((t: any) => ({
            transactionId: t.transaction_id,
            accountId: t.account_id,
            itemId: item.itemId,
            amount: t.amount,
            isoCurrencyCode: t.iso_currency_code,
            unofficialCurrencyCode: t.unofficial_currency_code,
            date: t.date,
            authorizedDate: t.authorized_date,
            name: t.name,
            merchantName: t.merchant_name,
            category: t.category || [],
            pending: t.pending,
            paymentChannel: t.payment_channel,
          }));
          allAdded.push(...formattedTransactions);
        }

        if (result.modified && result.modified.length > 0) {
          const formattedTransactions = result.modified.map((t: any) => ({
            transactionId: t.transaction_id,
            accountId: t.account_id,
            itemId: item.itemId,
            amount: t.amount,
            isoCurrencyCode: t.iso_currency_code,
            unofficialCurrencyCode: t.unofficial_currency_code,
            date: t.date,
            authorizedDate: t.authorized_date,
            name: t.name,
            merchantName: t.merchant_name,
            category: t.category || [],
            pending: t.pending,
            paymentChannel: t.payment_channel,
          }));
          allModified.push(...formattedTransactions);
        }

        if (result.removed && result.removed.length > 0) {
          allRemoved.push(...result.removed);
        }

        console.log(
          `Synced transactions for ${item.itemId}: ${
            result.added?.length || 0
          } added, ${result.modified?.length || 0} modified, ${
            result.removed?.length || 0
          } removed`,
        );
      } catch (error) {
        console.error(
          `Error syncing transactions for item ${item.itemId}: `,
          error,
        );
      }
    }

    return { added: allAdded, modified: allModified, removed: allRemoved };
  }
}

// Handler for updating settings
const updateDaysToSync = handler({
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
}, {
  type: "object",
  properties: { daysToSync: { type: "number", asCell: true } },
  required: ["daysToSync"],
}, ({ detail }, state) => {
  state.daysToSync.set(parseInt(detail?.value ?? "90") || 90);
});

const updateSyncLimit = handler({
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
}, {
  type: "object",
  properties: { syncLimit: { type: "number", asCell: true } },
  required: ["syncLimit"],
}, ({ detail }, state) => {
  state.syncLimit.set(parseInt(detail?.value ?? "500") || 500);
});

// Main sync handler
const plaidUpdater = handler(
  {},
  {
    type: "object",
    properties: {
      accounts: {
        type: "array",
        items: AccountSchema,
        default: [],
        asCell: true,
      },
      transactions: {
        type: "array",
        items: TransactionSchema,
        default: [],
        asCell: true,
      },
      auth: { ...PlaidAuthSchema, asCell: true },
      settings: { ...PlaidImporterInputs.properties.settings, asCell: true },
    },
    required: ["accounts", "transactions", "auth", "settings"],
  } as const satisfies JSONSchema,
  async (_event, state) => {
    console.log("plaidUpdater triggered!");

    const authData = state.auth.get();
    if (!authData.items || authData.items.length === 0) {
      console.warn("No Plaid items connected");
      return;
    }

    const client = new PlaidClient(state.auth);

    // Refresh accounts
    console.log("Refreshing accounts...");
    const accounts = await client.refreshAccounts();
    if (accounts.length > 0) {
      state.accounts.set(accounts);
      console.log(`Updated ${accounts.length} accounts`);
    }

    // Sync transactions
    console.log("Syncing transactions...");
    const existingTransactions = state.transactions.get();
    const syncResult = await client.syncTransactions(
      existingTransactions,
      undefined,
      state.settings.get().syncLimit,
    );

    // Handle deleted transactions
    if (syncResult.removed.length > 0) {
      console.log(`Removing ${syncResult.removed.length} deleted transactions`);
      const deleteSet = new Set(syncResult.removed);
      const currentTransactions = state.transactions.get();
      const remainingTransactions = currentTransactions.filter(
        (t) => !deleteSet.has(t.transactionId),
      );
      state.transactions.set(remainingTransactions);
    }

    // Handle modified transactions
    if (syncResult.modified.length > 0) {
      console.log(
        `Updating ${syncResult.modified.length} modified transactions`,
      );
      const currentTransactions = state.transactions.get();
      const modifiedMap = new Map(
        syncResult.modified.map((t) => [t.transactionId, t]),
      );

      const updatedTransactions = currentTransactions.map((t) =>
        modifiedMap.has(t.transactionId) ? modifiedMap.get(t.transactionId)! : t
      );
      state.transactions.set(updatedTransactions);
    }

    // Add new transactions
    if (syncResult.added.length > 0) {
      console.log(`Adding ${syncResult.added.length} new transactions`);
      // Add ID field for Common Tools
      syncResult.added.forEach((t: any) => {
        t[ID] = t.transactionId;
      });
      state.transactions.push(...syncResult.added);

      // Sort all transactions by date (newest first)
      const allTransactions = state.transactions.get();
      allTransactions.sort((a, b) => b.date.localeCompare(a.date));
      state.transactions.set(allTransactions);
    }
  },
);

const formatAmount = (amount: number, currency: string) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Math.abs(amount));
};

// Main recipe
export default recipe(
  PlaidImporterInputs,
  ResultSchema,
  ({ settings, auth }) => {
    const accounts = cell<Account[]>([]);
    const transactions = cell<Transaction[]>([]);

    // Log when accounts or transactions change
    derive(accounts, (accounts) => {
      console.log("Accounts updated: ", accounts.length);
    });

    derive(transactions, (transactions) => {
      console.log("Transactions updated: ", transactions.length);
    });

    return {
      [NAME]: str`Plaid Banking`,
      [UI]: (
        <div style="display: flex; gap: 20px; flex-direction: column; padding: 25px;">
          <h2 style="font-size: 24px; font-weight: bold; margin: 0;">
            Plaid Banking Integration
          </h2>

          <common-plaid-link
            $auth={auth}
            products={settings.products}
          />

          <div style="display: flex; gap: 20px; flex-direction: column;">
            <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px;">
              <h3 style="margin: 0 0 15px; font-size: 18px;">Sync Settings</h3>

              <div style="display: flex; gap: 15px; flex-direction: column;">
                <div>
                  <label style="display: block; margin-bottom: 5px; font-weight: 500;">
                    Days to Sync
                  </label>
                  <common-input
                    customStyle="border: 1px solid #ddd; padding: 10px; border-radius: 4px; width: 200px;"
                    value={settings.daysToSync}
                    placeholder="90"
                    oncommon-input={updateDaysToSync({
                      daysToSync: settings.daysToSync,
                    })}
                  />
                </div>

                <div>
                  <label style="display: block; margin-bottom: 5px; font-weight: 500;">
                    Transaction Limit
                  </label>
                  <common-input
                    customStyle="border: 1px solid #ddd; padding: 10px; border-radius: 4px; width: 200px;"
                    value={settings.syncLimit}
                    placeholder="500"
                    oncommon-input={updateSyncLimit({
                      syncLimit: settings.syncLimit,
                    })}
                  />
                </div>

                <button
                  type="button"
                  onClick={plaidUpdater({
                    accounts,
                    transactions,
                    auth,
                    settings,
                  })}
                  style="background-color: #1db954; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: 500;"
                >
                  Sync Data
                </button>
              </div>
            </div>

            {derive(accounts, (accounts) => (
              <div>
                <h3 style="margin: 0 0 15px; font-size: 18px;">
                  Accounts ({accounts.length})
                </h3>
                <div style="overflow-x: auto;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                      <tr style="background-color: #f5f5f5;">
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #ddd;">
                          Institution
                        </th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #ddd;">
                          Account
                        </th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #ddd;">
                          Type
                        </th>
                        <th style="padding: 12px; text-align: right; border-bottom: 2px solid #ddd;">
                          Available
                        </th>
                        <th style="padding: 12px; text-align: right; border-bottom: 2px solid #ddd;">
                          Current
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.map((account) => (
                        <tr style="border-bottom: 1px solid #eee;">
                          <td style="padding: 12px;">
                            {account.institutionName}
                          </td>
                          <td style="padding: 12px;">
                            {account.name} ****{account.mask}
                          </td>
                          <td style="padding: 12px;">
                            {account.type}
                          </td>
                          <td style="padding: 12px; text-align: right;">
                            {formatAmount(
                              account.availableBalance,
                              account.isoCurrencyCode,
                            )}
                          </td>
                          <td style="padding: 12px; text-align: right;">
                            {formatAmount(
                              account.currentBalance,
                              account.isoCurrencyCode,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {derive(transactions, (transactions) => (
              <div>
                <h3 style="margin: 0 0 15px; font-size: 18px;">
                  Transactions ({transactions.length})
                </h3>
                <div style="overflow-x: auto; max-height: 500px;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <thead style="position: sticky; top: 0; background-color: #f5f5f5;">
                      <tr>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #ddd;">
                          Date
                        </th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #ddd;">
                          Description
                        </th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #ddd;">
                          Category
                        </th>
                        <th style="padding: 12px; text-align: right; border-bottom: 2px solid #ddd;">
                          Amount
                        </th>
                        <th style="padding: 12px; text-align: center; border-bottom: 2px solid #ddd;">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((transaction) => (
                        <tr style="border-bottom: 1px solid #eee;">
                          <td style="padding: 12px;">{transaction.date}</td>
                          <td style="padding: 12px;">
                            {transaction.name}
                          </td>
                          <td style="padding: 12px;">
                            {transaction.category}
                          </td>
                          <td style="padding: 12px; text-align: right;">
                            {formatAmount(
                              transaction.amount,
                              transaction.isoCurrencyCode,
                            )}
                          </td>
                          <td style="padding: 12px; text-align: center;">
                            {ifElse(
                              transaction.pending,
                              <span style="background-color: #ffc107; color: #000; padding: 2px 8px; border-radius: 12px; font-size: 12px;">
                                Pending
                              </span>,
                              <span style="background-color: #28a745; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 12px;">
                                Posted
                              </span>,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style="padding: 12px; text-align: center; color: #666;">
                    {transactions.length} transactions
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
      accounts,
      transactions,
      bgUpdater: plaidUpdater({ accounts, transactions, auth, settings }),
    };
  },
);
