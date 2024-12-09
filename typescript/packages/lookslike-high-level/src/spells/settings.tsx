import { h, behavior, $, select, Session } from "@commontools/common-system";
import { fromString } from "merkle-reference";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { defaultTo, event, isEmpty, Transact } from "../sugar.js";
import { attemptAuth, getToken, isGmailAuthenticated } from "../gmail.js";

export const settings = behavior({
  view: select({ self: $.self })
    .render(({ self }) => (
      <div title="Settings" entity={self}>
        <div>
          <h2>Connect Services</h2>

          <div>
            <h3>Bluesky</h3>
            <form onSubmit="~/on/bluesky-auth">
              <div>
                <label>Handle</label>
                <common-input
                  type="text"
                  name="handle"
                  oncommon-blur="~/on/bluesky-handle"
                />
              </div>
              <div>
                <label>Password</label>
                <common-input
                  type="password"
                  name="password"
                  oncommon-blur="~/on/bluesky-password"
                />
              </div>
              <button type="submit">Connect Bluesky</button>
            </form>
          </div>

          <div>
            <h3>Gmail</h3>
            {isGmailAuthenticated() ? `Connected` : <button onclick="~/on/gmail-auth">
              Connect Gmail Account
            </button>}

            {isGmailAuthenticated() && <pre>{JSON.stringify(getToken(), null, 2)}</pre>}

          </div>

          <div>
            <h3>Spotify</h3>
            <button onclick="~/on/spotify-auth">
              Connect Spotify Account
            </button>
          </div>

          <div>
            <h3>GitHub</h3>
            <button onclick="~/on/github-auth">
              Connect GitHub Account
            </button>
          </div>

        </div>
      </div>
    )).commit(),

  onBlueskyAuth: event("~/on/bluesky-auth")
    .update(({ self, event }) => {
      const formData = Session.resolve<CommonInputEvent>(event).detail;
      return [{ Upsert: [self, "blueskyAuth", formData.value] }];
    })
    .commit(),

  onBlueskyHandle: event("~/on/bluesky-handle")
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "blueskyHandle", val] }];
    })
    .commit(),

  onBlueskyPassword: event("~/on/bluesky-password")
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "blueskyPassword", val] }];
    })
    .commit(),

  onGmailAuth: event("~/on/gmail-auth")
    .update(({ self }) => {
      // Trigger Gmail OAuth flow
      attemptAuth();
      return [{ Upsert: [self, "gmailAuthStarted", true] }];
    })
    .commit(),

  onSpotifyAuth: event("~/on/spotify-auth")
    .update(({ self }) => {
      // Trigger Spotify OAuth flow
      return [{ Upsert: [self, "spotifyAuthStarted", true] }];
    })
    .commit(),

  onGithubAuth: event("~/on/github-auth")
    .update(({ self }) => {
      // Trigger GitHub OAuth flow
      return [{ Upsert: [self, "githubAuthStarted", true] }];
    })
    .commit(),
});
