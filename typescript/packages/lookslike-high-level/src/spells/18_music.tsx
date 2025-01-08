import { h, Session, refer } from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, resolve } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";

export const Artist = z
  .object({
    name: z.string().min(1).max(255).describe("The name of the artist"),
  })
  .describe("Artist");

export const Song = z
  .object({
    title: z.string().min(1).max(255).describe("The title of the song"),
    artists: z
      .array(Artist)
      .min(1)
      .describe("The artists who performed the song"),
    duration: z.number().min(1).describe("The duration in seconds"),
    year: z.number().min(1900).max(2100).describe("The release year"),
  })
  .describe("Song");

export const Album = z
  .object({
    "album/title": z.string().min(1).max(255).describe("The album title"),
    artist: Artist.describe("The primary artist"),
    songs: z.array(Song).min(1).describe("The songs on the album"),
    year: z.number().min(1900).max(2100).describe("The release year"),
  })
  .describe("Album");

const Playlist = z
  .object({
    name: z.string().min(1).max(255).describe("The playlist name"),
    description: z.string().max(1000).describe("The playlist description"),
    songs: z.array(Song).describe("The songs in the playlist"),
  })
  .describe("Playlist");

const MusicLibrary = z.object({
  focused: Ref.describe("The item that is currently being edited"),
  artists: z.array(Artist).describe("All artists in the library"),
  songs: z.array(Song).describe("All songs in the library"),
  albums: z.array(Album).describe("All albums in the library"),
  playlists: z.array(Playlist).describe("All playlists in the library"),
  "~/common/ui/artist-list": UiFragment.describe(
    "The UI fragment for the artists list",
  ),
  "~/common/ui/song-list": UiFragment.describe(
    "The UI fragment for the songs list",
  ),
  "~/common/ui/album-list": UiFragment.describe(
    "The UI fragment for the albums list",
  ),
  "~/common/ui/playlist-list": UiFragment.describe(
    "The UI fragment for the playlists list",
  ),
});

type EditEvent = {
  detail: { item: Reference };
};

type SubmitEvent = {
  detail: {
    value:
      | z.infer<typeof Artist>
      | z.infer<typeof Song>
      | z.infer<typeof Album>
      | z.infer<typeof Playlist>;
  };
};

const artistEditor = typedBehavior(Artist, {
  render: ({ self, name }) => (
    <div entity={self}>
      <common-form schema={Artist} value={{ name }} onsubmit="~/on/save" />
      <details>
        <pre>{JSON.stringify({ name }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent>(event);
      const artist = ev.detail.value;
      cmd.add(...Transact.set(self, artist));
    }),
  }),
});

const songEditor = typedBehavior(Song, {
  render: ({ self, title, artists, duration, year }) => (
    <div entity={self}>
      <common-form
        schema={Song}
        value={{ title, artists, duration, year }}
        referenceFields={new Set(["artists"])}
        onsubmit="~/on/save"
      />
      <details>
        <pre>{JSON.stringify({ title, artists, duration, year }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent>(event);
      const song = ev.detail.value;
      cmd.add(...Transact.set(self, song));
    }),
  }),
});

const albumEditor = typedBehavior(Album, {
  render: ({ self, title, artist, songs, year }) => (
    <div entity={self}>
      <common-form
        schema={Album}
        value={{ title, artist, songs, year }}
        referenceFields={new Set(["artist", "songs"])}
        onsubmit="~/on/save"
      />
      <details>
        <pre>{JSON.stringify({ title, artist, songs, year }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent>(event);
      const album = ev.detail.value;
      cmd.add(...Transact.set(self, album));
    }),
  }),
});

const playlistEditor = typedBehavior(Playlist, {
  render: ({ self, name, description, songs }) => (
    <div entity={self}>
      <common-form
        schema={Playlist}
        value={{ name, description, songs }}
        referenceFields={new Set(["songs"])}
        onsubmit="~/on/save"
      />
      <details>
        <pre>{JSON.stringify({ name, description, songs }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent>(event);
      const playlist = ev.detail.value;
      cmd.add(...Transact.set(self, playlist));
    }),
  }),
});

