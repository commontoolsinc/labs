/**
 * Test Pattern: Google extractor building blocks
 *
 * Covers the shared GmailExtractor and BillExtractor wrappers with an empty
 * linked auth cell. The empty token keeps API calls inactive while exercising
 * the auth handoff path.
 *
 * Run: deno task cf test packages/patterns/google/core/extractor-building-blocks.test.tsx --root packages/patterns/google --verbose
 */
import { computed, pattern, safeDateNow, Writable } from "commonfabric";
import BillExtractor, { processBills } from "./bill-extractor/index.tsx";
import { createBillKey } from "./bill-extractor/helpers.ts";
import GmailExtractor, {
  type AnalysisItem,
  type Auth,
  countCompleted,
  countPending,
  type Email,
  interpolateTemplate,
} from "./gmail-extractor.tsx";

function emptyAuth() {
  return new Writable<Auth>({
    token: "",
    tokenType: "",
    scope: [],
    expiresIn: 0,
    expiresAt: 0,
    refreshToken: "",
    user: { email: "", name: "", picture: "" },
  });
}

function isoDateDaysFromNow(days: number): string {
  const date = new Date(safeDateNow());
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export default pattern(() => {
  const extractor = GmailExtractor({
    gmailQuery: "from:billing@example.com",
    title: "Billing Emails",
    limit: 25,
    overrideAuth: emptyAuth(),
  });

  const billExtractor = BillExtractor({
    gmailQuery: "from:billing@example.com",
    extractionPrompt: "Extract the bill due date and amount.",
    identifierType: "account",
    title: "Example Bill Tracker",
    shortName: "Example",
    brandColor: "#2563eb",
    websiteUrl: "https://example.com",
    overrideAuth: emptyAuth(),
    manuallyPaid: new Writable<string[]>([]),
    demoMode: new Writable(false),
    supportsAutoDetect: false,
  });

  const assert_gmail_extractor_starts_disconnected = computed(() =>
    extractor.isConnected === false &&
    extractor.emailCount === 0 &&
    extractor.rawAnalyses.length === 0 &&
    extractor.pendingCount === 0 &&
    extractor.completedCount === 0
  );

  const assert_gmail_extractor_ui_bundle_exists = computed(() =>
    extractor.ui.authStatusUI !== undefined &&
    extractor.ui.connectionStatusUI !== undefined &&
    extractor.ui.previewUI !== undefined
  );

  const assert_bill_extractor_starts_empty = computed(() =>
    billExtractor.bills.length === 0 &&
    billExtractor.unpaidBills.length === 0 &&
    billExtractor.paidBills.length === 0 &&
    billExtractor.totalUnpaid === 0 &&
    billExtractor.overdueCount === 0 &&
    billExtractor.isConnected === false
  );

  const assert_bill_extractor_config_is_preserved = computed(() =>
    billExtractor.title === "Example Bill Tracker" &&
    billExtractor.shortName === "Example" &&
    billExtractor.brandColor === "#2563eb" &&
    billExtractor.supportsAutoDetect === false
  );

  const assert_analysis_helpers_count_states = computed(() => {
    const analyses: AnalysisItem<{ ok: boolean }>[] = [
      { analysis: { pending: true } },
      { analysis: { pending: false, result: { ok: true } } },
      { analysis: { pending: false } },
      { analysis: {} },
    ];

    return countPending(analyses) === 1 && countCompleted(analyses) === 1;
  });

  const assert_template_interpolation_sanitizes_content = computed(() => {
    const email: Email = {
      id: "msg-1",
      threadId: "thread-1",
      labelIds: [],
      subject: "Invoice",
      from: "billing@example.com",
      to: "user@example.com",
      date: "2026-07-10",
      snippet: "Payment due",
      markdownContent: "![inline](data:image/png;base64,abc123)" +
        "m".repeat(110_000),
      plainText: "Plain body",
      htmlContent: '<img src="data:image/jpeg;base64,abc123">' +
        "h".repeat(60_000),
      summary: "",
    };

    const rendered = interpolateTemplate(
      [
        "{{email.subject}}",
        "{{email.from}}",
        "{{email.to}}",
        "{{email.snippet}}",
        "{{email.markdownContent}}",
        "{{email.plainText}}",
        "{{email.htmlContent}}",
      ].join("\n"),
      email,
    );

    return rendered.includes("Invoice") &&
      rendered.includes("billing@example.com") &&
      rendered.includes("[embedded-image]") &&
      rendered.includes("[Content truncated") &&
      !rendered.includes("abc123");
  });

  const assert_process_bills_applies_payment_rules = computed(() => {
    const upcomingDueDate = isoDateDaysFromNow(10);
    const oldDueDate = isoDateDaysFromNow(-60);
    const manualDueDate = isoDateDaysFromNow(20);
    const bills = processBills(
      [
        {
          emailId: "older-duplicate",
          emailDate: isoDateDaysFromNow(-2),
          analysis: {
            result: {
              emailType: "bill_due",
              identifier: "1111",
              amount: 100,
              dueDate: upcomingDueDate,
              summary: "Older duplicate",
            },
          },
        },
        {
          emailId: "newer-bill",
          emailDate: isoDateDaysFromNow(-1),
          analysis: {
            result: {
              emailType: "bill_due",
              identifier: "1111",
              amount: 200,
              dueDate: upcomingDueDate,
              summary: "Newer duplicate",
            },
          },
        },
        {
          emailId: "manual",
          emailDate: isoDateDaysFromNow(-1),
          analysis: {
            result: {
              emailType: "statement_ready",
              identifier: "2222",
              statementBalance: 50,
              dueDate: manualDueDate,
              summary: "Manual payment",
            },
          },
        },
        {
          emailId: "old",
          emailDate: isoDateDaysFromNow(-70),
          analysis: {
            result: {
              emailType: "payment_reminder",
              identifier: "3333",
              amount: 75,
              dueDate: oldDueDate,
              summary: "Old bill",
            },
          },
        },
        {
          emailId: "ignored",
          emailDate: isoDateDaysFromNow(-1),
          analysis: {
            result: {
              emailType: "other",
              identifier: "4444",
              amount: 25,
              dueDate: upcomingDueDate,
              summary: "Ignored",
            },
          },
        },
      ],
      { "1111": [upcomingDueDate] },
      [createBillKey("2222", manualDueDate)],
      false,
    );

    const paidByEmail = bills.find((bill) => bill.identifier === "1111");
    const manuallyPaid = bills.find((bill) => bill.identifier === "2222");
    const likelyPaid = bills.find((bill) => bill.identifier === "3333");

    return bills.length === 3 &&
      paidByEmail?.status === "paid" &&
      paidByEmail.amount === 200 &&
      manuallyPaid?.isManuallyPaid === true &&
      manuallyPaid.status === "paid" &&
      likelyPaid?.isLikelyPaid === true &&
      likelyPaid.status === "likely_paid";
  });

  return {
    tests: [
      { assertion: assert_gmail_extractor_starts_disconnected },
      { assertion: assert_gmail_extractor_ui_bundle_exists },
      { assertion: assert_bill_extractor_starts_empty },
      { assertion: assert_bill_extractor_config_is_preserved },
      { assertion: assert_analysis_helpers_count_states },
      { assertion: assert_template_interpolation_sanitizes_content },
      { assertion: assert_process_bills_applies_payment_rules },
    ],
    extractor,
    billExtractor,
  };
});
