import {
  Cell,
  cell,
  derive,
  getRecipeEnvironment,
  h,
  handler,
  ID,
  JSONSchema,
  Mutable,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "commontools";

const Classification = {
  Unclassified: "unclassified",
  Confidential: "confidential",
  Secret: "secret",
  TopSecret: "topsecret",
} as const;

const ClassificationSecret = "secret";

// This is used by the various Google tokens created with tokenToAuthData
export const AuthSchema = {
  type: "object",
  properties: {
    token: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
    tokenType: { type: "string", default: "" },
    scope: { type: "array", items: { type: "string" }, default: [] },
    expiresIn: { type: "number", default: 0 },
    expiresAt: { type: "number", default: 0 },
    refreshToken: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
    user: {
      type: "object",
      properties: {
        email: { type: "string", default: "" },
        name: { type: "string", default: "" },
        picture: { type: "string", default: "" },
      },
    },
  },
} as const satisfies JSONSchema;

const env = getRecipeEnvironment();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ContactProperties = {
  resourceName: {
    type: "string",
    title: "Resource Name",
    description: "Unique identifier for the contact",
  },
  etag: {
    type: "string",
    title: "ETag",
    description: "Entity tag for the contact",
    default: "",
  },
  displayName: {
    type: "string",
    title: "Display Name",
    description: "Contact's display name",
    default: "",
  },
  givenName: {
    type: "string",
    title: "Given Name",
    description: "Contact's first name",
    default: "",
  },
  familyName: {
    type: "string",
    title: "Family Name",
    description: "Contact's last name",
    default: "",
  },
  middleName: {
    type: "string",
    title: "Middle Name",
    description: "Contact's middle name",
    default: "",
  },
  emails: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "Emails",
    description: "List of email addresses",
    default: [],
  },
  phoneNumbers: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
        canonicalForm: { type: "string" },
      },
    },
    title: "Phone Numbers",
    description: "List of phone numbers",
    default: [],
  },
  addresses: {
    type: "array",
    items: {
      type: "object",
      properties: {
        formattedValue: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
        streetAddress: { type: "string" },
        city: { type: "string" },
        region: { type: "string" },
        postalCode: { type: "string" },
        country: { type: "string" },
        countryCode: { type: "string" },
      },
    },
    title: "Addresses",
    description: "List of addresses",
    default: [],
  },
  organizations: {
    type: "array",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        department: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "Organizations",
    description: "List of organizations",
    default: [],
  },
  birthdays: {
    type: "array",
    items: {
      type: "object",
      properties: {
        date: {
          type: "object",
          properties: {
            year: { type: "number" },
            month: { type: "number" },
            day: { type: "number" },
          },
        },
        text: { type: "string" },
      },
    },
    title: "Birthdays",
    description: "List of birthdays",
    default: [],
  },
  photos: {
    type: "array",
    items: {
      type: "object",
      properties: {
        url: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            primary: { type: "boolean" },
            source: {
              type: "object",
              properties: {
                type: { type: "string" },
                id: { type: "string" },
              },
            },
          },
        },
      },
    },
    title: "Photos",
    description: "List of photos",
    default: [],
  },
  biographies: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        contentType: { type: "string" },
      },
    },
    title: "Biographies",
    description: "List of biographies",
    default: [],
  },
  ageRanges: {
    type: "array",
    items: {
      type: "object",
      properties: {
        ageRange: { type: "string" },
        metadata: { type: "object" },
      },
    },
    title: "Age Ranges",
    description: "Age range of the contact",
    default: [],
  },
  calendarUrls: {
    type: "array",
    items: {
      type: "object",
      properties: {
        url: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "Calendar URLs",
    description: "Calendar URLs for the contact",
    default: [],
  },
  clientData: {
    type: "array",
    items: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
    },
    title: "Client Data",
    description: "Client-specific data",
    default: [],
  },
  coverPhotos: {
    type: "array",
    items: {
      type: "object",
      properties: {
        url: { type: "string" },
        metadata: { type: "object" },
      },
    },
    title: "Cover Photos",
    description: "Cover photos",
    default: [],
  },
  events: {
    type: "array",
    items: {
      type: "object",
      properties: {
        date: {
          type: "object",
          properties: {
            year: { type: "number" },
            month: { type: "number" },
            day: { type: "number" },
          },
        },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "Events",
    description: "Important events",
    default: [],
  },
  externalIds: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "External IDs",
    description: "External identifiers",
    default: [],
  },
  genders: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        formattedValue: { type: "string" },
        addressMeAs: { type: "string" },
      },
    },
    title: "Genders",
    description: "Gender information",
    default: [],
  },
  imClients: {
    type: "array",
    items: {
      type: "object",
      properties: {
        username: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
        protocol: { type: "string" },
        formattedProtocol: { type: "string" },
      },
    },
    title: "IM Clients",
    description: "Instant messaging clients",
    default: [],
  },
  interests: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    title: "Interests",
    description: "Personal interests",
    default: [],
  },
  locales: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    title: "Locales",
    description: "Language locales",
    default: [],
  },
  locations: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
        current: { type: "boolean" },
        buildingId: { type: "string" },
        floor: { type: "string" },
        floorSection: { type: "string" },
        deskCode: { type: "string" },
      },
    },
    title: "Locations",
    description: "Physical locations",
    default: [],
  },
  memberships: {
    type: "array",
    items: {
      type: "object",
      properties: {
        contactGroupMembership: {
          type: "object",
          properties: {
            contactGroupId: { type: "string" },
            contactGroupResourceName: { type: "string" },
          },
        },
        domainMembership: {
          type: "object",
          properties: {
            inViewerDomain: { type: "boolean" },
          },
        },
      },
    },
    title: "Memberships",
    description: "Group memberships",
    default: [],
  },
  metadata: {
    type: "object",
    properties: {
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            id: { type: "string" },
            etag: { type: "string" },
            updateTime: { type: "string" },
          },
        },
        default: [],
      },
      previousResourceNames: {
        type: "array",
        items: { type: "string" },
        default: [],
      },
      linkedPeopleResourceNames: {
        type: "array",
        items: { type: "string" },
        default: [],
      },
      deleted: { type: "boolean", default: false },
      objectType: { type: "string", default: "" },
    },
    title: "Metadata",
    description: "Contact metadata",
    default: {},
  },
  miscKeywords: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "Keywords",
    description: "Miscellaneous keywords",
    default: [],
  },
  nicknames: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
      },
    },
    title: "Nicknames",
    description: "Nicknames",
    default: [],
  },
  occupations: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    title: "Occupations",
    description: "Occupations",
    default: [],
  },
  relations: {
    type: "array",
    items: {
      type: "object",
      properties: {
        person: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "Relations",
    description: "Relationships",
    default: [],
  },
  sipAddresses: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "SIP Addresses",
    description: "SIP addresses",
    default: [],
  },
  skills: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    title: "Skills",
    description: "Professional skills",
    default: [],
  },
  urls: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        type: { type: "string" },
        formattedType: { type: "string" },
      },
    },
    title: "URLs",
    description: "Web URLs",
    default: [],
  },
  userDefined: {
    type: "array",
    items: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
    },
    title: "User Defined",
    description: "User-defined fields",
    default: [],
  },
} as const;

