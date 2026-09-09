/**
 * Reads this month's newest email headers out of a mail connector's
 * `messages` table — id, subject, snippet, sender and received date, and no
 * body column at all — with a list `[UI]` over them. A live message is
 * `deleted_at IS NULL` here: this store marks a deleted message by stamping
 * that column, which is the opposite spelling to the `deleted = 0` integer
 * flag a connector ledger such as Plaid's uses, so the two cannot be filtered
 * the same way. `month` picks the window as `YYYY-MM` and defaults to the
 * calendar month the database's own clock is in; `limit` caps the rows at 200
 * unless the caller says otherwise.
 *
 * @hashtags gmail, email, mail, messages, headers, inbox, month
 * @keywords email headers, subject line, sender, this month's mail, bills in
 * email, newest messages, no bodies, SqliteDb handle
 */
import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  type SqliteDb,
  UI,
  type VNode,
} from "commonfabric";

/** One message header, under the names the projection gives its columns. */
export interface MailboxHeader {
  id: number;
  subject: string;
  snippet: string;
  sender: string;
  received_at: string;
}

export interface MailboxMonthHeadersInput {
  /** The mail store to read. Whoever wired the input chose which. */
  mail: SqliteDb;

  /** The month to read, as `YYYY-MM`. Empty means the current month. */
  month?: string | Default<"">;

  /** How many headers to return, newest first. */
  limit?: number | Default<200>;
}

export interface MailboxMonthHeadersOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The month the headers were read from, as `YYYY-MM`. */
  month: string;

  headers: MailboxHeader[];
  headerCount: number;
  pending: boolean;

  /** Why the read failed, empty while it has not. */
  errorMessage: string;
}

/**
 * The month the caller asked for, else the one the database's clock is in.
 *
 * The clock is read in SQL rather than in the pattern because a pattern body
 * and a `computed` are both denied the clock inside the sandbox.
 */
const resolvedMonthSql = (): string =>
  "COALESCE(NULLIF(?, ''), strftime('%Y-%m', 'now', 'localtime'))";

/** One row naming the month the headers below were read from. */
const monthSql = (): string => `SELECT ${resolvedMonthSql()} AS month`;

/**
 * A message dates from whichever of the three timestamps it carries, so the
 * same expression bounds the window and orders the result; the store fills
 * them unevenly and a message missing `received_at` still belongs to a month.
 */
const receivedSql = (): string =>
  "COALESCE(m.received_at, m.sent_at, m.internal_date)";

/** Headers only: no body column is projected, and none is joined for. */
const headersSql = (): string =>
  [
    `WITH bounds AS (SELECT ${resolvedMonthSql()} || '-01' AS start)`,
    "SELECT m.id, m.subject, m.snippet,",
    `  ${receivedSql()} AS received_at,`,
    "  COALESCE(p.display_name, p.email_address, '') AS sender",
    "FROM bounds, messages m",
    "LEFT JOIN participants p ON p.id = m.sender_id",
    "WHERE m.deleted_at IS NULL",
    `  AND ${receivedSql()} >= bounds.start`,
    `  AND ${receivedSql()} < date(bounds.start, '+1 month')`,
    "ORDER BY received_at DESC",
    "LIMIT ?",
  ].join("\n");

/** What a query reports about a failure, empty when it has not failed. */
const errorText = (error: unknown): string => {
  if (error === undefined || error === null) return "";
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "The query failed.";
};

export const MailboxMonthHeaders = pattern<
  MailboxMonthHeadersInput,
  MailboxMonthHeadersOutput
>(({ mail, month, limit }) => {
  const monthRead = mail.query<{ month: string }>(monthSql(), {
    params: [month],
    scope: "session",
  });
  const headersRead = mail.query<MailboxHeader>(headersSql(), {
    params: [month, limit],
    scope: "session",
  });

  const resolvedMonth = computed(() => monthRead.result?.[0]?.month ?? "");
  const headers = computed(() => headersRead.result ?? []);
  const headerCount = computed(() => (headersRead.result ?? []).length);
  const pending = computed(() => headersRead.pending === true);
  const errorMessage = computed(() => errorText(headersRead.error));
  const hasError = computed(() => errorMessage !== "");
  const isEmpty = computed(() =>
    !pending && !hasError && (headersRead.result ?? []).length === 0
  );

  const listRows = headers.map((header: MailboxHeader) => (
    <cf-vstack gap="1">
      <cf-hstack gap="2" align="center" justify="between">
        <cf-text style="flex: 1;">
          {computed(() => header.subject || "(No subject)")}
        </cf-text>
        <cf-text tone="muted">{header.received_at}</cf-text>
      </cf-hstack>
      <cf-text tone="muted">{header.sender}</cf-text>
    </cf-vstack>
  ));

  return {
    [NAME]: computed(() => `Mail ${resolvedMonth} (${headerCount})`),
    [UI]: (
      <cf-vstack gap="3" padding="3">
        <cf-hstack justify="between" align="center">
          <cf-heading level={5}>Email headers</cf-heading>
          <cf-text tone="muted">{resolvedMonth}</cf-text>
        </cf-hstack>

        {ifElse(
          hasError,
          <cf-alert status="error">{errorMessage}</cf-alert>,
          null,
        )}

        <cf-vstack gap="2">
          {listRows}
        </cf-vstack>

        {ifElse(
          isEmpty,
          <cf-empty-state message="No mail this month." />,
          null,
        )}
      </cf-vstack>
    ),
    month: resolvedMonth,
    headers,
    headerCount,
    pending,
    errorMessage,
  };
});

export default MailboxMonthHeaders;
