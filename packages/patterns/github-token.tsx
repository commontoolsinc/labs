/// <cts-enable />
import { Default, NAME, pattern, UI, Writable } from "commontools";

/** A personal access token for the GitHub API. #githubToken */
interface Output {
  token: string;
}

export default pattern<
  { token: Writable<Default<string, "">> },
  Output
>(({ token }) => {
  return {
    [NAME]: "GitHub Token",
    [UI]: (
      <ct-vstack gap="2" style={{ padding: "12px" }}>
        <label style={{ fontSize: "13px", fontWeight: 500 }}>
          GitHub Personal Access Token
        </label>
        <ct-input $value={token} placeholder="ghp_..." type="password" />
        <span style={{ fontSize: "11px", color: "var(--ct-color-gray-500)" }}>
          Favorite this piece (click the star) so other patterns can find it via
          wish.
        </span>
      </ct-vstack>
    ),
    token,
  };
});
