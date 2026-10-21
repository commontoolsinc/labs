# FileStoreView

`FileStoreView` renders one store ([`FileStore.md`](FileStore.md)) for hosts
that render VDOM, such as the shell. It is the store's rendering, in a module of
its own, so that nothing that uses a store has to load it. It decides nothing
about the store's files that the store doesn't already say.

## What it holds

A view is a pattern taking one input, **`store`**: a link to a store, set when
the view is instantiated. That is all it holds besides its own rendering state,
which is `PerSession`: a sort order, a selection, a rename in progress, and the
uploads it has started and not yet added. It MUST NOT hold anything read from
the store, or any copy of a file's bytes.

A root that offers file storage instantiates the view from its own rendering,
when it shows its files. A client that draws natively never instantiates it.

## What it shows

- Each entry in `entries`: its name, its media type, its size, and its adder,
  with `cf-profile-badge`. An image, a video or an audio file is shown inline,
  from its blob, and any other file as a link that downloads it.
- An upload control, `cf-file-input`, for a viewer the store's space admits with
  WRITE or OWNER. The control stores each chosen file's bytes in the store's
  space's blob store, and the view then sends the store's `add` for each, with
  `onConflict: "rename"`, and the name the file had.
- For each entry the viewer may change, a control that removes it, and one that
  renames it, which sends `rename` with `onConflict: "refuse"`, and shows a
  refusal's reason beside the name.

## Outputs

- `store`: the link.
- `[UI]`: the rendering.
- `[VIEWS]`: the store's `files` group, re-exported by link. The view adds
  nothing to it.

A view offers no stream of its own. Every change reaches the store's own
streams.

## Prerequisites

- **A blob URL a pattern can form.** Showing an image, or linking a download,
  needs a URL for the entry's blob. `cf-file-input` returns one for each upload,
  but an entry holds a blob reference and no URL (see
  [`FileEntry`](FileEntry.md#fields)), and nothing yet forms a URL from a
  reference. That needs either a component that takes a blob reference, such as
  `cf-image` taking `blob`, or a function a pattern can call.