const ContactSchema = {
  type: "object",
  properties: ContactProperties,
  required: [
    "resourceName",
    "etag",
    "displayName",
    "givenName",
    "familyName",
    "middleName",
    "emails",
    "phoneNumbers",
    "addresses",
    "organizations",
    "birthdays",
    "photos",
    "biographies",
    "ageRanges",
    "calendarUrls",
    "clientData",
    "coverPhotos",
    "events",
    "externalIds",
    "genders",
    "imClients",
    "interests",
    "locales",
    "locations",
    "memberships",
    "metadata",
    "miscKeywords",
    "nicknames",
    "occupations",
    "relations",
    "sipAddresses",
    "skills",
    "urls",
    "userDefined",
  ],
  ifc: { classification: [Classification.Confidential] },
} as const satisfies JSONSchema;
type Contact = Mutable<Schema<typeof ContactSchema>>;

type Auth = Schema<typeof AuthSchema>;

const PeopleImporterInputs = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "number of contacts to import",
          default: 100,
        },
        personFields: {
          type: "string",
          description: "comma-separated list of person fields to retrieve",
          default:
            "names,emailAddresses,phoneNumbers,photos,organizations,addresses,birthdays,biographies,ageRanges,calendarUrls,clientData,coverPhotos,events,externalIds,genders,imClients,interests,locales,locations,memberships,metadata,miscKeywords,nicknames,occupations,relations,sipAddresses,skills,urls,userDefined",
        },
      },
      required: ["limit", "personFields"],
    },
    auth: AuthSchema,
  },
  required: ["settings", "auth"],
  description: "Google People Importer",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    contacts: {
      type: "array",
      items: {
        type: "object",
        properties: ContactProperties,
      },
    },
  },
} as const satisfies JSONSchema;

const updateLimit = handler({
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
}, {
  type: "object",
  properties: { limit: { type: "number", asCell: true } },
  required: ["limit"],
}, ({ detail }, state) => {
  state.limit.set(parseInt(detail?.value ?? "100") || 0);
});

const updatePersonFields = handler({
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
}, {
  type: "object",
  properties: { personFields: { type: "string", asCell: true } },
  required: ["personFields"],
}, ({ detail }, state) => {
  state.personFields.set(
    detail?.value ?? "names,emailAddresses,phoneNumbers,photos",
  );
});

interface PeopleClientConfig {
  // How many times the client will retry after an HTTP failure
  retries?: number;
  // In milliseconds, the delay between making any subsequent requests due to failure.
  delay?: number;
  // In milliseconds, the amount to permanently increment to the `delay` on every 429 response.
  delayIncrement?: number;
}

