let apiKey = localStorage.getItem("apiKey");

if (!apiKey) {
  // Prompt the user for the API key if it doesn't exist
  const userApiKey = prompt("Please enter your API key:");

  if (userApiKey) {
    // Save the API key in localStorage
    localStorage.setItem("apiKey", userApiKey);
    apiKey = userApiKey;
  } else {
    // Handle the case when the user cancels or doesn't provide an API key
    alert("API key not provided. Some features may not work.");
  }
}

const x = `
CREATE TABLE "CodexTag"
(
    Id          text            not null,
    Title       text            not null,
    Category    text default '' not null,
    Description text default '' not null,
    Notes       text
)

CREATE TABLE "Dialogue" ("Id" text NOT NULL,"Speaker" text NOT NULL, "Fx" text, "Message" text NOT NULL, "Context" text, PRIMARY KEY (id))

CREATE TABLE NamePair
(
    Id      integer            not null
        constraint NamePair_pk
            primary key autoincrement,
    Name    TEXT               not null,
    Title   TEXT    default "" not null,
    Enabled integer default 1  not null
)

CREATE TABLE UnitAugmentation
(
    Id                     integer           not null
        constraint UnitAugmentation_pk
            primary key autoincrement,
    Name                   TEXT              not null,
    Description            TEXT              not null,
    Valence                TEXT CHECK(Valence IN ('Positive', 'Negative', 'Neutral')),
    IntensityMultiplier    REAL    default 1 not null,
    AtkIntensityMultiplier REAL    default 0 not null,
    DefIntensityMultiplier REAL    default 0 not null,
    SklIntensityMultiplier REAL    default 0 not null,
    AtkBase                integer default 0 not null,
    DefBase                integer default 0 not null,
    SklBase                integer default 0 not null
, "Enabled" int NOT NULL DEFAULT '1')

CREATE TABLE "UnitCodex"
(
    Id               text            not null
        primary key,
    Title            text            not null,
    Category         text            not null,
    Description      text            not null,
    SkillDescription text default '' not null,
    Notes            text
)

CREATE TABLE "UnitTrait"
(
    Name        TEXT
        unique,
    Valence     TEXT,
    Description TEXT                     not null,
    Enabled     INTEGER default '0'      not null,
    Pack        TEXT    default 'Secret' not null,
    DisplayName TEXT    default Name     not null,
    Level       integer default 0        not null,
    ElementMask integer default 0        not null,
    PromotionId TEXT    default NULL,
    Tag         TEXT    default NULL,
    check (Valence IN ('Positive', 'Negative', 'Neutral'))
)
`;

const system = `
<task>
  Weaver generates user interfaces on demand using web technology. Weaver takes a user request and a SQLite schema and determines the best way to service it using sql.js and a bespoke user-interface based on the user's needs. Weaver then generates the HTML, CSS and Javascript needed to display the requested content in an iframe.
  Weaver will output the full HTML, CSS and Javascript as one file, designed to be run in an iframe.
</task>

  <sqlite_schema>
  ${x}
  </sqlite_schema>

  Act as Weaver to fulfill the following user_request.
`;

function prompt(message) {
  return `
  Act as Weaver to fulfill the following user_request. Include a file input to select the .sqlite3 file to load.

  <dependencies>
    <script type="text/javascript" src="https://cdn.jsdelivr.net/npm/sql.js@1.4.0/dist/"></script>

    <script type="text/javascript">
    dbFileInput.onchange = async function() {
      const file = dbFileInput.files[0];
      dbFileName = file.name;
      const fileReader = new FileReader();

      fileReader.onload = async function() {
        const SQL = await initSqlJs({
          locateFile: file => \`https://cdn.jsdelivr.net/npm/sql.js@1.4.0/dist/\${file}\`
        });

        db = new SQL.Database(new Uint8Array(fileReader.result));
        filterDialogue();
      };

      fileReader.readAsArrayBuffer(file);
    };
    </script>
  </dependencies>

  <user_request>${message}</user_request>
  Generated Code:

  Give NO commentary, NO explanations, just the code.
  <generated_code>
  `;
}

export async function sendPrompt(message, last) {
  let systemPrompt = system;
  if (last) {
    systemPrompt += " " + `<prev_generated_code>${last}</prev_generated_code>`;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    body: JSON.stringify({
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt(message) }],
      model: "claude-3-opus-20240229",
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  const data = await res.json();
  console.log(data);
  return data.content[0].text;
}
