import {
  h,
  Session,
  refer,
  $,
  Task,
  select,
} from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm as CharmComponent, initRules, typedBehavior, typedService } from "./spell.jsx";
import { z } from "zod";
import { fromString, Reference } from "merkle-reference";
import { importEntity, resolve, tagWithSchema } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { tsToExports } from "../localBuild.js";
import { sendMessage } from "./stickers/chat.jsx";
import { llm, RESPONSE } from "../effects/fetch.jsx";

const adjectives = ['indigo', 'azure', 'crimson', 'emerald', 'golden', 'silver', 'obsidian', 'sapphire'];
const nouns = ['crossfire', 'thunder', 'storm', 'blade', 'phoenix', 'dragon', 'whisper', 'shadow'];

const CODE_REQUEST = '~/spell/modification-request';

function grabJs(result: string) {
  if (!result) {
    return;
  }
  const html = result.match(/```js\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No JS found in text", result);
    return;
  }
  return html;
}

const generateIdentifier = () => {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective}-${noun}`;
};

// Define the core schemas
export const Spell = z.object({
  name: z.string().min(1).max(255).describe("The name of the spell"),
  sourceCode: z.string().min(1).max(8192).describe("The spell's source code"),
  notes: z.string().describe("Notes about the spell"),
  instances: z.array(Ref).describe("References to charm instances of this spell")
});

const Charm = z.object({
  spell: Ref.describe("Reference to the spell this charm instantiates"),
  name: z.string().min(1).max(255).describe("The name of the charm"),
});

const CharmInstance = z.object({ charm: Ref })

const SpellManager = z.object({
  editingSpell: Ref.describe("The spell currently being edited"),
  focusedCharm: Ref.describe("The charm that is currently being viewed"),
  spells: z.array(Spell.omit({ instances: true })).describe("All spells in the system"),
  charms: z.array(Charm).describe("All charm instances"),
  '~/common/ui/spell-list': UiFragment.describe("The UI fragment for the spells list"),
  '~/common/ui/charm-list': UiFragment.describe("The UI fragment for the charms list")
});

const SourceModificationPrompt = z.object({
  prompt: z.string().min(1).max(1000).describe("Prompt for modifying source code"),
  sourceId: Ref.describe("Reference to the spell to modify")
});

type SubmitEvent<T> = {
  detail: { value: T }
};

type FocusEvent = {
  detail: { charmId: Reference }
};

type EditEvent = {
  detail: { item: Reference }
};

const CharmWithSpell = z.object({
  spell: Spell.omit({ instances: true }).describe("Reference to the spell this charm instantiates")
});

export const charmViewer = typedService(CharmWithSpell, {
  rules: _ => ({
    renderCharm: {
      select: {
        self: $.self,
        spell: {
          self: $.spell,
          name: $.name,
          sourceCode: $.sourceCode
        }
      },
      where: [
        { Case: [$.self, 'spell', $.spell] },
        { Case: [$.spell, `sourceCode`, $.sourceCode] },
        { Case: [$.spell, `name`, $.name] },
      ],
      *perform({
        self,
        spell: { name, sourceCode }
      }: {
        self: Reference;
        spell: { name: string; sourceCode: string };
      }) {
        const compiled = yield* Task.wait(tsToExports(sourceCode));
        console.log(compiled);

        const child = refer({
          parent: self,
          compiled: compiled.exports.spell.id,
          time: Date.now(),
        });

        return [
          {
            Upsert: [
              self,
              "~/common/ui",
              <div entity={self}>
                <common-charm
                  id={child.toString()}
                  key={child.toString()}
                  spell={() => compiled.exports.spell}
                  entity={() => child}
                ></common-charm>
              </div> as any,
            ],
          },
        ];
      },
    }
  })
});

const spellEditor = typedBehavior(Spell, {
  render: ({ self, name, sourceCode, notes }) => (
    <div entity={self}>
      <common-form
        schema={Spell.omit({ instances: true })}
        value={{ name, sourceCode, notes }}
        onsubmit="~/on/save"
      />
      <h4>Modify with AI</h4>
      <common-form
        schema={SourceModificationPrompt}
        value={{ sourceId: self }}
        reset
        onsubmit="~/on/modify-with-ai"
      />
      <details>
        <pre>{JSON.stringify({ name, sourceCode, notes }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Spell>>>(event);
        const spell = ev.detail.value;
        cmd.add(...Transact.set(self, spell))
        cmd.add(tagWithSchema(self, Spell))
      }),

    onModifyWithAI: event("~/on/modify-with-ai")
      .with(resolve(Spell.pick({ sourceCode: true, notes: true })))
      .transact(({ self, event, sourceCode, notes }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof SourceModificationPrompt>>>(event);
        const message = `Modify the attached source code based on the following prompt:
          <context>${notes}</context>
          <modification>${ev.detail.value.prompt}</modification>

          \`\`\`js\n${sourceCode}\n\`\`\``;

        cmd.add(llm(self, CODE_REQUEST, {
          messages: [{ role: 'user', content: message }, { role: 'assistant', content: '```js\n' }],
          system: `

          Here is a library of Spells that you should refer to while modifying the code:

          <hello-world>
          import { h, $, behavior, select } from "@commontools/common-system";
          import { event, events } from "../sugar.js";

          const HelloWorldEvent = events({
            onAlert: '~/on/alert',
          })

          const styles = {
            container: "border: 3px solid #ff69b4; border-radius: 25px; padding: 20px; background: #fff0f5; text-align: center;",
            heading: "color: #ff1493; font-family: cursive;",
            text: "color: #ff69b4; font-size: 18px;",
            button: "background: #ff69b4; color: white; border: none; padding: 10px 20px; border-radius: 15px; font-size: 16px; cursor: pointer; transition: all 0.3s;"
          };

          const spell = behavior({
            view: select({ self: $.self })
              .render(({ self }) => {
                return <div entity={self} title="Hello World" style={styles.container}>
                  <h1 style={styles.heading}>Hello World</h1>
                  <p style={styles.text}>This is a charm.</p>
                  <button type="button" style={styles.button} onclick={HelloWorldEvent.onAlert}>Click me</button>
                </div>
              })
              .commit(),

            onClick: event(HelloWorldEvent.onAlert)
              .update(({ self }) => {
                alert('Hello from ' + self.toString());
                return [];
              })
              .commit()
          });

          export const spawn = (source: {} = { hello: 1 }) => spell.spawn(source, "Hello World");
          </hello-world>

          <counter>
          import { h, behavior, $, select, Session } from "@commontools/common-system";
          import { event, events, set, subview } from "../sugar.js";
          import { description, Description } from "./stickers/describe.jsx";
          import { mixin } from "../sugar/mixin.js";
          import { Chattable, chatUiResolver } from "./stickers/chat.jsx";

          const resolveEmpty = select({ self: $.self }).not(q => q.match($.self, "clicks", $._));

          const resolveClicks = select({ self: $.self, clicks: $.clicks }).match(
            $.self,
            "clicks",
            $.clicks,
          );

          const CounterEvent = events({
            onReset: "~/on/reset",
            onClick: "~/on/click",
          });

          const styles = {
            container: 'display: flex; flex-direction: column; align-items: center; padding: 20px; background: linear-gradient(45deg, #1a1a1a, #2d2d2d); border-radius: 10px; color: #fff; box-shadow: 0 4px 6px rgba(0,0,0,0.1);',
            clicks: 'font-size: 48px; font-weight: bold; color: #0ff; text-shadow: 0 0 10px rgba(0,255,255,0.5); margin: 10px 0;',
            button: 'background: #333; color: #fff; border: 2px solid #0ff; padding: 10px 20px; margin: 5px; border-radius: 5px; cursor: pointer; transition: all 0.3s; font-family: monospace;',
            description: 'font-family: monospace; color: #0ff; margin: 15px 0; text-align: center;'
          }

          export const rules = behavior({
            ...mixin(
              Description(
                ["clicks"],
                (self: any) =>
                  \`Come up with a pun based on this counter value: ${self.clicks}. Respond with just the pun directly.\`,
              ),
            ),

            ...mixin(Chattable({
              attributes: ["clicks"],
              greeting: '-',
              systemPrompt: ({ clicks }) => \`The current counter is at: \${clicks}?\`,
            })),

            init: resolveEmpty.update(({ self }) => set(self, { clicks: 0 })).commit(),

            viewCount: resolveClicks
              .with(description)
              .with(chatUiResolver)
              .render(({ clicks, self, llmDescription, chatView }) => {
                return (
                  <div title={\`Clicks \${clicks}\`} entity={self} style={styles.container}>
                    <div style={styles.clicks}>{clicks}</div>
                    <div>
                      <button style={styles.button} onclick={CounterEvent.onClick}>Click me!</button>
                      <button style={styles.button} onclick={CounterEvent.onReset}>Reset</button>
                    </div>
                    <p style={styles.description}>{llmDescription}</p>
                    {subview(chatView)}
                  </div>
                );
              })
              .commit(),

            onReset: event(CounterEvent.onReset)
              .update(({ self }) => set(self, { clicks: 0 }))
              .commit(),

            onClick: event(CounterEvent.onClick)
              .with(resolveClicks)
              .update(({ self, clicks }) => set(self, { clicks: clicks + 1 }))
              .commit(),
          });

          rules.disableRule('chat/view' as any)

          export const spawn = (source: {} = { counter: 34 }) =>
            rules.spawn(source, "Counter");

          </counter>

          <music-library>
          import {
            h,
            Session,
            refer,
          } from "@commontools/common-system";
          import { event, subview, Transact } from "../sugar.js";
          import { Charm, initRules, typedBehavior } from "./spell.jsx";
          import { z } from "zod";
          import { Reference } from "merkle-reference";
          import { importEntity, resolve } from "../sugar/sugar.jsx";
          import { Ref, UiFragment } from "../sugar/zod.js";

          const Artist = z.object({
            name: z.string().min(1).max(255).describe("The name of the artist"),
          });

          const Song = z.object({
            title: z.string().min(1).max(255).describe("The title of the song"),
            artists: z.array(Artist).min(1).describe("The artists who performed the song"),
            duration: z.number().min(1).describe("The duration in seconds"),
            year: z.number().min(1900).max(2100).describe("The release year")
          });

          const Album = z.object({
            "album/title": z.string().min(1).max(255).describe("The album title"),
            artist: Artist.describe("The primary artist"),
            songs: z.array(Song).min(1).describe("The songs on the album"),
            year: z.number().min(1900).max(2100).describe("The release year")
          });

          const Playlist = z.object({
            name: z.string().min(1).max(255).describe("The playlist name"),
            description: z.string().max(1000).describe("The playlist description"),
            songs: z.array(Song).describe("The songs in the playlist")
          });

          const MusicLibrary = z.object({
            focused: Ref.describe("The item that is currently being edited"),
            artists: z.array(Artist).describe("All artists in the library"),
            songs: z.array(Song).describe("All songs in the library"),
            albums: z.array(Album).describe("All albums in the library"),
            playlists: z.array(Playlist).describe("All playlists in the library"),
            '~/common/ui/artist-list': UiFragment.describe("The UI fragment for the artists list"),
            '~/common/ui/song-list': UiFragment.describe("The UI fragment for the songs list"),
            '~/common/ui/album-list': UiFragment.describe("The UI fragment for the albums list"),
            '~/common/ui/playlist-list': UiFragment.describe("The UI fragment for the playlists list")
          })

          type EditEvent = {
            detail: { item: Reference }
          };

          type SubmitEvent = {
            detail: { value: z.infer<typeof Artist> | z.infer<typeof Song> | z.infer<typeof Album> | z.infer<typeof Playlist> }
          };

          const artistEditor = typedBehavior(Artist, {
            render: ({ self, name }) => (
              <div entity={self}>
                <common-form
                  schema={Artist}
                  value={{ name }}
                  onsubmit="~/on/save"
                />
                <details>
                  <pre>{JSON.stringify({ name }, null, 2)}</pre>
                </details>
              </div>
            ),
            rules: _ => ({
              onSave: event("~/on/save")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const artist = ev.detail.value;
                  cmd.add(...Transact.set(self, artist))
                }),
            })
          });

          const songEditor = typedBehavior(Song, {
            render: ({ self, title, artists, duration, year }) => (
              <div entity={self}>
                <common-form
                  schema={Song}
                  value={{ title, artists, duration, year }}
                  referenceFields={new Set(['artists'])}
                  onsubmit="~/on/save"
                />
                <details>
                  <pre>{JSON.stringify({ title, artists, duration, year }, null, 2)}</pre>
                </details>
              </div>
            ),
            rules: _ => ({
              onSave: event("~/on/save")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const song = ev.detail.value;
                  cmd.add(...Transact.set(self, song))
                }),
            })
          });

          const albumEditor = typedBehavior(Album, {
            render: ({ self, title, artist, songs, year }) => (
              <div entity={self}>
                <common-form
                  schema={Album}
                  value={{ title, artist, songs, year }}
                  referenceFields={new Set(['artist', 'songs'])}
                  onsubmit="~/on/save"
                />
                <details>
                  <pre>{JSON.stringify({ title, artist, songs, year }, null, 2)}</pre>
                </details>
              </div>
            ),
            rules: _ => ({
              onSave: event("~/on/save")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const album = ev.detail.value;
                  cmd.add(...Transact.set(self, album))
                }),
            })
          });

          const playlistEditor = typedBehavior(Playlist, {
            render: ({ self, name, description, songs }) => (
              <div entity={self}>
                <common-form
                  schema={Playlist}
                  value={{ name, description, songs }}
                  referenceFields={new Set(['songs'])}
                  onsubmit="~/on/save"
                />
                <details>
                  <pre>{JSON.stringify({ name, description, songs }, null, 2)}</pre>
                </details>
              </div>
            ),
            rules: _ => ({
              onSave: event("~/on/save")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const playlist = ev.detail.value;
                  cmd.add(...Transact.set(self, playlist))
                }),
            })
          });

          export const musicLibrary = typedBehavior(
            MusicLibrary.pick({
              focused: true,
              '~/common/ui/artist-list': true,
              '~/common/ui/song-list': true,
              '~/common/ui/album-list': true,
              '~/common/ui/playlist-list': true
            }), {
            render: ({ self, focused, '~/common/ui/artist-list': artistList, '~/common/ui/song-list': songList, '~/common/ui/album-list': albumList, '~/common/ui/playlist-list': playlistList }) => (
              <div entity={self}>
                <div>
                  {focused ? (
                    <div>
                      <button onclick="~/on/close-editor">Close</button>
                      <Charm self={focused} spell={songEditor as any} />
                    </div>
                  ) : (
                    <div>
                      <h3>Add Artist</h3>
                      <common-form
                        schema={Artist}
                        reset
                        onsubmit="~/on/add-artist"
                      />
                      <h3>Add Song</h3>
                      <common-form
                        schema={Song}
                        referenceFields={new Set(['artists'])}
                        reset
                        onsubmit="~/on/add-song"
                      />
                      <h3>Add Album</h3>
                      <common-form
                        schema={Album}
                        referenceFields={new Set(['artist', 'songs'])}
                        reset
                        onsubmit="~/on/add-album"
                      />
                      <h3>Add Playlist</h3>
                      <common-form
                        schema={Playlist}
                        referenceFields={new Set(['songs'])}
                        reset
                        onsubmit="~/on/add-playlist"
                      />
                    </div>
                  )}
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

              onAddArtist: event("~/on/add-artist")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const artist = ev.detail.value;

                  const { self: id, instructions } = importEntity(artist, Artist)
                  cmd.add(...instructions);
                  cmd.add(...Transact.assert(self, { artists: id }));
                }),

              onAddSong: event("~/on/add-song")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const song = ev.detail.value;

                  const { self: id, instructions } = importEntity(song, Song)
                  cmd.add(...instructions);
                  cmd.add(...Transact.assert(self, { songs: id }));
                }),

              onAddAlbum: event("~/on/add-album")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const album = ev.detail.value;

                  const { self: id, instructions } = importEntity(album, Album)
                  cmd.add(...instructions);
                  cmd.add(...Transact.assert(self, { albums: id }));
                }),

              onAddPlaylist: event("~/on/add-playlist")
                .transact(({ self, event }, cmd) => {
                  const ev = Session.resolve<SubmitEvent>(event);
                  const playlist = ev.detail.value;
                  cmd.add({ Import: playlist })
                  cmd.add(...Transact.assert(self, { playlists: refer(playlist) }))
                }),

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

              renderArtistList: resolve(MusicLibrary.pick({ artists: true }))
                .update(({ self, artists }) => {
                  return [{
                    Upsert: [self, '~/common/ui/artist-list', <common-table
                      schema={Artist}
                      data={artists}
                      onedit="~/on/edit-item"
                      ondelete="~/on/delete-artist"
                    /> as any]
                  }]
                }).commit(),

              renderSongList: resolve(MusicLibrary.pick({ songs: true }))
                .update(({ self, songs }) => {
                  return [{
                    Upsert: [self, '~/common/ui/song-list', <common-table
                      schema={Song}
                      data={songs}
                      onedit="~/on/edit-item"
                      ondelete="~/on/delete-song"
                    /> as any]
                  }]
                }).commit(),

              renderAlbumList: resolve(MusicLibrary.pick({ albums: true }))
                .update(({ self, albums }) => {
                  return [{
                    Upsert: [self, '~/common/ui/album-list', <common-table
                      schema={Album}
                      data={albums}
                      onedit="~/on/edit-item"
                      ondelete="~/on/delete-album"
                    /> as any]
                  }]
                }).commit(),

              renderPlaylistList: resolve(MusicLibrary.pick({ playlists: true }))
                .update(({ self, playlists }) => {
                  return [{
                    Upsert: [self, '~/common/ui/playlist-list', <common-table
                      schema={Playlist}
                      data={playlists}
                      onedit="~/on/edit-item"
                      ondelete="~/on/delete-playlist"
                    /> as any]
                  }]
                }).commit(),
            }),
          });

          console.log(musicLibrary)

          </music-library>

          Return the code in full.`,
        }).json());
      }),

    onModificationComplete: select({
      self: $.self,
      request: $.request,
      payload: $.payload,
      content: $.content,
    })
      .match($.self, CODE_REQUEST, $.request)
      .match($.request, RESPONSE.JSON, $.payload)
      .match($.payload, "content", $.content)
      .transact(({ self, request, content, payload }, cmd) => {
        const code = grabJs(content)

        cmd.add({ Retract: [self, CODE_REQUEST, request] })
        cmd.add({ Retract: [request, RESPONSE.JSON, payload] })
        if (code) {
          cmd.add(...Transact.set(self, { sourceCode: code }))
        }
      })
  })
});

