/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  recipe,
  UI,
} from "commontools";

/**
 * iPhone-Style Contacts Pattern
 *
 * Features:
 * - Alphabetically sorted contact list with section headers
 * - Search filtering
 * - Detail view for viewing/editing contacts
 * - Add new contacts
 * - Delete contacts
 * - Apple iOS design language
 */

interface Contact {
  id: string;
  firstName: string;
  lastName: Default<string, "">;
  phone: Default<string, "">;
  email: Default<string, "">;
  company: Default<string, "">;
  notes: Default<string, "">;
}

interface Input {
  contacts: Default<Contact[], []>;
}

// Apple iOS Colors
const colors = {
  blue: "#007AFF",
  red: "#FF3B30",
  green: "#34C759",
  background: "#f2f2f7",
  cardBg: "#ffffff",
  text: "#1c1c1e",
  secondaryText: "#8e8e93",
  separator: "#c6c6c8",
};

// Generate consistent color from name
function getAvatarColor(name: string): string {
  const avatarColors = [
    "#007AFF",
    "#34C759",
    "#FF9500",
    "#AF52DE",
    "#FF3B30",
    "#5856D6",
    "#FF2D55",
    "#00C7BE",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

// Get initials from name
function getInitials(firstName: string, lastName: string): string {
  const first = firstName?.trim()?.[0]?.toUpperCase() || "";
  const last = lastName?.trim()?.[0]?.toUpperCase() || "";
  return first + last || "?";
}

// Get full name
function getFullName(firstName: string, lastName: string): string {
  return [firstName, lastName].filter(Boolean).join(" ") || "No Name";
}

// Generate unique ID
function generateId(): string {
  return `contact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default recipe<Input, Input>("gContacts", ({ contacts }) => {
  // UI State
  const searchQuery = cell("");
  const viewMode = cell<"list" | "detail" | "add">("list");
  const selectedContactId = cell<string>("");

  // Form state for adding contacts
  const newFirstName = cell("");
  const newLastName = cell("");
  const newPhone = cell("");
  const newEmail = cell("");
  const newCompany = cell("");
  const newNotes = cell("");

  // Derive sorted and filtered contacts
  const sortedContacts = derive(contacts, (list: Contact[]) => {
    return [...(list || [])].sort((a, b) => {
      const nameA = getFullName(a.firstName, a.lastName).toLowerCase();
      const nameB = getFullName(b.firstName, b.lastName).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  });

  const filteredContacts = derive(
    { sortedContacts, searchQuery },
    ({
      sortedContacts: list,
      searchQuery: query,
    }: {
      sortedContacts: Contact[];
      searchQuery: string;
    }) => {
      if (!query?.trim()) return list;
      const q = query.toLowerCase();
      return list.filter((c) => {
        const fullName = getFullName(c.firstName, c.lastName).toLowerCase();
        return (
          fullName.includes(q) ||
          c.phone?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.company?.toLowerCase().includes(q)
        );
      });
    },
  );

  const contactCount = derive(contacts, (list: Contact[]) => list?.length || 0);

  // Get selected contact
  const selectedContact = derive(
    { contacts, selectedContactId },
    ({
      contacts: list,
      selectedContactId: id,
    }: {
      contacts: Contact[];
      selectedContactId: string;
    }) => {
      return (list || []).find((c) => c.id === id) || null;
    },
  );

  // Pre-computed detail view values (null-safe)
  const detailDisplayName = derive(selectedContact, (c: Contact | null) =>
    c ? getFullName(c.firstName, c.lastName) : "",
  );
  const detailInitials = derive(selectedContact, (c: Contact | null) =>
    c ? getInitials(c.firstName, c.lastName) : "?",
  );
  const detailAvatarColor = derive(selectedContact, (c: Contact | null) =>
    c ? getAvatarColor(getFullName(c.firstName, c.lastName)) : colors.blue,
  );
  const detailCompany = derive(
    selectedContact,
    (c: Contact | null) => c?.company || "",
  );
  const detailPhone = derive(
    selectedContact,
    (c: Contact | null) => c?.phone || "",
  );
  const detailEmail = derive(
    selectedContact,
    (c: Contact | null) => c?.email || "",
  );
  const detailNotes = derive(
    selectedContact,
    (c: Contact | null) => c?.notes || "",
  );
  const hasPhone = derive(selectedContact, (c: Contact | null) => !!c?.phone);
  const hasEmail = derive(selectedContact, (c: Contact | null) => !!c?.email);
  const hasNotes = derive(selectedContact, (c: Contact | null) => !!c?.notes);

  // Handlers
  const selectContact = handler<
    unknown,
    { viewMode: Cell<string>; selectedContactId: Cell<string>; contactId: string }
  >((_event, { viewMode, selectedContactId, contactId }) => {
    selectedContactId.set(contactId);
    viewMode.set("detail");
  });

  const goToList = handler<
    unknown,
    { viewMode: Cell<string>; selectedContactId: Cell<string> }
  >((_event, { viewMode, selectedContactId }) => {
    viewMode.set("list");
    selectedContactId.set("");
  });

  const goToAdd = handler<unknown, { viewMode: Cell<string> }>(
    (_event, { viewMode }) => {
      viewMode.set("add");
    },
  );

  const addContact = handler<
    unknown,
    {
      contacts: Cell<Contact[]>;
      viewMode: Cell<string>;
      newFirstName: Cell<string>;
      newLastName: Cell<string>;
      newPhone: Cell<string>;
      newEmail: Cell<string>;
      newCompany: Cell<string>;
      newNotes: Cell<string>;
    }
  >(
    (
      _event,
      {
        contacts,
        viewMode,
        newFirstName,
        newLastName,
        newPhone,
        newEmail,
        newCompany,
        newNotes,
      },
    ) => {
      const firstName = newFirstName.get().trim();
      if (!firstName) return;

      const existingContacts = contacts.get() || [];
      contacts.set([
        ...existingContacts,
        {
          id: generateId(),
          firstName,
          lastName: newLastName.get().trim(),
          phone: newPhone.get().trim(),
          email: newEmail.get().trim(),
          company: newCompany.get().trim(),
          notes: newNotes.get().trim(),
        },
      ]);

      // Clear form
      newFirstName.set("");
      newLastName.set("");
      newPhone.set("");
      newEmail.set("");
      newCompany.set("");
      newNotes.set("");
      viewMode.set("list");
    },
  );

  const deleteContact = handler<
    unknown,
    {
      contacts: Cell<Contact[]>;
      viewMode: Cell<string>;
      selectedContactId: Cell<string>;
    }
  >((_event, { contacts, viewMode, selectedContactId }) => {
    const id = selectedContactId.get();
    const list = contacts.get() || [];
    const index = list.findIndex((c) => c.id === id);
    if (index >= 0) {
      contacts.set(list.toSpliced(index, 1));
    }
    viewMode.set("list");
    selectedContactId.set("");
  });

  const cancelAdd = handler<
    unknown,
    {
      viewMode: Cell<string>;
      newFirstName: Cell<string>;
      newLastName: Cell<string>;
      newPhone: Cell<string>;
      newEmail: Cell<string>;
      newCompany: Cell<string>;
      newNotes: Cell<string>;
    }
  >(
    (
      _event,
      {
        viewMode,
        newFirstName,
        newLastName,
        newPhone,
        newEmail,
        newCompany,
        newNotes,
      },
    ) => {
      newFirstName.set("");
      newLastName.set("");
      newPhone.set("");
      newEmail.set("");
      newCompany.set("");
      newNotes.set("");
      viewMode.set("list");
    },
  );

  // Styles
  const containerStyle = {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    backgroundColor: colors.background,
  };

  const headerStyle = {
    padding: "1rem",
    backgroundColor: colors.cardBg,
    borderBottom: `1px solid ${colors.separator}`,
  };

  const titleStyle = {
    fontSize: "2rem",
    fontWeight: "700" as const,
    color: colors.text,
    marginBottom: "0.75rem",
    letterSpacing: "-0.02em",
  };

  const searchContainerStyle = {
    backgroundColor: "#e5e5ea",
    borderRadius: "10px",
    padding: "0.5rem 0.75rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  };

  const listContainerStyle = {
    flex: 1,
    overflowY: "auto" as const,
  };

  const contactRowStyle = {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.75rem 1rem",
    backgroundColor: colors.cardBg,
    borderBottom: `0.5px solid ${colors.separator}`,
    cursor: "pointer",
  };

  const contactInfoStyle = {
    flex: 1,
    minWidth: 0,
  };

  const contactNameStyle = {
    fontSize: "1rem",
    fontWeight: "400" as const,
    color: colors.text,
    whiteSpace: "nowrap" as const,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
  };

  const contactSubtitleStyle = {
    fontSize: "0.8125rem",
    color: colors.secondaryText,
    whiteSpace: "nowrap" as const,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
  };

  const footerStyle = {
    padding: "0.75rem",
    textAlign: "center" as const,
    color: colors.secondaryText,
    fontSize: "0.8125rem",
    backgroundColor: colors.background,
  };

  const navBarStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.75rem 1rem",
    backgroundColor: colors.cardBg,
    borderBottom: `1px solid ${colors.separator}`,
  };

  const navButtonStyle = {
    background: "none",
    border: "none",
    color: colors.blue,
    fontSize: "1rem",
    fontWeight: "400" as const,
    cursor: "pointer",
    padding: "0.25rem 0.5rem",
  };

  const navTitleStyle = {
    fontSize: "1.0625rem",
    fontWeight: "600" as const,
    color: colors.text,
  };

  const detailAvatarStyle = (color: string) => ({
    width: "100px",
    height: "100px",
    borderRadius: "50%",
    backgroundColor: color,
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "500" as const,
    fontSize: "36px",
    margin: "0 auto 0.5rem",
  });

  const detailNameStyle = {
    fontSize: "1.5rem",
    fontWeight: "600" as const,
    color: colors.text,
    textAlign: "center" as const,
    marginBottom: "0.25rem",
  };

  const detailCompanyStyle = {
    fontSize: "0.9375rem",
    color: colors.secondaryText,
    textAlign: "center" as const,
    marginBottom: "1.5rem",
  };

  const fieldGroupStyle = {
    backgroundColor: colors.cardBg,
    borderRadius: "12px",
    margin: "0 1rem 1rem",
    overflow: "hidden",
  };

  const fieldRowStyle = {
    display: "flex",
    alignItems: "center",
    padding: "0.875rem 1rem",
    borderBottom: `0.5px solid ${colors.separator}`,
  };

  const fieldLabelStyle = {
    width: "80px",
    fontSize: "0.9375rem",
    color: colors.text,
    flexShrink: 0,
  };

  const fieldValueStyle = {
    flex: 1,
    fontSize: "0.9375rem",
    color: colors.blue,
  };

  const deleteButtonStyle = {
    width: "calc(100% - 2rem)",
    margin: "1rem",
    padding: "0.875rem",
    backgroundColor: colors.cardBg,
    color: colors.red,
    fontSize: "1rem",
    fontWeight: "400" as const,
    border: "none",
    borderRadius: "12px",
    cursor: "pointer",
    textAlign: "center" as const,
  };

  return {
    [NAME]: "gContacts",
    [UI]: (
      <div style={containerStyle}>
        {ifElse(
          derive(viewMode, (v: string) => v === "list"),
          // LIST VIEW
          <>
            <div style={headerStyle}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <h1 style={titleStyle}>Contacts</h1>
                <button
                  type="button"
                  onClick={goToAdd({ viewMode })}
                  style={{
                    background: "none",
                    border: "none",
                    color: colors.blue,
                    fontSize: "1.75rem",
                    fontWeight: "300",
                    cursor: "pointer",
                    padding: "0",
                    lineHeight: 1,
                  }}
                >
                  +
                </button>
              </div>
              <div style={searchContainerStyle}>
                <span style={{ color: colors.secondaryText }}>
                  {"\uD83D\uDD0D"}
                </span>
                <ct-input
                  $value={searchQuery}
                  placeholder="Search"
                  style="flex: 1; background: none; border: none; font-size: 1rem;"
                  timingStrategy="immediate"
                />
              </div>
            </div>

            <div style={listContainerStyle}>
              {contacts.map((contact, index) => (
                <div
                  style={contactRowStyle}
                  onClick={selectContact({
                    viewMode,
                    selectedContactId,
                    contactId: derive(contact, (c: Contact) => c.id),
                  })}
                >
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: "50%",
                      backgroundColor: derive(contact, (c: Contact) =>
                        getAvatarColor(getFullName(c.firstName, c.lastName)),
                      ),
                      color: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: "600",
                      fontSize: "14px",
                      flexShrink: 0,
                    }}
                  >
                    {derive(contact, (c: Contact) =>
                      getInitials(c.firstName, c.lastName),
                    )}
                  </div>
                  <div style={contactInfoStyle}>
                    <div style={contactNameStyle}>
                      {derive(contact, (c: Contact) =>
                        getFullName(c.firstName, c.lastName),
                      )}
                    </div>
                    {ifElse(
                      derive(
                        contact,
                        (c: Contact) => c.company || c.phone || c.email,
                      ),
                      <div style={contactSubtitleStyle}>
                        {derive(
                          contact,
                          (c: Contact) => c.company || c.phone || c.email || "",
                        )}
                      </div>,
                      null,
                    )}
                  </div>
                  <span style={{ color: colors.separator }}>{">"}</span>
                </div>
              ))}

              {ifElse(
                derive(contactCount, (n: number) => n === 0),
                <div
                  style={{
                    padding: "3rem 1rem",
                    textAlign: "center",
                    color: colors.secondaryText,
                  }}
                >
                  <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>
                    {"\uD83D\uDCCB"}
                  </div>
                  <div style={{ fontSize: "1.125rem", fontWeight: "600" }}>
                    No Contacts
                  </div>
                  <div style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>
                    Tap + to add a contact
                  </div>
                </div>,
                null,
              )}
            </div>

            <div style={footerStyle}>
              {contactCount}{" "}
              {derive(contactCount, (n: number) =>
                n === 1 ? "Contact" : "Contacts",
              )}
            </div>
          </>,

          // DETAIL OR ADD VIEW
          ifElse(
            derive(viewMode, (v: string) => v === "detail"),
            // DETAIL VIEW
            <>
              <div style={navBarStyle}>
                <button
                  type="button"
                  onClick={goToList({ viewMode, selectedContactId })}
                  style={navButtonStyle}
                >
                  {"< Contacts"}
                </button>
                <span style={navTitleStyle}>Contact</span>
                <div style={{ width: "80px" }} />
              </div>

              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  paddingTop: "1.5rem",
                  backgroundColor: colors.background,
                }}
              >
                {ifElse(
                  selectedContact,
                  <>
                    <div
                      style={detailAvatarStyle(detailAvatarColor)}
                    >
                      {detailInitials}
                    </div>
                    <div style={detailNameStyle}>
                      {detailDisplayName}
                    </div>
                    <div style={detailCompanyStyle}>
                      {detailCompany}
                    </div>

                    {/* Phone */}
                    {ifElse(
                      hasPhone,
                      <div style={fieldGroupStyle}>
                        <div style={fieldRowStyle}>
                          <span style={fieldLabelStyle}>phone</span>
                          <span style={fieldValueStyle}>
                            {detailPhone}
                          </span>
                        </div>
                      </div>,
                      null,
                    )}

                    {/* Email */}
                    {ifElse(
                      hasEmail,
                      <div style={fieldGroupStyle}>
                        <div style={fieldRowStyle}>
                          <span style={fieldLabelStyle}>email</span>
                          <span style={fieldValueStyle}>
                            {detailEmail}
                          </span>
                        </div>
                      </div>,
                      null,
                    )}

                    {/* Notes */}
                    {ifElse(
                      hasNotes,
                      <div style={fieldGroupStyle}>
                        <div
                          style={{
                            ...fieldRowStyle,
                            flexDirection: "column",
                            alignItems: "flex-start",
                          }}
                        >
                          <span
                            style={{
                              ...fieldLabelStyle,
                              width: "auto",
                              marginBottom: "0.5rem",
                            }}
                          >
                            notes
                          </span>
                          <span
                            style={{
                              fontSize: "0.9375rem",
                              color: colors.text,
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {detailNotes}
                          </span>
                        </div>
                      </div>,
                      null,
                    )}

                    <button
                      type="button"
                      onClick={deleteContact({
                        contacts,
                        viewMode,
                        selectedContactId,
                      })}
                      style={deleteButtonStyle}
                    >
                      Delete Contact
                    </button>
                  </>,
                  <div
                    style={{
                      padding: "2rem",
                      textAlign: "center",
                      color: colors.secondaryText,
                    }}
                  >
                    Contact not found
                  </div>,
                )}
              </div>
            </>,

            // ADD VIEW
            <>
              <div style={navBarStyle}>
                <button
                  type="button"
                  onClick={cancelAdd({
                    viewMode,
                    newFirstName,
                    newLastName,
                    newPhone,
                    newEmail,
                    newCompany,
                    newNotes,
                  })}
                  style={navButtonStyle}
                >
                  Cancel
                </button>
                <span style={navTitleStyle}>New Contact</span>
                <button
                  type="button"
                  onClick={addContact({
                    contacts,
                    viewMode,
                    newFirstName,
                    newLastName,
                    newPhone,
                    newEmail,
                    newCompany,
                    newNotes,
                  })}
                  style={{
                    ...navButtonStyle,
                    fontWeight: "600",
                  }}
                >
                  Done
                </button>
              </div>

              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  paddingTop: "1.5rem",
                  backgroundColor: colors.background,
                }}
              >
                {/* Avatar preview */}
                <div
                  style={{
                    width: "100px",
                    height: "100px",
                    borderRadius: "50%",
                    backgroundColor: "#c7c7cc",
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "36px",
                    margin: "0 auto 1.5rem",
                  }}
                >
                  {derive(
                    { newFirstName, newLastName },
                    ({
                      newFirstName: f,
                      newLastName: l,
                    }: {
                      newFirstName: string;
                      newLastName: string;
                    }) => (f || l ? getInitials(f, l) : "\uD83D\uDC64"),
                  )}
                </div>

                {/* Form fields */}
                <div style={fieldGroupStyle}>
                  <div style={fieldRowStyle}>
                    <ct-input
                      $value={newFirstName}
                      placeholder="First name"
                      style="flex: 1; background: none; border: none; font-size: 0.9375rem;"
                      timingStrategy="immediate"
                    />
                  </div>
                  <div style={fieldRowStyle}>
                    <ct-input
                      $value={newLastName}
                      placeholder="Last name"
                      style="flex: 1; background: none; border: none; font-size: 0.9375rem;"
                      timingStrategy="immediate"
                    />
                  </div>
                  <div style={fieldRowStyle}>
                    <ct-input
                      $value={newCompany}
                      placeholder="Company"
                      style="flex: 1; background: none; border: none; font-size: 0.9375rem;"
                      timingStrategy="immediate"
                    />
                  </div>
                </div>

                <div style={fieldGroupStyle}>
                  <div style={fieldRowStyle}>
                    <ct-input
                      $value={newPhone}
                      placeholder="Phone"
                      style="flex: 1; background: none; border: none; font-size: 0.9375rem;"
                      timingStrategy="immediate"
                    />
                  </div>
                </div>

                <div style={fieldGroupStyle}>
                  <div style={fieldRowStyle}>
                    <ct-input
                      $value={newEmail}
                      placeholder="Email"
                      style="flex: 1; background: none; border: none; font-size: 0.9375rem;"
                      timingStrategy="immediate"
                    />
                  </div>
                </div>

                <div style={fieldGroupStyle}>
                  <div
                    style={{
                      ...fieldRowStyle,
                      minHeight: "80px",
                      alignItems: "flex-start",
                    }}
                  >
                    <ct-input
                      $value={newNotes}
                      placeholder="Notes"
                      style="flex: 1; background: none; border: none; font-size: 0.9375rem;"
                      timingStrategy="immediate"
                    />
                  </div>
                </div>
              </div>
            </>,
          ),
        )}
      </div>
    ),
    contacts,
  };
});
