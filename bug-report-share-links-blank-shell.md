# Bug Report: Shared Piece Links Can Render a Blank Shell

Date: April 7, 2026

## Summary

Publishing from `fabric-local.py` can succeed, but opening the hosted share URL can still show a blank shell instead of the published document.

There are two separate problems involved:

1. A validated runtime-client bug in `PageGet` drops `$UI` when the shell fetches a piece by ID.
2. A second hosted-shell boot issue still appears to exist for direct shared-piece links even after the `$UI` bug is fixed locally.

This PR only fixes and tests the first problem.

## External Repro

Starting point:

- Local app: `http://localhost:9900`
- Entry document:
  `/Users/tonyespinoza/loom-files/Common Fabric/Loom/wish-pipeline/wish-pipeline-learning.md`
- Hosted share URL observed during repro:
  `https://toolshed.saga-castor.ts.net/tE-loom--mar-26/baedreidxfvonidrzb66nhhmlywffmraqww2eiw56aezlqhixhrzmwuh6ci`

Observed behavior:

- publishing succeeds,
- the hosted URL loads the shell frame,
- the main body stays blank.

## Root Cause 1: `getPage()` Narrows Pages Down To `NameSchema`

The shell fetches a piece by ID through:

```ts
// packages/shell/src/lib/runtime.ts
const page = await this.#client.getPage<NameSchema>(id, true);
```

On the worker side, `PageGet` was narrowing the fetched page cell to `nameSchema`, which strips away `$UI`:

```ts
// packages/runtime-client/backends/runtime-processor.ts
handlePageGet(request: PageGetRequest): PageResponse {
  let cell = this.runtime.getCellFromEntityId(this.space, {
    "/": request.pageId,
  });

  cell = cell.asSchema(nameSchema);

  if (request.runIt) {
    this.runtime.start(cell).catch(console.error);
  }

  return {
    page: createPageRef(cell),
  };
}
```

That means the shell can successfully resolve the page ID while still handing `ct-render` a cell that only exposes `$NAME`.

## Why This Produces A Blank Body

The shell body renders the fetched page cell directly:

```ts
// packages/shell/src/views/BodyView.ts
<ct-piece slot="main" .pieceId="${this.activePattern.id()}">
  <ct-render .cell="${this.activePattern.cell()}"></ct-render>
</ct-piece>
```

`ct-render` expects the cell to contain `[UI]`:

```ts
// packages/ui/src/v2/components/ct-render/ct-render.ts
this._cleanup = render(container, renderCell as CellHandle<VNode>);
```

When the fetched page cell only has `$NAME`, the render path has no `$UI` to mount, and the page appears blank. During browser repros this surfaced as:

- `Error: No data at cell`

## Evidence That The Published Piece Itself Is Valid

The published share artifact is not the primary problem here.

Using the CLI against the same hosted piece with a fresh identity, `ct piece view --json` returns the expected render tree, including:

- `ct-screen`
- `ct-vscroll`
- `ct-markdown`

That confirms the piece does contain renderable UI and that the blank page is caused by the shell/runtime fetch path, not by the published note pattern shape.

## Fix Included In This PR

Remove the schema narrowing in `handlePageGet()` so fetched pages preserve their full page shape, including `$UI`.

Updated code:

```ts
// packages/runtime-client/backends/runtime-processor.ts
handlePageGet(request: PageGetRequest): PageResponse {
  const cell = this.runtime.getCellFromEntityId(this.space, {
    "/": request.pageId,
  });

  if (request.runIt) {
    this.runtime.start(cell).catch(console.error);
  }

  return {
    page: createPageRef(cell),
  };
}
```

## Regression Test Included In This PR

Added a runtime-client integration test that:

1. creates a page with `[UI]`,
2. fetches it back via `getPage()`,
3. verifies `$UI` is still present,
4. renders the fetched page successfully.

Reference:

- `packages/runtime-client/integration/client.test.ts`
- test name: `renders UI from a page fetched back through getPage()`

## Remaining Issue Not Fixed In This PR

There still appears to be a second direct-link boot problem in the hosted shell path.

Even with a transient identity present, local Playwright repros against the hosted piece still surfaced additional errors around shell startup and surrounding pattern resolution, including:

- `Could not resolve "commonfabric"`
- `Could not retrieve "types/commontools.d.ts"`
- blank `x-app-view` with no mounted `x-body-view`

There is also a local shell experiment around transient identity bootstrap in:

- `packages/shell/shared/app/controller.ts`
- `packages/shell/integration/piece.test.ts`

That work is intentionally not included in this PR, because it is not yet validated end to end and should be debugged as a separate shell issue.