export const spellManager = typedBehavior(
  SpellManager.pick({
    editingSpell: true,
    focusedCharm: true,
    '~/common/ui/spell-list': true,
    '~/common/ui/charm-list': true
  }), {
  render: ({ self, editingSpell, focusedCharm, '~/common/ui/spell-list': spellList, '~/common/ui/charm-list': charmList }) => (
    <div entity={self} title="Spell Manager">
      <div>
        <details>
          <h3>Create New Spell</h3>
          <common-form
            schema={Spell.omit({ instances: true })}
            reset
            onsubmit="~/on/add-spell"
          />

          <h3>Instantiate Charm</h3>
          <common-form
            schema={Charm.omit({ name: true })}
            referenceFields={new Set(['spell'])}
            reset
            onsubmit="~/on/create-charm"
          />

          <h3>Focus Charm</h3>
          <common-form
            schema={CharmInstance}
            referenceFields={new Set(['charm'])}
            reset
            onsubmit="~/on/focus-charm"
          />
        </details>
      </div>

      {editingSpell && (
        <div>
          <h3>Edit Spell</h3>
          <button onclick="~/on/close-spell-editor">Close</button>
          <CharmComponent self={editingSpell} spell={spellEditor as any} />
        </div>
      )}

      {focusedCharm && (
        <div>
          <h3>Focused Charm</h3>
          <button onclick="~/on/unfocus-charm">Close</button>
          <CharmComponent self={focusedCharm} spell={charmViewer as any} />
        </div>
      )}

      <div>
        <h3>Spells</h3>
        {subview(spellList)}
        <h3>Charms</h3>
        {subview(charmList)}
      </div>
    </div>
  ),
  rules: _ => ({
    init: initRules.init,

    onAddSpell: event("~/on/add-spell")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Spell>>>(event);
        const spell = { ...ev.detail.value };

        const { self: id, instructions } = importEntity(spell, Spell)
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { spells: id }));
      }),

    onCreateCharm: event("~/on/create-charm")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Charm>>>(event);
        const charm = ev.detail.value as { spell: Reference };
        (charm as any).name = generateIdentifier();

        const { self: charmId, instructions } = importEntity(charm, Charm);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { charms: charmId }));

        if (charm.spell) {
          cmd.add(...Transact.assert(charm.spell, { instances: charmId }));
        }
      }),

    onFocusCharm: event("~/on/focus-charm")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof CharmInstance>>>(event);
        if (ev.detail.value.charm) {
          const charm = (ev.detail.value.charm)
          cmd.add(...Transact.set(self, { focusedCharm: charm }));
        }
      }),

    onEditSpell: event("~/on/edit-spell")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { editingSpell: ev.detail.item }))
      }),

    onCloseSpellEditor: event("~/on/close-spell-editor")
      .with(resolve(SpellManager.pick({ editingSpell: true })))
      .transact(({ self, editingSpell }, cmd) => {
        cmd.add(...Transact.remove(self, { editingSpell }))
      }),

    onUnfocusCharm: event("~/on/unfocus-charm")
      .with(resolve(SpellManager.pick({ focusedCharm: true })))
      .transact(({ self, focusedCharm }, cmd) => {
        cmd.add(...Transact.remove(self, { focusedCharm }))
      }),

    renderSpellList: resolve(SpellManager.pick({ spells: true }))
      .update(({ self, spells }) => {
        return [{
          Upsert: [self, '~/common/ui/spell-list', <common-table
            schema={Spell}
            data={spells}
            onedit="~/on/edit-spell"
            ondelete="~/on/delete-spell"
          /> as any]
        }]
      }).commit(),

    renderCharmList: resolve(SpellManager.pick({ charms: true }))
      .update(({ self, charms }) => {
        return [{
          Upsert: [self, '~/common/ui/charm-list', <common-table
            schema={Charm}
            data={charms}
            ondelete="~/on/delete-charm"
          /> as any]
        }]
      }).commit(),

    onDeleteSpell: event("~/on/delete-spell")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { spells: ev.detail.item }))
      }),

    onDeleteCharm: event("~/on/delete-charm")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { charms: ev.detail.item }))
      }),
  }),
});

console.log(spellManager);
