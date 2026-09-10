/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

// Contact data model
interface Contact {
  firstName: string;
  lastName: string;
  phone: Default<string, "">;
  email: Default<string, "">;
  company: Default<string, "">;
  notes: Default<string, "">;
}

interface Input {
  contacts: Cell<Contact[]>;
}

// Combined grouped structure
interface GroupedData {
  groups: Record<string, { contact: Contact; originalIndex: number }[]>;
  letters: string[];
  count: number;
}

export default pattern<Input, Input>(({ contacts }) => {
  // Local UI state
  const searchQuery = Cell.of("");
  const currentView = Cell.of<"list" | "detail" | "edit" | "add">("list");
  const selectedIndex = Cell.of<number>(-1);
  const editFirstName = Cell.of("");
  const editLastName = Cell.of("");
  const editPhone = Cell.of("");
  const editEmail = Cell.of("");
  const editCompany = Cell.of("");
  const editNotes = Cell.of("");

  // Single computed for all the grouped contact data
  const groupedData = computed((): GroupedData => {
    const query = searchQuery.get().toLowerCase();
    const all = contacts.get();

    // Filter
    const filtered = all.filter((c) => {
      if (!query) return true;
      const fullName = `${c.firstName} ${c.lastName}`.toLowerCase();
      const email = (c.email || "").toLowerCase();
      const phone = (c.phone || "").toLowerCase();
      const company = (c.company || "").toLowerCase();
      return (
        fullName.includes(query) ||
        email.includes(query) ||
        phone.includes(query) ||
        company.includes(query)
      );
    });

    // Sort
    const sorted = filtered.toSorted((a, b) => {
      const lastA = a.lastName.toLowerCase();
      const lastB = b.lastName.toLowerCase();
      if (lastA !== lastB) return lastA.localeCompare(lastB);
      return a.firstName.toLowerCase().localeCompare(b.firstName.toLowerCase());
    });

    // Group by first letter of last name
    const groups: Record<string, { contact: Contact; originalIndex: number }[]> = {};
    for (const contact of sorted) {
      const letter = contact.lastName.charAt(0).toUpperCase() || "#";
      if (!groups[letter]) groups[letter] = [];
      const originalIndex = all.findIndex(
        (c) =>
          c.firstName === contact.firstName &&
          c.lastName === contact.lastName &&
          c.phone === contact.phone
      );
      groups[letter].push({ contact, originalIndex });
    }

    // Get sorted letters
    const letters = Object.keys(groups).sort((a, b) => {
      if (a === "#") return 1;
      if (b === "#") return -1;
      return a.localeCompare(b);
    });

    return { groups, letters, count: all.length };
  });

  // Computed values for detail view (handles null safely)
  const selectedFirstName = computed(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return "";
    const contact = contacts.get()[idx];
    return contact?.firstName || "";
  });

  const selectedLastName = computed(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return "";
    const contact = contacts.get()[idx];
    return contact?.lastName || "";
  });

  const selectedCompany = computed(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return "";
    const contact = contacts.get()[idx];
    return contact?.company || "";
  });

  const selectedPhone = computed(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return "";
    const contact = contacts.get()[idx];
    return contact?.phone || "";
  });

  const selectedEmail = computed(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return "";
    const contact = contacts.get()[idx];
    return contact?.email || "";
  });

  const selectedNotes = computed(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return "";
    const contact = contacts.get()[idx];
    return contact?.notes || "";
  });

  // Computed initials
  const selectedInitials = computed(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return "?";
    const contact = contacts.get()[idx];
    if (!contact) return "?";
    return (contact.firstName.charAt(0) || "") + (contact.lastName.charAt(0) || "");
  });

  const editInitials = computed(() => {
    const first = editFirstName.get();
    return first.charAt(0) || "?";
  });

  // Handlers
  const selectContact = handler<
    unknown,
    { currentView: Cell<string>; selectedIndex: Cell<number>; idx: number }
  >((_, { currentView, selectedIndex, idx }) => {
    selectedIndex.set(idx);
    currentView.set("detail");
  });

  const startAddContact = handler<
    unknown,
    {
      currentView: Cell<string>;
      editFirstName: Cell<string>;
      editLastName: Cell<string>;
      editPhone: Cell<string>;
      editEmail: Cell<string>;
      editCompany: Cell<string>;
      editNotes: Cell<string>;
    }
  >((_, ctx) => {
    ctx.editFirstName.set("");
    ctx.editLastName.set("");
    ctx.editPhone.set("");
    ctx.editEmail.set("");
    ctx.editCompany.set("");
    ctx.editNotes.set("");
    ctx.currentView.set("add");
  });

  const startEditContact = handler<
    unknown,
    {
      currentView: Cell<string>;
      contacts: Cell<Contact[]>;
      selectedIndex: Cell<number>;
      editFirstName: Cell<string>;
      editLastName: Cell<string>;
      editPhone: Cell<string>;
      editEmail: Cell<string>;
      editCompany: Cell<string>;
      editNotes: Cell<string>;
    }
  >((_, ctx) => {
    const idx = ctx.selectedIndex.get();
    const contact = ctx.contacts.get()[idx];
    if (contact) {
      ctx.editFirstName.set(contact.firstName);
      ctx.editLastName.set(contact.lastName);
      ctx.editPhone.set(contact.phone || "");
      ctx.editEmail.set(contact.email || "");
      ctx.editCompany.set(contact.company || "");
      ctx.editNotes.set(contact.notes || "");
      ctx.currentView.set("edit");
    }
  });

  const saveContact = handler<
    unknown,
    {
      contacts: Cell<Contact[]>;
      currentView: Cell<string>;
      selectedIndex: Cell<number>;
      editFirstName: Cell<string>;
      editLastName: Cell<string>;
      editPhone: Cell<string>;
      editEmail: Cell<string>;
      editCompany: Cell<string>;
      editNotes: Cell<string>;
    }
  >((_, ctx) => {
    const newContact: Contact = {
      firstName: ctx.editFirstName.get(),
      lastName: ctx.editLastName.get(),
      phone: ctx.editPhone.get(),
      email: ctx.editEmail.get(),
      company: ctx.editCompany.get(),
      notes: ctx.editNotes.get(),
    };
    const view = ctx.currentView.get();
    const current = ctx.contacts.get();

    if (view === "add") {
      ctx.contacts.set([...current, newContact]);
      ctx.selectedIndex.set(current.length);
    } else if (view === "edit") {
      const idx = ctx.selectedIndex.get();
      const updated = [...current];
      updated[idx] = newContact;
      ctx.contacts.set(updated);
    }
    ctx.currentView.set("detail");
  });

  const deleteContact = handler<
    unknown,
    {
      contacts: Cell<Contact[]>;
      currentView: Cell<string>;
      selectedIndex: Cell<number>;
    }
  >((_, ctx) => {
    const idx = ctx.selectedIndex.get();
    const current = ctx.contacts.get();
    ctx.contacts.set(current.toSpliced(idx, 1));
    ctx.selectedIndex.set(-1);
    ctx.currentView.set("list");
  });

  const goBack = handler<unknown, { currentView: Cell<string> }>(
    (_, { currentView }) => {
      currentView.set("list");
    }
  );

  const cancelEdit = handler<
    unknown,
    { currentView: Cell<string>; selectedIndex: Cell<number> }
  >((_, { currentView, selectedIndex }) => {
    const idx = selectedIndex.get();
    currentView.set(idx >= 0 ? "detail" : "list");
  });

  // Styles
  const containerStyle = {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
    background: "#f2f2f7",
    minHeight: "100vh",
    color: "#000",
  };

  const headerStyle = {
    background: "#f2f2f7",
    padding: "12px 16px 8px",
    position: "sticky" as const,
    top: "0",
    zIndex: "10",
  };

  const headerRowStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  const titleStyle = {
    fontSize: "34px",
    fontWeight: "700",
    margin: "0 0 12px",
    color: "#000",
  };

  const searchBoxStyle = {
    background: "#e5e5ea",
    borderRadius: "10px",
    padding: "8px 12px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  };

  const sectionHeaderStyle = {
    fontSize: "20px",
    fontWeight: "600",
    color: "#000",
    padding: "8px 16px 4px",
    background: "#f2f2f7",
  };

  const contactRowStyle = {
    background: "#fff",
    padding: "12px 16px",
    borderBottom: "1px solid #e5e5ea",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "12px",
  };

  const avatarStyle = {
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #007aff 0%, #5856d6 100%)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "500",
    fontSize: "16px",
    flexShrink: "0",
  };

  const largeAvatarStyle = {
    width: "100px",
    height: "100px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #007aff 0%, #5856d6 100%)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "500",
    fontSize: "40px",
    margin: "0 auto 12px",
  };

  const contactNameStyle = {
    fontSize: "17px",
    fontWeight: "400",
    color: "#000",
  };

  const addButtonStyle = {
    color: "#007aff",
    fontSize: "28px",
    fontWeight: "300",
    cursor: "pointer",
    padding: "8px",
  };

  const editButtonStyle = {
    color: "#007aff",
    fontSize: "17px",
    fontWeight: "400",
    cursor: "pointer",
    padding: "8px",
  };

  const backButtonStyle = {
    color: "#007aff",
    fontSize: "17px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "4px",
  };

  const detailCardStyle = {
    background: "#fff",
    borderRadius: "12px",
    margin: "16px",
    overflow: "hidden",
  };

  const detailRowStyle = {
    padding: "12px 16px",
    borderBottom: "1px solid #e5e5ea",
  };

  const detailRowLastStyle = {
    padding: "12px 16px",
  };

  const detailLabelStyle = {
    fontSize: "13px",
    color: "#8e8e93",
    marginBottom: "4px",
  };

  const detailValueStyle = {
    fontSize: "17px",
    color: "#007aff",
  };

  const destructiveButtonStyle = {
    color: "#ff3b30",
    fontSize: "17px",
    padding: "12px 16px",
    textAlign: "center" as const,
    cursor: "pointer",
  };

  const inputGroupStyle = {
    background: "#fff",
    borderRadius: "12px",
    margin: "16px",
    overflow: "hidden",
  };

  const inputRowStyle = {
    padding: "12px 16px",
    borderBottom: "1px solid #e5e5ea",
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  };

  const inputRowLastStyle = {
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  };

  const inputLabelStyle = {
    fontSize: "13px",
    color: "#8e8e93",
  };

  const countStyle = {
    fontSize: "13px",
    color: "#8e8e93",
    marginTop: "8px",
    textAlign: "center" as const,
  };

  const centerTextStyle = {
    padding: "20px 16px",
    textAlign: "center" as const,
  };

  const nameHeaderStyle = {
    fontSize: "24px",
    fontWeight: "600",
    margin: "0",
  };

  const companyStyle = {
    color: "#8e8e93",
    marginTop: "4px",
  };

  const titleRowStyle = {
    fontSize: "17px",
    fontWeight: "600",
  };

  const detailHeaderStyle = {
    background: "#f2f2f7",
    padding: "12px 16px 8px",
    position: "sticky" as const,
    top: "0",
    zIndex: "10",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  // List View
  const listView = (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div style={headerRowStyle}>
          <h1 style={titleStyle}>Contacts</h1>
          <div
            style={addButtonStyle}
            onClick={startAddContact({
              currentView,
              editFirstName,
              editLastName,
              editPhone,
              editEmail,
              editCompany,
              editNotes,
            })}
          >
            +
          </div>
        </div>
        <div style={searchBoxStyle}>
          <span style={{ color: "#8e8e93" }}>🔍</span>
          <ct-input
            $value={searchQuery}
            placeholder="Search"
            style="flex: 1; background: transparent; border: none; font-size: 17px;"
          />
        </div>
        <div style={countStyle}>{groupedData.count} contacts</div>
      </div>

      {groupedData.letters.map((letter) => (
        <div>
          <div style={sectionHeaderStyle}>{letter}</div>
          {(groupedData.groups[letter] ?? []).map((item) => (
            <div
              style={contactRowStyle}
              onClick={selectContact({
                currentView,
                selectedIndex,
                idx: item.originalIndex,
              })}
            >
              <div style={avatarStyle}>
                {item.contact.firstName.charAt(0)}
                {item.contact.lastName.charAt(0)}
              </div>
              <div style={contactNameStyle}>
                {item.contact.firstName} <strong>{item.contact.lastName}</strong>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  // Detail View - using computed values that handle null
  const detailView = (
    <div style={containerStyle}>
      <div style={detailHeaderStyle}>
        <div style={backButtonStyle} onClick={goBack({ currentView })}>
          ← Contacts
        </div>
        <div
          style={editButtonStyle}
          onClick={startEditContact({
            currentView,
            contacts,
            selectedIndex,
            editFirstName,
            editLastName,
            editPhone,
            editEmail,
            editCompany,
            editNotes,
          })}
        >
          Edit
        </div>
      </div>

      <div style={centerTextStyle}>
        <div style={largeAvatarStyle}>{selectedInitials}</div>
        <h2 style={nameHeaderStyle}>
          {selectedFirstName} {selectedLastName}
        </h2>
        {ifElse(
          selectedCompany,
          <div style={companyStyle}>{selectedCompany}</div>,
          null
        )}
      </div>

      <div style={detailCardStyle}>
        {ifElse(
          selectedPhone,
          <div style={detailRowStyle}>
            <div style={detailLabelStyle}>phone</div>
            <div style={detailValueStyle}>{selectedPhone}</div>
          </div>,
          null
        )}
        {ifElse(
          selectedEmail,
          <div style={detailRowStyle}>
            <div style={detailLabelStyle}>email</div>
            <div style={detailValueStyle}>{selectedEmail}</div>
          </div>,
          null
        )}
        {ifElse(
          selectedNotes,
          <div style={detailRowLastStyle}>
            <div style={detailLabelStyle}>notes</div>
            <div style={{ fontSize: "17px", color: "#000" }}>
              {selectedNotes}
            </div>
          </div>,
          null
        )}
      </div>

      <div style={detailCardStyle}>
        <div
          style={destructiveButtonStyle}
          onClick={deleteContact({ contacts, currentView, selectedIndex })}
        >
          Delete Contact
        </div>
      </div>
    </div>
  );

  // Computed view title
  const editViewTitle = computed(() => {
    const view = currentView.get();
    return view === "add" ? "New Contact" : "Edit Contact";
  });

  // Edit/Add View
  const editView = (
    <div style={containerStyle}>
      <div style={detailHeaderStyle}>
        <div
          style={backButtonStyle}
          onClick={cancelEdit({ currentView, selectedIndex })}
        >
          Cancel
        </div>
        <div style={titleRowStyle}>{editViewTitle}</div>
        <div
          style={editButtonStyle}
          onClick={saveContact({
            contacts,
            currentView,
            selectedIndex,
            editFirstName,
            editLastName,
            editPhone,
            editEmail,
            editCompany,
            editNotes,
          })}
        >
          Done
        </div>
      </div>

      <div style={centerTextStyle}>
        <div style={largeAvatarStyle}>{editInitials}</div>
      </div>

      <div style={inputGroupStyle}>
        <div style={inputRowStyle}>
          <div style={inputLabelStyle}>First name</div>
          <ct-input
            $value={editFirstName}
            placeholder="First name"
            style="background: transparent; border: none; font-size: 17px; padding: 0;"
          />
        </div>
        <div style={inputRowStyle}>
          <div style={inputLabelStyle}>Last name</div>
          <ct-input
            $value={editLastName}
            placeholder="Last name"
            style="background: transparent; border: none; font-size: 17px; padding: 0;"
          />
        </div>
        <div style={inputRowLastStyle}>
          <div style={inputLabelStyle}>Company</div>
          <ct-input
            $value={editCompany}
            placeholder="Company"
            style="background: transparent; border: none; font-size: 17px; padding: 0;"
          />
        </div>
      </div>

      <div style={inputGroupStyle}>
        <div style={inputRowStyle}>
          <div style={inputLabelStyle}>Phone</div>
          <ct-input
            $value={editPhone}
            placeholder="Phone"
            style="background: transparent; border: none; font-size: 17px; padding: 0;"
          />
        </div>
        <div style={inputRowLastStyle}>
          <div style={inputLabelStyle}>Email</div>
          <ct-input
            $value={editEmail}
            placeholder="Email"
            style="background: transparent; border: none; font-size: 17px; padding: 0;"
          />
        </div>
      </div>

      <div style={inputGroupStyle}>
        <div style={inputRowLastStyle}>
          <div style={inputLabelStyle}>Notes</div>
          <ct-input
            $value={editNotes}
            placeholder="Notes"
            style="background: transparent; border: none; font-size: 17px; padding: 0;"
          />
        </div>
      </div>
    </div>
  );

  // Current view computed
  const isListView = computed(() => currentView.get() === "list");
  const isDetailView = computed(() => currentView.get() === "detail");
  const isEditOrAddView = computed(() => {
    const view = currentView.get();
    return view === "edit" || view === "add";
  });

  return {
    [NAME]: "Contacts",
    [UI]: (
      <div>
        {ifElse(isListView, listView, null)}
        {ifElse(isDetailView, detailView, null)}
        {ifElse(isEditOrAddView, editView, null)}
      </div>
    ),
    contacts,
  };
});
