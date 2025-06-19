import { derive, h, JSONSchema, NAME, recipe, str, UI } from "commontools";

// Simplified contact schema - only the fields we need for list display
const ContactSchema = {
  type: "object",
  properties: {
    resourceName: {
      type: "string",
      title: "Resource Name",
      description: "Unique identifier for the contact",
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
        },
      },
      title: "Phone Numbers",
      description: "List of phone numbers",
      default: [],
    },
    organizations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          title: { type: "string" },
        },
      },
      title: "Organizations",
      description: "List of organizations",
      default: [],
    },
  },
  required: ["resourceName"],
} as const satisfies JSONSchema;

// Define the list item schema that matches the general pattern
const ListItemSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "The title of the list item",
    },
    // Include the original contact as metadata
    contact: ContactSchema,
  },
  required: ["title", "contact"],
} as const satisfies JSONSchema;

// Input Schema
const PeopleListInputSchema = {
  type: "object",
  properties: {
    contacts: {
      type: "array",
      items: ContactSchema,
      default: [],
    },
    settings: {
      type: "object",
      properties: {
        titleFormat: {
          type: "string",
          enum: ["display-name", "full-name", "name-email", "name-org"],
          default: "display-name",
          description: "Format for the list item title",
        },
        includeEmail: {
          type: "boolean",
          default: false,
          description: "Include primary email in title",
        },
        includePhone: {
          type: "boolean",
          default: false,
          description: "Include primary phone in title",
        },
      },
      default: {
        titleFormat: "display-name",
        includeEmail: false,
        includePhone: false,
      },
      required: ["titleFormat", "includeEmail", "includePhone"],
    },
  },
  required: ["contacts", "settings"],
  description: "People List - Transforms contacts into a standard list format",
} as const satisfies JSONSchema;

// Output Schema
const PeopleListOutputSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Title of the list",
    },
    items: {
      type: "array",
      items: ListItemSchema,
      description: "List items with title field",
    },
  },
  required: ["title", "items"],
} as const satisfies JSONSchema;

export default recipe(
  PeopleListInputSchema,
  PeopleListOutputSchema,
  ({ contacts, settings }) => {
    // Transform contacts into list items with title field
    // NOTE: Need to wrap in derive to access reactive values  
    const items = derive([contacts, settings], ([ctcts, stngs]) =>
      ctcts.map((contact) => {
        // Build title based on settings
        const titleParts = [];
        
        // Get primary email and phone
        const primaryEmail = contact.emails?.[0]?.value || "";
        const primaryPhone = contact.phoneNumbers?.[0]?.value || "";
        const primaryOrg = contact.organizations?.[0];
        
        // Format title based on selected format
        switch (stngs.titleFormat) {
          case "display-name":
            titleParts.push(contact.displayName || contact.givenName || contact.familyName || "Unnamed Contact");
            break;
          case "full-name":
            if (contact.givenName) titleParts.push(contact.givenName);
            if (contact.familyName) titleParts.push(contact.familyName);
            if (titleParts.length === 0) {
              titleParts.push(contact.displayName || "Unnamed Contact");
            }
            break;
          case "name-email":
            titleParts.push(contact.displayName || contact.givenName || contact.familyName || "Unnamed Contact");
            if (primaryEmail) {
              titleParts.push(`<${primaryEmail}>`);
            }
            break;
          case "name-org":
            titleParts.push(contact.displayName || contact.givenName || contact.familyName || "Unnamed Contact");
            if (primaryOrg) {
              if (primaryOrg.name) {
                titleParts.push(`(${primaryOrg.name})`);
              }
              if (primaryOrg.title) {
                titleParts.push(`- ${primaryOrg.title}`);
              }
            }
            break;
        }
        
        // Optionally add email and phone
        if (stngs.includeEmail && primaryEmail && stngs.titleFormat !== "name-email") {
          titleParts.push(`[${primaryEmail}]`);
        }
        if (stngs.includePhone && primaryPhone) {
          titleParts.push(`📞 ${primaryPhone}`);
        }
        
        const title = titleParts.join(" ");
        
        return {
          title,
          contact, // Include full contact as metadata
        };
      })
    );
    
    // Count contacts
    const contactCount = derive(contacts, (contacts) => contacts?.length || 0);
    
    // Create list title
    const listTitle = derive(
      contactCount,
      (count) => `People List (${count} contacts)`
    );
    
    const includeEmailLabel = derive(settings.includeEmail, (includeEmail) => {
      if (includeEmail) {
        return "Yes";
      } else {
        return "No";
      }
    });
    
    const includePhoneLabel = derive(settings.includePhone, (includePhone) => {
      if (includePhone) {
        return "Yes";
      } else {
        return "No";
      }
    });
    
    return {
      [NAME]: listTitle,
      [UI]: (
        <os-container>
          <h2>People List</h2>
          
          <div>
            <p>
              Transforms contacts into a standard list format with a "title" field
              for compatibility with other list-based recipes.
            </p>
          </div>
          
          <div>
            <h3>Settings</h3>
            <div>
              <label>Title Format:</label>
              <span>{str`${settings.titleFormat}`}</span>
            </div>
            <div>
              <label>Include Email:</label>
              <span>{includeEmailLabel}</span>
            </div>
            <div>
              <label>Include Phone:</label>
              <span>{includePhoneLabel}</span>
            </div>
          </div>
          
          <div>
            <h3>Transformed Items ({contactCount})</h3>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Display Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Organization</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr>
                    <td>{str`${item.title}`}</td>
                    <td>{str`${item.contact.displayName || "-"}`}</td>
                    <td>{str`${item.contact.emails?.[0]?.value || "-"}`}</td>
                    <td>{str`${item.contact.phoneNumbers?.[0]?.value || "-"}`}</td>
                    <td>{str`${item.contact.organizations?.[0]?.name || "-"}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </os-container>
      ),
      title: listTitle,
      items,
    };
  },
);