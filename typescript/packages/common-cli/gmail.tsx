import { h } from "@commontools/html";
import { recipe, handler, UI, NAME, cell, derive } from "@commontools/builder";
import { z } from "zod";


const Email = z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()),
    snippet: z.string(),
    subject: z.string(),
    from: z.string(),
    date: z.string(),
    to: z.string(),
    plainText: z.string(),
});
type Email = z.infer<typeof Email>;

const Auth = z.object({
    token: z.string(),
    tokenType: z.string(),
    scope: z.string(),
    expiresIn: z.number(),
    expiresAt: z.number(),
    refreshToken: z.string(),
});
type Auth = z.infer<typeof Auth>;

const Recipe = z.object({
}).describe("fake gmail");


const ResultSchema = {
    type: "object",
    properties: {
        emails: {
            type: "array", items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    threadId: { type: "string" },
                    labelIds: { type: "array", items: { type: "string" } },
                    snippet: { type: "string" },
                    subject: { type: "string" },
                    from: { type: "string" },
                    date: { type: "string" },
                    to: { type: "string" },
                    plainText: { type: "string" },
                }
            }
        },
        updater: { asCell: true, type: "action" },
    },
};

const EventSchema = z.object({
    auth: { asCell: true }
});


const updater = handler<Event, { emails: Email[], auth: Auth }>((event, state) => {
    if (!state.auth.token) {
        console.log("no token");
        return;
    }
    console.log("token", state.auth.token);
    console.log("auth", event.auth);
    // event.emails.forEach(email => {
    //     console.log("adding email", email.subject);
    //     state.emails.push(email);
    // });
});

const faker = handler<{}, { emails: Email[] }>((event, state) => {
    const randomId = Math.random().toString(36).substring(2, 15);
    state.emails.push({
        id: randomId,
        threadId: randomId,
        labelIds: ["INBOX"],
        snippet: "test",
        subject: "test",
        from: "test",
        date: "test",
        to: "test",
        plainText: "test",
    });
});

export default recipe(Recipe, ResultSchema, () => {

    const auth = cell<Auth>({
        token: "",
        refreshToken: "",
        expiresAt: 0,
        expiresIn: 0,
        tokenType: "",
        scope: "",
    });
    const emails = cell<Email[]>([]);

    derive(emails, (emails) => {
        console.log("emails", emails.length);
    });

    return {
        [NAME]: "gmail importer",
        [UI]: (
            <div>
                <h1>Gmail Importer</h1>
                <button onclick={faker({ emails })}>Fake</button>
                <common-google-oauth $auth={auth} />
                <div>
                    {emails.map(email => (
                        <div>
                            <h3>{email.subject}</h3>
                            <p><em>{email.date}</em> {email.plainText}</p>
                        </div>
                    ))}
                </div>
            </div>
        ),
        emails,
        auth,
        updater: updater({ emails, auth })
    }
});
