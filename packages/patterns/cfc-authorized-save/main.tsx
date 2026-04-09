import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

interface AuthorizedSaveInput {
  draftTitle: Writable<Default<string, "">>;
  savedTitle: Writable<Default<string, "">>;
}

interface AuthorizedSaveOutput {
  [NAME]: string;
  [UI]: unknown;
  draftTitle: string;
  savedTitle: WriteAuthorizedBy<string, typeof saveDraftTitle>;
  save: Stream<void>;
}

const saveDraftTitle = handler<
  void,
  {
    draftTitle: Writable<string>;
    savedTitle: Writable<string>;
  }
>((_, { draftTitle, savedTitle }) => {
  savedTitle.set(draftTitle.get().trim());
});

export default pattern<AuthorizedSaveInput, AuthorizedSaveOutput>(
  ({ draftTitle, savedTitle }) => {
    const save = saveDraftTitle({ draftTitle, savedTitle });

    return {
      [NAME]: computed(() =>
        `Authorized Save (${savedTitle.get() || "empty"})`
      ),
      [UI]: (
        <div>
          <cf-input
            $value={draftTitle}
            placeholder="Draft title"
          />
          <cf-button onClick={save}>
            Save title
          </cf-button>
          <div id="saved-title">{savedTitle}</div>
        </div>
      ),
      draftTitle,
      savedTitle,
      save,
    };
  },
);
