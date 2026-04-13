import {
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";
import {
  TrustedSaveSurface,
  TrustedSaveTitleUiContract,
} from "../cfc-trusted-surfaces/main.tsx";

interface AuthorizedSaveInput {
  draftTitle: Writable<Default<string, "">>;
  savedTitle: Writable<Default<TrustedSaveTitleUiContract, "">>;
}

interface AuthorizedSaveOutput {
  [NAME]: string;
  [UI]: unknown;
  draftTitle: string;
  savedTitle: TrustedSaveTitleUiContract;
  save: Stream<void>;
}

export default pattern<AuthorizedSaveInput, AuthorizedSaveOutput>(
  ({ draftTitle, savedTitle }) => {
    const trustedSave = TrustedSaveSurface({ draftTitle, savedTitle });

    return {
      [NAME]: computed(() =>
        `Authorized Save (${savedTitle.get() || "empty"})`
      ),
      [UI]: (
        <cf-screen title="Authorized Save">
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            {trustedSave}
            <cf-card id="legacy-save-panel">
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>Host shortcut</cf-heading>
                <cf-label>
                  This plain host button reuses the same stream but is not the
                  reviewed trusted surface.
                </cf-label>
                <cf-button id="legacy-save-button" onClick={trustedSave.save}>
                  Save title
                </cf-button>
              </cf-vstack>
            </cf-card>
            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-label>Protected saved title</cf-label>
                <div id="saved-title">{savedTitle}</div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      draftTitle,
      savedTitle,
      save: trustedSave.save,
    };
  },
);
