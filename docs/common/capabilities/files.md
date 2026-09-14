# Files

A file's bytes never live in a pattern's cells. A pattern that takes files
uploads them to the space's blob store through `cf-file-input`, keeps the small
descriptor the upload returns, and serves a download as a link to the
descriptor's URL. The store keeps each blob as a content-addressed document of
its own in the space, so the pattern's cells stay small however large the file
is, and the list syncs like any other list of records. `packages/patterns/file-share/main.tsx` is the whole
shape in one file.

## Uploading

`cf-file-input` opens the browser's file chooser, uploads each chosen file to
the blob store of the space the pattern runs in, and fires `cf-change` with
the files it just stored:

```tsx
// Shown for illustration only.
interface UploadedFile {
  id: string; // hash of the media type and bytes, prefixed `fid1:`
  name: string;
  mediaType: string;
  size: number;
  url: string; // absolute URL the bytes are served from
}

interface AddFilesEvent {
  detail?: { files?: UploadedFile[] };
}

<cf-file-input multiple showPreview={false} oncf-change={addFiles} />;
```

The event carries more fields than these; keep the ones the pattern reads and
push them into a shared list. Never keep the bytes or a data URL in a cell.
`includeData` on the input puts a base64 copy of the file into `data` for a
transient use such as sending an image to a model; a record that persists that
copy makes the cell as large as the file, and a large cell syncs slowly and can
fail to sync at all.

With previews enabled the input renders its own remove buttons, and a click on
one fires `cf-change` again with `files` holding every remaining file. A
handler that treats `files` as new uploads then re-adds them. Either turn
previews off, or handle `cf-remove` and read `allFiles` as the full list.

## Downloading

A download is an anchor: `<a href={file.url} download={file.name}>`. The
store serves no filename of its own, so the `download` attribute is what names
the saved file. Browsers honor it only when the link is same-origin with the
page; a space served from another host saves the file under its hash instead.

`cf-file-download` is not for stored files. It takes the content as a string
and builds the download in the browser, so using it means holding the bytes in
a cell.

## What the store provides

- One upload holds at most 10 MB; the server returns 413 above that.
- A blob is addressed by the hash of its media type and bytes, so the same
  file uploaded twice has the same id. The URL is that id plus a short suffix:
  the file name's last extension when it is one to eight letters or digits,
  otherwise one chosen from the media type, or `bin`. Two uploads of the same
  bytes share a URL when they get the same suffix and have two URLs when they
  do not. Each URL is immutable and cacheable forever.
- The bytes stay in the space's own store beside its cells. There is no
  offload to an object store, and no signed or expiring URL.
- GIF, JPEG, PNG, and WebP are served as their own media type, so an `<img>`
  can show them. Every other type is served as `application/octet-stream`, so
  a browser downloads it rather than rendering it inline.
- Nothing deletes a blob. Removing a record drops the reference; the bytes
  stay.
- The upload and download routes are not authenticated: anyone who holds a
  blob's URL can fetch it, and anyone can upload into a space.

The store is `packages/toolshed/routes/blobs/blobs.index.ts`.