class PeopleClient {
  private auth: Cell<Auth>;
  private retries: number;
  private delay: number;
  private delayIncrement: number;

  constructor(
    auth: Cell<Auth>,
    { retries = 3, delay = 1000, delayIncrement = 100 }: PeopleClientConfig =
      {},
  ) {
    this.auth = auth;
    this.retries = retries;
    this.delay = delay;
    this.delayIncrement = delayIncrement;
  }

  private async refreshAuth() {
    const body = {
      refreshToken: this.auth.get().refreshToken,
    };

    console.log("refreshAuthToken", body);

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error("Could not acquire a refresh token.");
    }
    const json = await res.json();
    const authData = json.tokenInfo as Auth;
    this.auth.update(authData);
  }

  async fetchContacts(
    pageSize: number = 100,
    personFields: string = "names,emailAddresses,phoneNumbers,photos",
    pageToken?: string,
  ): Promise<{ connections: any[]; nextPageToken?: string }> {
    const params = new URLSearchParams({
      pageSize: pageSize.toString(),
      personFields: personFields,
    });

    if (pageToken) {
      params.append("pageToken", pageToken);
    }

    const url = new URL(
      `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`,
    );

    const res = await this.googleRequest(url);
    const json = await res.json();

    if (!json || !("connections" in json) || !Array.isArray(json.connections)) {
      console.log(`No connections found in response: ${JSON.stringify(json)}`);
      return { connections: [] };
    }

    return {
      connections: json.connections,
      nextPageToken: json.nextPageToken,
    };
  }

  private async googleRequest(
    url: URL,
    _options?: RequestInit,
    _retries?: number,
  ): Promise<Response> {
    const token = this.auth.get().token;
    if (!token) {
      throw new Error("No authorization token.");
    }

    const retries = _retries ?? this.retries;
    const options = _options ?? {};
    options.headers = new Headers(options.headers);
    options.headers.set("Authorization", `Bearer ${token}`);

    const res = await fetch(url, options);
    const { ok, status, statusText } = res;

    // Allow all 2xx status
    if (ok) {
      console.log(`${url}: ${status} ${statusText}`);
      return res;
    }

    console.warn(
      `${url}: ${status} ${statusText}`,
      `Remaining retries: ${retries}`,
    );
    if (retries === 0) {
      throw new Error("Too many failed attempts.");
    }

    await sleep(this.delay);

    if (status === 401) {
      await this.refreshAuth();
    } else if (status === 429) {
      this.delay += this.delayIncrement;
      console.log(`Incrementing delay to ${this.delay}`);
      await sleep(this.delay);
    }
    return this.googleRequest(url, _options, retries - 1);
  }
}

const peopleUpdater = handler(
  {},
  {
    type: "object",
    properties: {
      contacts: {
        type: "array",
        items: ContactSchema,
        default: [],
        asCell: true,
      },
      auth: { ...AuthSchema, asCell: true },
      settings: PeopleImporterInputs.properties.settings,
    },
    required: ["contacts", "auth", "settings"],
  } as const satisfies JSONSchema,
  (_event, state) => {
    console.log("peopleUpdater!");

    if (!state.auth.get().token) {
      console.warn("no token found in auth cell");
      return;
    }

    process(
      state.auth,
      state.settings.limit,
      state.settings.personFields,
      state,
    ).catch((error) => {
      console.error("Error in peopleUpdater:", error);
    });
  },
);

