import {
  clearWishResults,
  findEventHandlers,
  NAME,
  setWishResult,
  textContent,
  UI,
  Writable,
} from "commonfabric";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("changed pattern source paths execute under plain Deno coverage", async () => {
  const { default: DoList } = await import("../../do-list/do-list.tsx");
  const doItems = new Writable([
    {
      title: "Done",
      done: true,
      indent: 0,
      aiEnabled: false,
      attachments: [],
    },
  ]);
  const doList = DoList({ items: doItems });
  const compactArchiveHandlers = findEventHandlers(doList.compactUI, "onClick");
  const screenArchiveHandlers = findEventHandlers(doList[UI], "onClick");
  assert(
    compactArchiveHandlers.length > 0 && screenArchiveHandlers.length > 0,
    "expected archive buttons in both UIs",
  );
  compactArchiveHandlers[0]();
  screenArchiveHandlers[0]();
  assert(doItems.get().length === 0, "archive buttons remove completed items");

  const { default: FetchDataDynamic } = await import(
    "../../gideon-tests/test-30-fetchdata-dynamic-instantiation.tsx"
  );
  const fetchDataDynamic = FetchDataDynamic({
    repos: [
      { id: "1", name: "react" },
      { id: "2", name: "vue" },
    ],
  });
  assert(
    fetchDataDynamic.repos.length === 2,
    "fetch-data dynamic pattern keeps input repos",
  );
  assert(
    textContent(fetchDataDynamic[UI]).includes("Stars: 123"),
    "fetch-data dynamic pattern renders typed star counts",
  );

  const { default: GmailImporter } = await import(
    "../../google/core/gmail-importer.tsx"
  );
  const gmailImporter = GmailImporter({
    settings: {
      gmailFilterQuery: "in:INBOX",
      limit: 0,
      debugMode: false,
      autoFetchOnAuth: true,
      resolveInlineImages: false,
    },
    overrideAuth: {
      token: "token",
      tokenType: "Bearer",
      scope: [],
      expiresIn: 3600,
      expiresAt: 4_000_000_000_000,
      refreshToken: "",
      user: { email: "ada@example.com", name: "Ada", picture: "" },
    },
  });
  assert(
    gmailImporter.bgUpdater.sendCount === 1,
    "gmail importer auto-fetch sends the void updater stream",
  );

  const { default: SharedProfileDemo } = await import(
    "../../shared-profile-demo/main.tsx"
  );
  clearWishResults();
  setWishResult("#profile", { initialNameApplied: "Ada Lovelace" });
  setWishResult("#profileName", "Fallback Name");
  const sharedProfile = SharedProfileDemo({});
  assert(
    textContent(sharedProfile[UI]).includes("Ada Lovelace"),
    "shared profile demo uses the typed profile wish result first",
  );

  const { default: Journal } = await import("../../system/journal.tsx");
  clearWishResults();
  setWishResult("#journal", [
    {
      timestamp: Date.now(),
      eventType: "piece:created",
      subject: new Writable({ [NAME]: "Journal subject" }),
      snapshot: { name: "Journal subject" },
      narrative: "Created a journal subject",
      tags: ["created"],
    },
  ]);
  const journal = Journal({});
  assert(
    textContent(journal[UI]).includes("Journal subject"),
    "journal renders entries with typed subject cells",
  );
});
