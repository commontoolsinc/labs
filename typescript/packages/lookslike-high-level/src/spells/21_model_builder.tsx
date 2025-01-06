import {
  h,
  Session,
  refer,
  $,
  select,
} from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { llm, RESPONSE } from "../effects/fetch.jsx";

const CODE_REQUEST = '~/schema/generation-request';
const DIAGRAM_REQUEST = '~/schema/diagram-request';

const EXAMPLE_SCHEMA = `
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
  `

function grabTs(result: string) {
  if (!result) {
    return;
  }
  const code = result.match(/```ts\n([\s\S]+?)```/)?.[1];
  if (!code) {
    console.error("No TypeScript found in text", result);
    return;
  }
  return code;
}

function grabMermaid(result: string) {
  if (!result) {
    return;
  }
  const diagram = result.match(/```mermaid\n([\s\S]+?)```/)?.[1];
  if (!diagram) {
    console.error("No Mermaid diagram found in text", result);
    return;
  }
  return diagram;
}

const DomainModel = z.object({
  description: z.string().min(1).max(8192).describe("Description of the problem domain"),
});

const SchemaGenerator = z.object({
  description: z.string().default('').describe("The current problem description"),
  generatedCode: z.string().default('').describe("The generated schema code"),
  mermaidDiagram: z.string().default('').describe("The ER diagram of the schema")
});

type SubmitEvent<T> = {
  detail: { value: T }
};

export const schemaGenerator = typedBehavior(SchemaGenerator, {
  render: ({ self, description, generatedCode, mermaidDiagram }) => (
    <div entity={self} title="Domain Model Generator">
      <h3>Domain Model Generator</h3>
      <common-form
        schema={DomainModel}
        value={{ description: description || '' }}
        onsubmit="~/on/generate"
      />

      {generatedCode && (
        <div style="display: flex; gap: 2rem;">
          <div style="flex: 1;">
            <h4>Generated Schema</h4>
            <os-code-editor
              language="text/x.typescript"
              source={generatedCode}
            />
          </div>
          {mermaidDiagram && (
            <div style="flex: 1;">
              <h4>ER Diagram</h4>
              <common-mermaid diagram={mermaidDiagram} />
              <details>
                <pre>{mermaidDiagram}</pre>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  ),
  rules: _ => ({
    onGenerate: event("~/on/generate")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof DomainModel>>>(event);
        const message = `Imagine a basic database schema for managing the information in this explanation:
          <description>${ev.detail.value.description}</description>

          Model the core entities and relationships in the domain and actions that could be taken on them (as stubbed function signatures).

          Return TypeScript code defining the schemas, wrapped in code blocks.`;

        cmd.add(...Transact.set(self, { description: ev.detail.value.description }));
        cmd.add(llm(self, CODE_REQUEST, {
          messages: [{ role: 'user', content: message }, { role: 'assistant', content: '```ts\n' }],
          system: `Generate the minimal Zod schema that model the described domain in typescript. Include as much in the schema as you can and leave minimal code comments.

          Never model the user themselves, only model the entities managed by the theoretical domain model.

          Relationships are unidirectional and should be represented as such. e.g. if many items can be in many lists, the lists just need an items array, items can have a lists array optionally but it's only for convenience.

          This will also include a main "app" schema that acts as the entry point to the all the other data, as per this "music library" example:

          ${EXAMPLE_SCHEMA}

          Return only the TypeScript code wrapped in code blocks. Do not bloat the model without the user indicating interest.`,
          model: 'groq:llama-3.3-70b-specdec'
        }).json());
      }),

    onGenerationComplete: select({
      self: $.self,
      request: $.request,
      payload: $.payload,
      content: $.content,
    })
      .match($.self, CODE_REQUEST, $.request)
      .match($.request, RESPONSE.JSON, $.payload)
      .match($.payload, "content", $.content)
      .transact(({ self, request, content, payload }, cmd) => {
        const code = grabTs(content)

        cmd.add({ Retract: [self, CODE_REQUEST, request] })
        cmd.add({ Retract: [request, RESPONSE.JSON, payload] })
        if (code) {
          cmd.add(...Transact.set(self, { generatedCode: code }))

          // Generate ER diagram
          const diagramMessage = `Generate a Mermaid class diagram for the following Zod schema:
            ${code}

            Represent only the core types, relationships and the essential operations, do not add services or any implementation details. Stay focused on the domain model.

            Return only the Mermaid diagram wrapped in code blocks.`;

          cmd.add(llm(self, DIAGRAM_REQUEST, {
            messages: [{ role: 'user', content: diagramMessage }, { role: 'assistant', content: '```mermaid\n' }],
            system: `
              \`\`\`mermaid
              classDiagram
                  %% Class Definition
                  class Animal {
                      +String name
                      -Int age
                      #String color
                      +makeSound() void
                      +move()*
                  }

                  %% Relationships
                  ClassA --|> ClassB : Inheritance
                  ClassC --* ClassD : Composition
                  ClassE --o ClassF : Aggregation
                  ClassG --> ClassH : Association
                  ClassI ..> ClassJ : Dependency
                  ClassK ..|> ClassL : Realization

                  %% Cardinality/Multiplicity
                  ClassM "1" --> "*" ClassN
                  ClassO "1" --> "1" ClassP
                  ClassQ "1" --> "0..1" ClassR

                  %% Enums
                  class Status {
                      <<enumeration>>
                      PENDING
                      ACTIVE
                      CLOSED
                  }

                  %% Generic Types
                  class List~T~ {
                      +add(item T) void
                      +get(index int) T
                  }

                  %% Methods
                  class Operations {
                      +create(data) bool
                      +read(id) string
                      -update(id, data)* void
                      #delete(id) bool
                  }
              \`\`\`

              Key Points:
              1. Access Modifiers:
                 + public
                 - private
                 # protected
                 ~ package/internal

              2. Method Types:
                 Normal: methodName()
                 Abstract: methodName()*
                 Static: $methodName()

              3. Stereotypes:
                 <<interface>>
                 <<enumeration>>
                 <<abstract>>
                 <<service>>

              4. Valid Relationship Types:
                 --|> Inheritance
                 --* Composition
                 --o Aggregation
                 --> Association
                 ..> Dependency
                 ..|> Implementation

            Return only the Mermaid diagram wrapped in code blocks.

            Do not show any operations or actions on the diagram.`,
            model: 'groq:llama-3.3-70b-specdec'
          }).json());
        }
      }),

    onDiagramComplete: select({
      self: $.self,
      request: $.request,
      payload: $.payload,
      content: $.content,
    })
      .match($.self, DIAGRAM_REQUEST, $.request)
      .match($.request, RESPONSE.JSON, $.payload)
      .match($.payload, "content", $.content)
      .transact(({ self, request, content, payload }, cmd) => {
        const diagram = grabMermaid(content)

        cmd.add({ Retract: [self, DIAGRAM_REQUEST, request] })
        cmd.add({ Retract: [request, RESPONSE.JSON, payload] })
        if (diagram) {
          cmd.add(...Transact.set(self, { mermaidDiagram: diagram }))
        }
      })
  })
});

console.log(schemaGenerator);
