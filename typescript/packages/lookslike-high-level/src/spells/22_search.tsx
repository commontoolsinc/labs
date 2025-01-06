import {
  h,
  Session,
  refer,
  select,
  $,
} from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, list, resolve } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { Album, Artist, Song } from "./18_music.jsx";
import { Spell } from './19_process_manager.jsx'
import { Shader } from './20_shader_editor.jsx'

const MusicLibrary = z.object({
  focused: Ref.describe("The item that is currently being edited"),
  artists: z.array(Artist).describe("All artists in the library"),
  songs: z.array(Song).describe("All songs in the library"),
  albums: z.array(Album).describe("All albums in the library"),
  spells: z.array(Spell).describe("All spells in the library"),
  shaders: z.array(Shader).describe("All shaders in the library"),
  '~/common/ui/artist-list': UiFragment.describe("The UI fragment for the artists list"),
  '~/common/ui/song-list': UiFragment.describe("The UI fragment for the songs list"),
  '~/common/ui/album-list': UiFragment.describe("The UI fragment for the albums list"),
  '~/common/ui/spell-list': UiFragment.describe("The UI fragment for the spells list"),
  '~/common/ui/shader-list': UiFragment.describe("The UI fragment for the shaders list"),
})

type EditEvent = {
  detail: { item: Reference }
};

type SubmitEvent = {
  detail: { value: z.infer<typeof Artist> | z.infer<typeof Song> | z.infer<typeof Album> }
};

export const search = typedBehavior(
  MusicLibrary.pick({
    '~/common/ui/artist-list': true,
    '~/common/ui/song-list': true,
    '~/common/ui/album-list': true,
    '~/common/ui/spell-list': true,
    '~/common/ui/shader-list': true,
  }), {
  render: ({ self, '~/common/ui/artist-list': artistList, '~/common/ui/song-list': songList, '~/common/ui/album-list': albumList, '~/common/ui/spell-list': spellList, '~/common/ui/shader-list': shaderList }) => (
    <div entity={self} title='Search'>
      <div>
        <h3>Artists</h3>
        {subview(artistList)}
        <h3>Songs</h3>
        {subview(songList)}
        <h3>Albums</h3>
        {subview(albumList)}
        <h3>Spells</h3>
        {subview(spellList)}
        <h3>Shaders</h3>
        {subview(shaderList)}
      </div>
    </div>
  ),
  rules: _ => ({
    init: initRules.init,

    onEditItem: event("~/on/edit-item")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { focused: ev.detail.item }))
      }),

    onDeleteArtist: event("~/on/delete-artist")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { artists: ev.detail.item }))
      }),

    onDeleteSong: event("~/on/delete-song")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { songs: ev.detail.item }))
      }),

    onDeleteAlbum: event("~/on/delete-album")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { albums: ev.detail.item }))
      }),

    onDeletePlaylist: event("~/on/delete-playlist")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { playlists: ev.detail.item }))
      }),

    onCloseEditor: event("~/on/close-editor")
      .with(resolve(MusicLibrary.pick({ focused: true })))
      .transact(({ self, focused }, cmd) => {
        cmd.add(...Transact.remove(self, { focused }))
      }),

    renderArtistList: list(Artist)
      .update(({ items, self }) => {
        return [{
          Upsert: [self, '~/common/ui/artist-list', <common-table
            schema={Artist}
            data={items}
            onedit="~/on/edit-item"
            ondelete="~/on/delete-artist"
          /> as any]
        }]
      }).commit(),

    renderSongList: list(Song.omit({ artists: true }))
      .update(({ items, self }) => {
        return [{
          Upsert: [self, '~/common/ui/song-list', <common-table
            schema={Song.omit({ artists: true })}
            data={items}
            onedit="~/on/edit-item"
            ondelete="~/on/delete-song"
          /> as any]
        }]
      }).commit(),

    renderAlbumList: list(Album)
      .update(({ items, self }) => {
        return [{
          Upsert: [self, '~/common/ui/album-list', <common-table
            schema={Album}
            data={items}
            onedit="~/on/edit-item"
            ondelete="~/on/delete-album"
          /> as any]
        }]
      }).commit(),

    renderSpellList: list(Spell)
      .update(({ items, self }) => {
        return [{
          Upsert: [self, '~/common/ui/spell-list', <common-table
            schema={Spell}
            data={items}
            onedit="~/on/edit-item"
            ondelete="~/on/delete-spell"
          /> as any]
        }]
      }).commit(),

    renderShaderList: list(Shader)
      .update(({ items, self }) => {
        return [{
          Upsert: [self, '~/common/ui/shader-list', <common-table
            schema={Shader}
            data={items}
            onedit="~/on/edit-item"
            ondelete="~/on/delete-shader"
          /> as any]
        }]
      }).commit(),
  }),
});

console.log(search)