function connectionToContact(connection: any): Contact | null {
  try {
    const contact: Contact = {
      resourceName: connection.resourceName,
      etag: connection.etag || "",
      displayName: "",
      givenName: "",
      familyName: "",
      middleName: "",
      emails: [],
      phoneNumbers: [],
      addresses: [],
      organizations: [],
      birthdays: [],
      photos: [],
      biographies: [],
      ageRanges: [],
      calendarUrls: [],
      clientData: [],
      coverPhotos: [],
      events: [],
      externalIds: [],
      genders: [],
      imClients: [],
      interests: [],
      locales: [],
      locations: [],
      memberships: [],
      metadata: {},
      miscKeywords: [],
      nicknames: [],
      occupations: [],
      relations: [],
      sipAddresses: [],
      skills: [],
      urls: [],
      userDefined: [],
    };

    // Process names
    if (connection.names && Array.isArray(connection.names)) {
      const primaryName = connection.names.find((name: any) =>
        name.metadata?.primary
      ) || connection.names[0];
      if (primaryName) {
        contact.displayName = primaryName.displayName || "";
        contact.givenName = primaryName.givenName || "";
        contact.familyName = primaryName.familyName || "";
        contact.middleName = primaryName.middleName || "";
      }
    }

    // Process emails
    if (connection.emailAddresses && Array.isArray(connection.emailAddresses)) {
      contact.emails = connection.emailAddresses.map((email: any) => ({
        value: email.value || "",
        type: email.type || "",
        formattedType: email.formattedType || "",
      }));
    }

    // Process phone numbers
    if (connection.phoneNumbers && Array.isArray(connection.phoneNumbers)) {
      contact.phoneNumbers = connection.phoneNumbers.map((phone: any) => ({
        value: phone.value || "",
        type: phone.type || "",
        formattedType: phone.formattedType || "",
        canonicalForm: phone.canonicalForm || "",
      }));
    }

    // Process addresses
    if (connection.addresses && Array.isArray(connection.addresses)) {
      contact.addresses = connection.addresses.map((address: any) => ({
        formattedValue: address.formattedValue || "",
        type: address.type || "",
        formattedType: address.formattedType || "",
        streetAddress: address.streetAddress || "",
        city: address.city || "",
        region: address.region || "",
        postalCode: address.postalCode || "",
        country: address.country || "",
        countryCode: address.countryCode || "",
      }));
    }

    // Process organizations
    if (connection.organizations && Array.isArray(connection.organizations)) {
      contact.organizations = connection.organizations.map((org: any) => ({
        name: org.name || "",
        title: org.title || "",
        department: org.department || "",
        type: org.type || "",
        formattedType: org.formattedType || "",
      }));
    }

    // Process birthdays
    if (connection.birthdays && Array.isArray(connection.birthdays)) {
      contact.birthdays = connection.birthdays.map((birthday: any) => ({
        date: birthday.date || {},
        text: birthday.text || "",
      }));
    }

    // Process photos
    if (connection.photos && Array.isArray(connection.photos)) {
      contact.photos = connection.photos.map((photo: any) => ({
        url: photo.url || "",
        metadata: photo.metadata || {},
      }));
    }

    // Process biographies
    if (connection.biographies && Array.isArray(connection.biographies)) {
      contact.biographies = connection.biographies.map((bio: any) => ({
        value: bio.value || "",
        contentType: bio.contentType || "",
      }));
    }

    // Process age ranges
    if (connection.ageRanges && Array.isArray(connection.ageRanges)) {
      contact.ageRanges = connection.ageRanges.map((ageRange: any) => ({
        ageRange: ageRange.ageRange || "",
        metadata: ageRange.metadata || {},
      }));
    }

    // Process calendar URLs
    if (connection.calendarUrls && Array.isArray(connection.calendarUrls)) {
      contact.calendarUrls = connection.calendarUrls.map((cal: any) => ({
        url: cal.url || "",
        type: cal.type || "",
        formattedType: cal.formattedType || "",
      }));
    }

    // Process client data
    if (connection.clientData && Array.isArray(connection.clientData)) {
      contact.clientData = connection.clientData.map((data: any) => ({
        key: data.key || "",
        value: data.value || "",
      }));
    }

    // Process cover photos
    if (connection.coverPhotos && Array.isArray(connection.coverPhotos)) {
      contact.coverPhotos = connection.coverPhotos.map((photo: any) => ({
        url: photo.url || "",
        metadata: photo.metadata || {},
      }));
    }

    // Process events
    if (connection.events && Array.isArray(connection.events)) {
      contact.events = connection.events.map((event: any) => ({
        date: event.date || {},
        type: event.type || "",
        formattedType: event.formattedType || "",
      }));
    }

    // Process external IDs
    if (connection.externalIds && Array.isArray(connection.externalIds)) {
      contact.externalIds = connection.externalIds.map((extId: any) => ({
        value: extId.value || "",
        type: extId.type || "",
        formattedType: extId.formattedType || "",
      }));
    }

    // Process genders
    if (connection.genders && Array.isArray(connection.genders)) {
      contact.genders = connection.genders.map((gender: any) => ({
        value: gender.value || "",
        formattedValue: gender.formattedValue || "",
        addressMeAs: gender.addressMeAs || "",
      }));
    }

    // Process IM clients
    if (connection.imClients && Array.isArray(connection.imClients)) {
      contact.imClients = connection.imClients.map((im: any) => ({
        username: im.username || "",
        type: im.type || "",
        formattedType: im.formattedType || "",
        protocol: im.protocol || "",
        formattedProtocol: im.formattedProtocol || "",
      }));
    }

    // Process interests
    if (connection.interests && Array.isArray(connection.interests)) {
      contact.interests = connection.interests.map((interest: any) => ({
        value: interest.value || "",
      }));
    }

    // Process locales
    if (connection.locales && Array.isArray(connection.locales)) {
      contact.locales = connection.locales.map((locale: any) => ({
        value: locale.value || "",
      }));
    }

    // Process locations
    if (connection.locations && Array.isArray(connection.locations)) {
      contact.locations = connection.locations.map((location: any) => ({
        value: location.value || "",
        type: location.type || "",
        current: location.current || false,
        buildingId: location.buildingId || "",
        floor: location.floor || "",
        floorSection: location.floorSection || "",
        deskCode: location.deskCode || "",
      }));
    }

    // Process memberships
    if (connection.memberships && Array.isArray(connection.memberships)) {
      contact.memberships = connection.memberships.map((membership: any) => ({
        contactGroupMembership: membership.contactGroupMembership || {},
        domainMembership: membership.domainMembership || {},
      }));
    }

    // Process metadata
    if (connection.metadata) {
      contact.metadata = {
        sources: connection.metadata.sources || [],
        previousResourceNames: connection.metadata.previousResourceNames || [],
        linkedPeopleResourceNames:
          connection.metadata.linkedPeopleResourceNames || [],
        deleted: connection.metadata.deleted || false,
        objectType: connection.metadata.objectType || "",
      };
    }

    // Process miscellaneous keywords
    if (connection.miscKeywords && Array.isArray(connection.miscKeywords)) {
      contact.miscKeywords = connection.miscKeywords.map((keyword: any) => ({
        value: keyword.value || "",
        type: keyword.type || "",
        formattedType: keyword.formattedType || "",
      }));
    }

    // Process nicknames
    if (connection.nicknames && Array.isArray(connection.nicknames)) {
      contact.nicknames = connection.nicknames.map((nickname: any) => ({
        value: nickname.value || "",
        type: nickname.type || "",
      }));
    }

    // Process occupations
    if (connection.occupations && Array.isArray(connection.occupations)) {
      contact.occupations = connection.occupations.map((occupation: any) => ({
        value: occupation.value || "",
      }));
    }

    // Process relations
    if (connection.relations && Array.isArray(connection.relations)) {
      contact.relations = connection.relations.map((relation: any) => ({
        person: relation.person || "",
        type: relation.type || "",
        formattedType: relation.formattedType || "",
      }));
    }

    // Process SIP addresses
    if (connection.sipAddresses && Array.isArray(connection.sipAddresses)) {
      contact.sipAddresses = connection.sipAddresses.map((sip: any) => ({
        value: sip.value || "",
        type: sip.type || "",
        formattedType: sip.formattedType || "",
      }));
    }

    // Process skills
    if (connection.skills && Array.isArray(connection.skills)) {
      contact.skills = connection.skills.map((skill: any) => ({
        value: skill.value || "",
      }));
    }

    // Process URLs
    if (connection.urls && Array.isArray(connection.urls)) {
      contact.urls = connection.urls.map((url: any) => ({
        value: url.value || "",
        type: url.type || "",
        formattedType: url.formattedType || "",
      }));
    }

    // Process user-defined fields
    if (connection.userDefined && Array.isArray(connection.userDefined)) {
      contact.userDefined = connection.userDefined.map((userField: any) => ({
        key: userField.key || "",
        value: userField.value || "",
      }));
    }

    return contact;
  } catch (error: any) {
    console.error(
      "Error processing connection:",
      "message" in error ? error.message : error,
    );
    return null;
  }
}

