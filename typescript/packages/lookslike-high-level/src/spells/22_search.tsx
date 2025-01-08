import {
  h,
  Session,
  refer,
  select,
  $,
  behavior,
} from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, list, resolve } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { Album, Artist, Song } from "./18_music.jsx";
import { Spell } from "./19_process_manager.jsx";
import { Shader } from "./20_shader_editor.jsx";
import { StoredSchema } from "../sugar/sugar.jsx";

const MusicLibrary = z.object({
  focused: Ref.describe("The item that is currently being edited"),
  schemas: z.array(StoredSchema).describe("All schemas in the library"),
  artists: z.array(Artist).describe("All artists in the library"),
  songs: z.array(Song).describe("All songs in the library"),
  albums: z.array(Album).describe("All albums in the library"),
  spells: z.array(Spell).describe("All spells in the library"),
  shaders: z.array(Shader).describe("All shaders in the library"),
  "~/common/ui/schema-list": UiFragment.describe(
    "The UI fragment for the schemas list",
  ),
  "~/common/ui/item-list": UiFragment.describe(
    "The UI fragment for the items list",
  ),
  "~/common/ui/artist-list": UiFragment.describe(
    "The UI fragment for the artists list",
  ),
  "~/common/ui/song-list": UiFragment.describe(
    "The UI fragment for the songs list",
  ),
  "~/common/ui/album-list": UiFragment.describe(
    "The UI fragment for the albums list",
  ),
  "~/common/ui/spell-list": UiFragment.describe(
    "The UI fragment for the spells list",
  ),
  "~/common/ui/shader-list": UiFragment.describe(
    "The UI fragment for the shaders list",
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
      | z.infer<typeof Album>;
  };
};

function viewer(selection: string) {
  let selector = JSON.parse(selection);
  const replaced = {};
  for (const key in selector.select) {
    const value = selector.select[key];
    if (value && value["?"]) {
      if (value["?"].id == ($.self as any).id) {
        selector.select.self = $.self;
      } else {
        selector.select[key] = $["var" + value["?"].id];
      }
    }
  }

  selector.select.self = $.self;

  if (selector.where) {
    selector.where = selector.where.map(clause => {
      if (clause.Case) {
        return {
          Case: clause.Case.map(arg => {
            if (arg && arg["?"]) {
              if (arg["?"].id == ($.self as any).id) {
                return $.self;
              } else {
                return $["var" + arg["?"].id];
              }
            }
            return arg;
          }),
        };
      }
      return clause;
    });
  }

  const spell = behavior({
    render: {
      ...selector,
      update: (data: any) => {
        return [
          {
            Upsert: [
              data.self,
              "~/common/ui",
              <div>
                <common-card item={data} />
                <details>
                  <pre entity={data.self}>{JSON.stringify(data, null, 2)}</pre>
                </details>
              </div>,
            ],
          },
        ];
      },
    },
  });

  return spell;
}

export const search = typedBehavior(
  MusicLibrary.pick({
    "~/common/ui/schema-list": true,
    "~/common/ui/artist-list": true,
    "~/common/ui/song-list": true,
    "~/common/ui/album-list": true,
    "~/common/ui/spell-list": true,
    "~/common/ui/shader-list": true,
    "~/common/ui/item-list": true,
  }),
  {
    render: ({
      self,
      "~/common/ui/schema-list": schemaList,
      "~/common/ui/artist-list": artistList,
      "~/common/ui/song-list": songList,
      "~/common/ui/album-list": albumList,
      "~/common/ui/spell-list": spellList,
      "~/common/ui/shader-list": shaderList,
      "~/common/ui/item-list": itemList,
    }) => (
      <div entity={self} title="Search">
        <div>
          <h3>Schemas</h3>
          {subview(schemaList)}
          <h3>Items</h3>
          {subview(itemList)}
        </div>
      </div>
    ),
    rules: _ => ({
      init: initRules.init,

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

      renderSchemaList: list(StoredSchema)
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/schema-list",
                (
                  <common-table
                    schema={StoredSchema}
                    data={items}
                    edit
                    preview
                    onedit={"~/on/list-items"}
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      onListItems: event("~/on/list-items").transact(({ event, self }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { focused: ev.detail.item }));
      }),

      renderItemList: {
        select: {
          self: $.self,
          focused: {
            self: $.focused,
            name: $.typeName,
            selection: $.selection,
          },
          items: [
            {
              self: $.items,
            },
          ],
        },
        where: [
          { Case: [$.self, "focused", $.focused] },
          { Case: [$.items, "common/schema", $.focused] },
          { Case: [$.focused, "name", $.typeName] },
          { Case: [$.focused, "selection", $.selection] },
        ],
        update: ({ items, self, focused }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/item-list",
                (
                  <div>
                    <code>
                      {focused.name} <small>{focused.self.toString()}</small>
                    </code>
                    {/* <pre>{focused.selection}</pre> */}
                    <div style="display: grid; grid-template-columns: 1fr 1fr;">
                      {items.map(item => (
                        <Charm
                          self={item.self}
                          spell={viewer(focused.selection) as any}
                        />
                      ))}
                    </div>
                    <common-table
                      schema={z.object({ self: Ref })}
                      download
                      copy
                      data={items}
                    />
                  </div>
                ) as any,
              ],
            },
          ];
        },
      },

      renderArtistList: list(Artist)
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/artist-list",
                (<common-table schema={Artist} data={items} />) as any,
              ],
            },
          ];
        })
        .commit(),

      renderSongList: list(Song.omit({ artists: true }))
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/song-list",
                (
                  <common-table
                    schema={Song.omit({ artists: true })}
                    data={items}
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      renderAlbumList: list(Album)
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/album-list",
                (<common-table schema={Album} data={items} />) as any,
              ],
            },
          ];
        })
        .commit(),

      renderSpellList: list(Spell)
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/spell-list",
                (<common-table schema={Spell} data={items} />) as any,
              ],
            },
          ];
        })
        .commit(),

      renderShaderList: list(Shader)
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/shader-list",
                (<common-table schema={Shader} data={items} />) as any,
              ],
            },
          ];
        })
        .commit(),
    }),
  },
);

console.log(search);
