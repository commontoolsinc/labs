import {
  clearWishResults,
  findEventHandlers,
  NAME,
  setWishResult,
  textContent,
  UI,
  Writable,
} from "../commonfabric-stub.test.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function instantiatePattern(factory, input) {
  return factory(input);
}

function uiOf(value) {
  return value[UI];
}

function sendCountOf(value) {
  return value.sendCount;
}

if (Deno.env.get("SOURCE_COVERAGE_CHILD") === "1") {
  Deno.test("changed pattern source paths execute under plain Deno coverage", async () => {
    const { default: DoList } = await import("../../../do-list/do-list.tsx");
    const doItems = new Writable([
      {
        title: "Done",
        done: true,
        indent: 0,
        aiEnabled: false,
        attachments: [],
      },
    ]);
    const doList = instantiatePattern(DoList, { items: doItems });
    const compactArchiveHandlers = findEventHandlers(
      doList.compactUI,
      "onClick",
    );
    const screenArchiveHandlers = findEventHandlers(uiOf(doList), "onClick");
    assert(
      compactArchiveHandlers.length > 0 && screenArchiveHandlers.length > 0,
      "expected archive buttons in both UIs",
    );
    compactArchiveHandlers[0]();
    screenArchiveHandlers[0]();
    assert(
      doItems.get().length === 0,
      "archive buttons remove completed items",
    );

    const { default: FetchDataDynamic } = await import(
      "../../../gideon-tests/test-30-fetchdata-dynamic-instantiation.tsx"
    );
    const fetchDataDynamic = instantiatePattern(FetchDataDynamic, {
      repos: [
        { id: "1", name: "react" },
        { id: "2", name: "vue" },
      ],
    });
    const repos = fetchDataDynamic.repos;
    assert(
      Array.isArray(repos) && repos.length === 2,
      "fetch-data dynamic pattern keeps input repos",
    );
    assert(
      textContent(uiOf(fetchDataDynamic)).includes("Stars: 123"),
      "fetch-data dynamic pattern renders typed star counts",
    );

    const { default: GmailImporter } = await import(
      "../../../google/core/gmail-importer.tsx"
    );
    const gmailImporter = instantiatePattern(GmailImporter, {
      settings: {
        gmailFilterQuery: "in:INBOX",
        limit: 0,
        debugMode: false,
        autoFetchOnAuth: true,
        resolveInlineImages: false,
      },
      overrideAuth: new Writable({
        token: "token",
        tokenType: "Bearer",
        scope: [],
        expiresIn: 3600,
        expiresAt: 4_000_000_000_000,
        refreshToken: "",
        user: { email: "ada@example.com", name: "Ada", picture: "" },
      }),
    });
    assert(
      sendCountOf(gmailImporter.bgUpdater) === 1,
      "gmail importer auto-fetch sends the void updater stream",
    );

    const { default: SharedProfileDemo } = await import(
      "../../../shared-profile-demo/main.tsx"
    );
    clearWishResults();
    setWishResult("#profile", { initialNameApplied: "Ada Lovelace" });
    setWishResult("#profileName", "Fallback Name");
    const sharedProfile = instantiatePattern(SharedProfileDemo, {});
    assert(
      textContent(uiOf(sharedProfile)).includes("Ada Lovelace"),
      "shared profile demo uses the typed profile wish result first",
    );

    const { default: Journal } = await import("../../../system/journal.tsx");
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
    const journal = instantiatePattern(Journal, {});
    assert(
      textContent(uiOf(journal)).includes("Journal subject"),
      "journal renders entries with typed subject cells",
    );
  });
}
