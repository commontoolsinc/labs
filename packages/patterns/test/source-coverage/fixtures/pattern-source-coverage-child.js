import {
  clearGenerateTextResult,
  clearLlmDialogParams,
  clearWishResults,
  findEventHandlers,
  getLlmDialogParams,
  NAME,
  setFetchJsonUncheckedResult,
  setGenerateTextResult,
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

function findNodesByType(node, type) {
  const nodes = [];
  const seen = new WeakSet();
  const visit = (value) => {
    if (value == null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value.type === type) nodes.push(value);
    visit(value.children);
    visit(value.props?.children);
  };
  visit(node);
  return nodes;
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

    const { default: FetchJsonDynamic } = await import(
      "../../../gideon-tests/test-30-fetchjson-dynamic-instantiation.tsx"
    );
    const fetchJsonDynamic = instantiatePattern(FetchJsonDynamic, {
      repos: [
        { id: "1", name: "react" },
        { id: "2", name: "vue" },
      ],
    });
    const repos = fetchJsonDynamic.repos;
    assert(
      Array.isArray(repos) && repos.length === 2,
      "fetch-json dynamic pattern keeps input repos",
    );
    assert(
      textContent(uiOf(fetchJsonDynamic)).includes("Stars: 123"),
      "fetch-json dynamic pattern renders typed star counts",
    );

    const { default: FetchJsonExample } = await import(
      "../../../examples/fetch-json.tsx"
    );
    const fetchJsonExample = instantiatePattern(FetchJsonExample, {
      repoUrl: new Writable("https://github.com/vercel/next.js"),
    });
    assert(
      textContent(uiOf(fetchJsonExample)).includes("123"),
      "fetch-json example renders the typed repo star count",
    );

    const { default: TestAwaitInHandler } = await import(
      "../../../gideon-tests/test-await-in-handler.tsx"
    );
    const testAwaitInHandler = instantiatePattern(TestAwaitInHandler, {});
    assert(
      textContent(uiOf(testAwaitInHandler)).includes("Fetched successfully"),
      "await-in-handler pattern renders the reactive fetchJson result",
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

    const {
      defineItemSchema,
      listTool,
      listToolHandler,
    } = await import("../../../google/core/util/agentic-tools.ts");
    const favoriteSchema = defineItemSchema({
      name: { type: "string", description: "Favorite name" },
      notes: { type: "string", description: "Supporting note" },
    }, ["name"]);
    const favorites = new Writable([]);
    const favoriteTool = listTool(favoriteSchema, {
      items: favorites,
      dedupe: ["name"],
      idPrefix: "favorite",
      timestamp: "savedAt",
    });
    assert(
      favoriteTool.inputSchema.properties.result.asCell[0] === "cell",
      "list tool exposes a result cell in its input schema",
    );
    const toolResult = new Writable({});
    const reportFavorite = listToolHandler(favoriteTool.state);
    reportFavorite.send({
      name: "Tea",
      notes: "With milk",
      result: toolResult,
    });
    reportFavorite.send({
      name: "Tea",
      notes: "Duplicate",
      result: toolResult,
    });
    assert(
      favorites.get().length === 1,
      "list tool deduplicates matching entries",
    );
    assert(
      favorites.get()[0].name === "Tea" && !("result" in favorites.get()[0]),
      "list tool stores data fields without the result cell",
    );
    assert(
      String(toolResult.get().message).includes("already saved"),
      "list tool reports duplicate entries",
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

    const { default: PromptInjectionDemo } = await import(
      "../../../cfc-agent-prompt-injection-demo/main.tsx"
    );
    clearLlmDialogParams();
    const promptInjectionDemo = instantiatePattern(PromptInjectionDemo, {});
    assert(
      textContent(uiOf(promptInjectionDemo)).includes(
        "Prompt injection against mail-sending agents",
      ),
      "prompt injection demo renders its title",
    );
    assert(
      promptInjectionDemo.parentModel.get() === "gateway:z-ai/glm-5",
      "prompt injection demo exposes the default parent model",
    );
    const dialogParams = getLlmDialogParams();
    assert(
      dialogParams.length === 2,
      "prompt injection demo creates two agent dialogs",
    );
    const unsafeTools = dialogParams[0].tools;
    const safeTools = dialogParams[1].tools;
    const unsafeReadResult = new Writable(null);
    unsafeTools.readRawBriefing.handler.send({ result: unsafeReadResult });
    assert(
      unsafeReadResult.get().body.includes("Status: NOT APPROVED"),
      "unsafe briefing reader returns the raw briefing body",
    );
    const safeReadResult = new Writable(null);
    safeTools.readRawBriefing.handler.send({ result: safeReadResult });
    assert(
      safeReadResult.get().body.redacted === true,
      "safe briefing reader returns the redacted body marker",
    );
    const sendResult = new Writable(null);
    unsafeTools.sendMail.handler.send({
      recipient: "john@example.org",
      subject: "not approved",
      body: { "@link": "/of:summary" },
      result: sendResult,
    });
    assert(
      sendResult.get().ok === true &&
        promptInjectionDemo.emails.get()[0].body ===
          "[opaque link: /of:summary]",
      "mail tool logs opaque-link bodies as display strings",
    );
    const promptDemoClickHandlers = findEventHandlers(
      uiOf(promptInjectionDemo),
      "onClick",
    );
    assert(
      promptDemoClickHandlers.length >= 6,
      "prompt injection demo renders its control buttons",
    );
    for (const click of promptDemoClickHandlers) click();
    setFetchJsonUncheckedResult("not a model directory");
    const fallbackPromptInjectionDemo = instantiatePattern(
      PromptInjectionDemo,
      {},
    );
    const fallbackModelValues = findNodesByType(
      uiOf(fallbackPromptInjectionDemo),
      "cf-select",
    ).map((select) => select.props.items.map((item) => item.value).join("\n"));
    assert(
      fallbackModelValues.length === 2 &&
        fallbackModelValues.every((values) =>
          values === [
            "gateway:z-ai/glm-5",
            "anthropic:claude-sonnet-4.6",
            "gateway:claude-sonnet-4-6",
          ].join("\n")
        ),
      "prompt injection demo uses fallback model items for invalid model directories",
    );
    setFetchJsonUncheckedResult({ stargazers_count: 123 });

    const { default: ExtractorModule } = await import(
      "../../../record/extraction/extractor-module.tsx"
    );
    setGenerateTextResult({
      pending: false,
      result: undefined,
      error: "OCR request failed",
    });
    const extractor = instantiatePattern(ExtractorModule, {
      parentSubPieces: new Writable([
        {
          type: "photo",
          pinned: false,
          piece: {
            image: {
              data: "data:image/png;base64,AAAA",
            },
            label: "Business card",
          },
        },
      ]),
      parentTrashedSubPieces: new Writable([]),
      parentTitle: new Writable(""),
      sourceSelections: new Writable({}),
      trashSelections: new Writable({}),
      selections: new Writable({}),
      extractPhase: new Writable("select"),
      extractionPrompt: new Writable(""),
      cleanupNotesEnabled: new Writable(true),
      notesContentSnapshot: new Writable({}),
      cleanupApplyStatus: new Writable("pending"),
      applyInProgress: new Writable(false),
      errorDetailsExpanded: new Writable(false),
    });
    assert(
      textContent(uiOf(extractor)).includes(
        "OCR failed for some photos: OCR request failed.",
      ),
      "extractor renders OCR string errors",
    );
    clearGenerateTextResult();

    setGenerateTextResult({
      pending: false,
      result: "Ada prefers tea.",
      error: undefined,
    });
    const extractorWithoutOcrError = instantiatePattern(ExtractorModule, {
      parentSubPieces: new Writable([
        {
          type: "photo",
          pinned: false,
          piece: {
            image: {
              data: "data:image/png;base64,BBBB",
            },
            label: "Tea note",
          },
        },
      ]),
      parentTrashedSubPieces: new Writable([]),
      parentTitle: new Writable(""),
      sourceSelections: new Writable({}),
      trashSelections: new Writable({}),
      selections: new Writable({}),
      extractPhase: new Writable("select"),
      extractionPrompt: new Writable(""),
      cleanupNotesEnabled: new Writable(true),
      notesContentSnapshot: new Writable({}),
      cleanupApplyStatus: new Writable("pending"),
      applyInProgress: new Writable(false),
      errorDetailsExpanded: new Writable(false),
    });
    assert(
      !textContent(uiOf(extractorWithoutOcrError)).includes(
        "OCR failed for some photos",
      ),
      "extractor omits OCR error text when no OCR error is present",
    );
    clearGenerateTextResult();
  });
}