export async function process(
  auth: Cell<Auth>,
  limit: number = 100,
  personFields: string = "names,emailAddresses,phoneNumbers,photos",
  state: {
    contacts: Cell<Contact[]>;
  },
) {
  if (!auth.get()) {
    console.warn("no token");
    return;
  }

  const existingContactIds = new Set(
    state.contacts.get().map((contact) => contact.resourceName),
  );

  const client = new PeopleClient(auth);
  const allConnections: any[] = [];
  let pageToken: string | undefined;
  let totalFetched = 0;

  // Fetch contacts with pagination
  while (totalFetched < limit) {
    // People API max is 1000, but we'll use 100 for safety
    const pageSize = Math.min(100, limit - totalFetched);

    try {
      await sleep(1000); // Rate limiting
      const { connections, nextPageToken } = await client.fetchContacts(
        pageSize,
        personFields,
        pageToken,
      );

      if (connections.length === 0) {
        break;
      }

      allConnections.push(...connections);
      totalFetched += connections.length;
      pageToken = nextPageToken;

      if (!pageToken) {
        break;
      }
    } catch (error: any) {
      console.error(
        "Error fetching contacts:",
        "message" in error ? error.message : error,
      );
      break;
    }
  }

  // Filter out existing contacts
  const newConnections = allConnections.filter(
    (connection: { resourceName: string }) =>
      !existingContactIds.has(connection.resourceName),
  );

  if (newConnections.length === 0) {
    console.log("No new contacts to import");
    return;
  }

  // Convert connections to contacts
  const contacts = newConnections
    .map(connectionToContact)
    .filter((contact): contact is Contact => contact !== null);

  if (contacts.length > 0) {
    console.log(`Adding ${contacts.length} new contacts`);
    contacts.forEach((contact) => {
      contact[ID] = contact.resourceName;
    });
    state.contacts.push(...contacts);
  } else {
    console.log("No contacts could be processed");
  }

  console.log(
    "Successfully processed",
    allConnections.length,
    "connections total",
  );
}