export const musicLibrary = typedBehavior(
  MusicLibrary.pick({
    // focused: true,
    "~/common/ui/artist-list": true,
    "~/common/ui/song-list": true,
    "~/common/ui/album-list": true,
    "~/common/ui/playlist-list": true,
  }),
  {
    render: ({
      self,
      "~/common/ui/artist-list": artistList,
      "~/common/ui/song-list": songList,
      "~/common/ui/album-list": albumList,
      "~/common/ui/playlist-list": playlistList,
    }) => (
      <div entity={self} title="Music">
        <div>
          <div>
            <h3>Add Artist</h3>
            <common-form schema={Artist} reset onsubmit="~/on/add-artist" />
            <h3>Add Song</h3>
            <common-form
              schema={Song}
              referenceFields={new Set(["artists"])}
              reset
              onsubmit="~/on/add-song"
            />
            <h3>Add Album</h3>
            <common-form
              schema={Album}
              referenceFields={new Set(["artist", "songs"])}
              reset
              onsubmit="~/on/add-album"
            />
            <h3>Add Playlist</h3>
            <common-form
              schema={Playlist}
              referenceFields={new Set(["songs"])}
              reset
              onsubmit="~/on/add-playlist"
            />
          </div>
        </div>

        <div>
          <h3>Artists</h3>
          {subview(artistList)}
          <h3>Songs</h3>
          {subview(songList)}
          <h3>Albums</h3>
          {subview(albumList)}
          <h3>Playlists</h3>
          {subview(playlistList)}
        </div>
      </div>
    ),
    rules: _ => ({
      init: initRules.init,

      onAddArtist: event("~/on/add-artist").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const artist = ev.detail.value;

        const { self: id, instructions } = importEntity(artist, Artist);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { artists: id }));
      }),

      onAddSong: event("~/on/add-song").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const song = ev.detail.value;

        const { self: id, instructions } = importEntity(song, Song);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { songs: id }));
      }),

      onAddAlbum: event("~/on/add-album").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const album = ev.detail.value;

        const { self: id, instructions } = importEntity(album, Album);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { albums: id }));
      }),

      onAddPlaylist: event("~/on/add-playlist").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<SubmitEvent>(event);
          const playlist = ev.detail.value;
          cmd.add({ Import: playlist });
          cmd.add(...Transact.assert(self, { playlists: refer(playlist) }));
        },
      ),

      onEditItem: event("~/on/edit-item").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { focused: ev.detail.item }));
      }),

      onDeleteArtist: event("~/on/delete-artist").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { artists: ev.detail.item }));
        },
      ),

      onDeleteSong: event("~/on/delete-song").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { songs: ev.detail.item }));
        },
      ),

      onDeleteAlbum: event("~/on/delete-album").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { albums: ev.detail.item }));
        },
      ),

      onDeletePlaylist: event("~/on/delete-playlist").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { playlists: ev.detail.item }));
        },
      ),

      onCloseEditor: event("~/on/close-editor")
        .with(resolve(MusicLibrary.pick({ focused: true })))
        .transact(({ self, focused }, cmd) => {
          cmd.add(...Transact.remove(self, { focused }));
        }),

      renderArtistList: resolve(MusicLibrary.pick({ artists: true }))
        .update(({ self, artists }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/artist-list",
                (
                  <common-table
                    schema={Artist}
                    data={artists}
                    edit
                    delete
                    onedit="~/on/edit-item"
                    ondelete="~/on/delete-artist"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      renderSongList: resolve(MusicLibrary.pick({ songs: true }))
        .update(({ self, songs }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/song-list",
                (
                  <common-table
                    schema={Song}
                    data={songs}
                    edit
                    delete
                    onedit="~/on/edit-item"
                    ondelete="~/on/delete-song"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      renderAlbumList: resolve(MusicLibrary.pick({ albums: true }))
        .update(({ self, albums }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/album-list",
                (
                  <common-table
                    schema={Album}
                    data={albums}
                    edit
                    delete
                    onedit="~/on/edit-item"
                    ondelete="~/on/delete-album"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      renderPlaylistList: resolve(MusicLibrary.pick({ playlists: true }))
        .update(({ self, playlists }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/playlist-list",
                (
                  <common-table
                    schema={Playlist}
                    data={playlists}
                    edit
                    delete
                    onedit="~/on/edit-item"
                    ondelete="~/on/delete-playlist"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),
    }),
  },
);

console.log(musicLibrary);