const clearContacts = handler(
  {},
  {
    type: "object",
    properties: {
      contacts: {
        type: "array",
        items: ContactSchema,
        default: [],
        asCell: true,
      },
    },
    required: ["contacts"],
  },
  (_event, state) => {
    state.contacts.set([]);
  },
);

export default recipe(
  PeopleImporterInputs,
  ResultSchema,
  ({ settings, auth }) => {
    const contacts = cell<Contact[]>([]);

    derive(contacts, (contacts) => {
      console.log("contacts", contacts.length);
    });

    return {
      [NAME]: str`Google People Importer ${
        derive(auth, (auth) => auth?.user?.email || "unauthorized")
      }`,
      [UI]: (
        <div style="display: flex; gap: 10px; flex-direction: column; padding: 25px;">
          <h2 style="font-size: 20px; font-weight: bold;">
            {auth?.user?.email}
          </h2>
          <h2 style="font-size: 20px; font-weight: bold;">
            Imported contact count: {derive(contacts, (contacts) =>
              contacts.length)}
          </h2>

          <common-hstack gap="sm">
            <common-vstack gap="sm">
              <div>
                <label>Import Limit</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.limit}
                  placeholder="number of contacts to import"
                  oncommon-input={updateLimit({ limit: settings.limit })}
                />
              </div>

              <div>
                <label>Person Fields</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.personFields}
                  placeholder="names,emailAddresses,phoneNumbers,photos"
                  oncommon-input={updatePersonFields({
                    personFields: settings.personFields,
                  })}
                />
              </div>
              <common-button
                onClick={peopleUpdater({ contacts, auth, settings })}
              >
                Fetch Contacts
              </common-button>
              <common-button
                onClick={clearContacts({ contacts })}
              >
                Clear Contacts
              </common-button>
            </common-vstack>
          </common-hstack>
          <common-google-oauth
            $auth={auth}
            scopes={[
              "email",
              "profile",
              "https://www.googleapis.com/auth/contacts.readonly",
            ]}
          />

          <div style="margin: 15px 0;">
            <div style="font-size: 14px; color: #666;">
              {derive(contacts, (allContacts) =>
                `Showing ${allContacts.length} contact${
                  allContacts.length !== 1 ? "s" : ""
                }`)}
            </div>
          </div>

          <div style="overflow-x: auto;">
            <table style="border-collapse: collapse; font-size: 14px;">
              <thead>
                <tr style="background-color: #f5f5f5;">
                  <th style="padding: 10px; position: sticky; left: 0; background-color: #f5f5f5; z-index: 1;">
                    PHOTO
                  </th>
                  <th style="padding: 10px;">NAME</th>
                  <th style="padding: 10px;">RESOURCE NAME</th>
                  <th style="padding: 10px;">EMAILS</th>
                  <th style="padding: 10px;">PHONE NUMBERS</th>
                  <th style="padding: 10px;">ORGANIZATIONS</th>
                  <th style="padding: 10px;">ADDRESSES</th>
                  <th style="padding: 10px;">BIRTHDAYS</th>
                  <th style="padding: 10px;">BIOGRAPHIES</th>
                  <th style="padding: 10px;">AGE RANGES</th>
                  <th style="padding: 10px;">CALENDAR URLS</th>
                  <th style="padding: 10px;">EVENTS</th>
                  <th style="padding: 10px;">GENDERS</th>
                  <th style="padding: 10px;">IM CLIENTS</th>
                  <th style="padding: 10px;">INTERESTS</th>
                  <th style="padding: 10px;">NICKNAMES</th>
                  <th style="padding: 10px;">OCCUPATIONS</th>
                  <th style="padding: 10px;">RELATIONS</th>
                  <th style="padding: 10px;">SKILLS</th>
                  <th style="padding: 10px;">URLS</th>
                  <th style="padding: 10px;">LOCALES</th>
                  <th style="padding: 10px;">ETAG</th>
                </tr>
              </thead>
              <tbody>
                {derive(contacts, (allContacts) =>
                  allContacts.map((contact) => (
                    <tr style="vertical-align: top;">
                      <td style="border: 1px solid #ddd; padding: 10px; position: sticky; left: 0; background-color: white; z-index: 1;">
                        {derive(contact, (contact) => {
                          const primaryPhoto = contact?.photos?.find((p) =>
                            p.metadata?.primary
                          ) || contact?.photos?.[0];
                          return primaryPhoto?.url
                            ? (
                              <img
                                src={primaryPhoto.url}
                                alt={contact.displayName}
                                style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;"
                              />
                            )
                            : (
                              <div style="width: 40px; height: 40px; border-radius: 50%; background: #ddd; display: flex; align-items: center; justify-content: center; font-weight: bold;">
                                {contact.displayName?.[0] || "?"}
                              </div>
                            );
                        })}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 200px;">
                        <div>
                          <strong>
                            {contact.displayName || "(No display name)"}
                          </strong>
                          {derive(contact, (contact) => {
                            const parts = [];
                            if (contact.givenName) {
                              parts.push(`Given: ${contact.givenName}`);
                            }
                            if (contact.middleName) {
                              parts.push(`Middle: ${contact.middleName}`);
                            }
                            if (contact.familyName) {
                              parts.push(`Family: ${contact.familyName}`);
                            }
                            return parts.length > 0
                              ? (
                                <div style="font-size: 0.85em; color: #666; margin-top: 4px;">
                                  {parts.map((part, idx) => (
                                    <div key={idx}>{part}</div>
                                  ))}
                                </div>
                              )
                              : null;
                          })}
                        </div>
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; font-size: 0.85em; color: #666; word-break: break-all; max-width: 200px;">
                        {contact.resourceName}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 200px;">
                        {derive(contact, (contact) =>
                          contact?.emails?.length > 0
                            ? (
                              contact.emails.map((email, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  <div>{email.value}</div>
                                  {(email.type || email.formattedType) && (
                                    <div style="color: #666; font-size: 0.85em;">
                                      {email.formattedType || email.type}
                                    </div>
                                  )}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No emails</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 180px;">
                        {derive(contact, (contact) =>
                          contact?.phoneNumbers?.length > 0
                            ? (
                              contact.phoneNumbers.map((phone, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  <div>{phone.value}</div>
                                  {(phone.type || phone.formattedType) && (
                                    <div style="color: #666; font-size: 0.85em;">
                                      {phone.formattedType || phone.type}
                                    </div>
                                  )}
                                  {phone.canonicalForm &&
                                    phone.canonicalForm !== phone.value && (
                                    <div style="color: #888; font-size: 0.8em;">
                                      Canonical: {phone.canonicalForm}
                                    </div>
                                  )}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No phones</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 200px;">
                        {derive(contact, (contact) =>
                          contact?.organizations?.length > 0
                            ? (
                              contact.organizations.map((org, idx) => (
                                <div
                                  key={idx}
                                  style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: idx < contact.organizations.length - 1 ? '1px solid #eee' : 'none';"
                                >
                                  {org.name && (
                                    <div style="font-weight: 500;">
                                      {org.name}
                                    </div>
                                  )}
                                  {org.title && (
                                    <div style="font-size: 0.9em;">
                                      {org.title}
                                    </div>
                                  )}
                                  {org.department && (
                                    <div style="font-size: 0.85em; color: #666;">
                                      Dept: {org.department}
                                    </div>
                                  )}
                                  {(org.type || org.formattedType) && (
                                    <div style="font-size: 0.85em; color: #888;">
                                      {org.formattedType || org.type}
                                    </div>
                                  )}
                                </div>
                              ))
                            )
                            : (
                              <span style="color: #999;">No organizations</span>
                            ))}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 250px;">
                        {derive(contact, (contact) =>
                          contact?.addresses?.length > 0
                            ? (
                              contact.addresses.map((addr, idx) => (
                                <div
                                  key={idx}
                                  style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: idx < contact.addresses.length - 1 ? '1px solid #eee' : 'none';"
                                >
                                  {addr.formattedValue && (
                                    <div style="margin-bottom: 4px;">
                                      {addr.formattedValue}
                                    </div>
                                  )}
                                  <div style="font-size: 0.85em; color: #666;">
                                    {addr.streetAddress && (
                                      <div>Street: {addr.streetAddress}</div>
                                    )}
                                    {addr.city && <div>City: {addr.city}</div>}
                                    {addr.region && (
                                      <div>Region: {addr.region}</div>
                                    )}
                                    {addr.postalCode && (
                                      <div>Postal: {addr.postalCode}</div>
                                    )}
                                    {addr.country && (
                                      <div>Country: {addr.country}</div>
                                    )}
                                    {addr.countryCode && (
                                      <div>Code: {addr.countryCode}</div>
                                    )}
                                  </div>
                                  {(addr.type || addr.formattedType) && (
                                    <div style="font-size: 0.85em; color: #888; margin-top: 2px;">
                                      {addr.formattedType || addr.type}
                                    </div>
                                  )}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No addresses</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 120px;">
                        {derive(contact, (contact) =>
                          contact?.birthdays?.length > 0
                            ? (
                              contact.birthdays.map((birthday, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  {birthday.text ||
                                    (birthday.date && (
                                      <div>
                                        {birthday.date.month ||
                                          "?"}/{birthday.date.day || "?"}
                                        {birthday.date.year &&
                                          `/${birthday.date.year}`}
                                      </div>
                                    )) ||
                                    <span style="color: #999;">No date</span>}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No birthdays</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 200px; max-width: 300px;">
                        {derive(contact, (contact) =>
                          contact?.biographies?.length > 0
                            ? (
                              contact.biographies.map((bio, idx) => (
                                <div key={idx} style="margin-bottom: 8px;">
                                  <div style="font-size: 0.9em; white-space: pre-wrap; word-break: break-word;">
                                    {bio.value}
                                  </div>
                                  {bio.contentType && (
                                    <div style="font-size: 0.85em; color: #666; margin-top: 2px;">
                                      Type: {bio.contentType}
                                    </div>
                                  )}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No biographies</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 120px;">
                        {derive(contact, (contact) =>
                          contact?.ageRanges?.length > 0
                            ? (
                              contact.ageRanges.map((age, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  {age.ageRange}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No age ranges</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 200px;">
                        {derive(contact, (contact) =>
                          contact?.calendarUrls?.length > 0
                            ? (
                              contact.calendarUrls.map((cal, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  <a
                                    href={cal.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style="color: #0066cc;"
                                  >
                                    {cal.formattedType || cal.type ||
                                      "Calendar"}
                                  </a>
                                </div>
                              ))
                            )
                            : (
                              <span style="color: #999;">No calendar URLs</span>
                            ))}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 150px;">
                        {derive(contact, (contact) =>
                          contact?.events?.length > 0
                            ? (
                              contact.events.map((event, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  <div>{event.formattedType || event.type}</div>
                                  {event.date && (
                                    <div style="font-size: 0.85em; color: #666;">
                                      {event.date.month || "?"}/
                                      {event.date.day || "?"}
                                      {event.date.year && `/${event.date.year}`}
                                    </div>
                                  )}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No events</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 120px;">
                        {derive(contact, (contact) =>
                          contact?.genders?.length > 0
                            ? (
                              contact.genders.map((gender, idx) => (
                                <div key={idx}>
                                  {gender.formattedValue || gender.value}
                                  {gender.addressMeAs && (
                                    <div style="font-size: 0.85em; color: #666;">
                                      Address as: {gender.addressMeAs}
                                    </div>
                                  )}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No gender info</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 180px;">
                        {derive(contact, (contact) =>
                          contact?.imClients?.length > 0
                            ? (
                              contact.imClients.map((im, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  <div>{im.username}</div>
                                  <div style="font-size: 0.85em; color: #666;">
                                    {im.formattedProtocol || im.protocol}
                                    {im.formattedType &&
                                      ` - ${im.formattedType}`}
                                  </div>
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No IM clients</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 150px;">
                        {derive(contact, (contact) =>
                          contact?.interests?.length > 0
                            ? (
                              contact.interests.map((interest, idx) => (
                                <div key={idx} style="margin-bottom: 2px;">
                                  {interest.value}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No interests</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 120px;">
                        {derive(contact, (contact) =>
                          contact?.nicknames?.length > 0
                            ? (
                              contact.nicknames.map((nickname, idx) => (
                                <div key={idx} style="margin-bottom: 2px;">
                                  {nickname.value}
                                  {nickname.type && (
                                    <span style="font-size: 0.85em; color: #666;">
                                      {` (${nickname.type})`}
                                    </span>
                                  )}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No nicknames</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 150px;">
                        {derive(contact, (contact) =>
                          contact?.occupations?.length > 0
                            ? (
                              contact.occupations.map((occupation, idx) => (
                                <div key={idx} style="margin-bottom: 2px;">
                                  {occupation.value}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No occupations</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 180px;">
                        {derive(contact, (contact) =>
                          contact?.relations?.length > 0
                            ? (
                              contact.relations.map((relation, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  <div>{relation.person}</div>
                                  <div style="font-size: 0.85em; color: #666;">
                                    {relation.formattedType || relation.type}
                                  </div>
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No relations</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 150px;">
                        {derive(contact, (contact) =>
                          contact?.skills?.length > 0
                            ? (
                              contact.skills.map((skill, idx) => (
                                <div key={idx} style="margin-bottom: 2px;">
                                  {skill.value}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No skills</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 200px;">
                        {derive(contact, (contact) =>
                          contact?.urls?.length > 0
                            ? (
                              contact.urls.map((url, idx) => (
                                <div key={idx} style="margin-bottom: 4px;">
                                  <a
                                    href={url.value}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style="color: #0066cc; word-break: break-all;"
                                  >
                                    {url.formattedType || url.type || url.value}
                                  </a>
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No URLs</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; min-width: 100px;">
                        {derive(contact, (contact) =>
                          contact?.locales?.length > 0
                            ? (
                              contact.locales.map((locale, idx) => (
                                <div key={idx}>
                                  {locale.value}
                                </div>
                              ))
                            )
                            : <span style="color: #999;">No locales</span>)}
                      </td>
                      <td style="border: 1px solid #ddd; padding: 10px; font-size: 0.8em; color: #888; word-break: break-all; max-width: 150px;">
                        {contact.etag || "(No etag)"}
                      </td>
                    </tr>
                  )))}
              </tbody>
            </table>
          </div>
        </div>
      ),
      contacts,
    };
  },
);
