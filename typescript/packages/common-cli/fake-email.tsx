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

const Recipe = z.object({
    auth: z.object({
        token: z.string(),
        refreshToken: z.string(),
        expiresAt: z.number(),
        expiresIn: z.number(),
        tokenType: z.string(),
    }).describe("gmail auth"),
    emails: z.array(Email),
}).describe("fake gmail");


const Emails = z.object({
    emails: z.array(Email),
    updater: z.any(),
});

const updater = handler<{ emails: Email[] }, { emails: Email[] }>((event, state) => {
    event.emails.forEach(email => {
        console.log("adding email", email.subject);
        state.emails.push(email);
    });
});

const faker = handler<{  }, { emails: Email[] }>((event, state) => {
    state.emails.push({
        id: "1",
        threadId: "1",
        labelIds: ["1"],
        snippet: "test",
        subject: "test",
        from: "test",
        date: "test",
        to: "test",
        plainText: "test",
    });
});

export default recipe(Recipe, Emails, ({emails}) => {

    derive(emails, (emails) => {
        console.log("emails", emails.length);
    });

    return {
        [NAME]: "fake emails",
        [UI]: (
            <div>
                <h1>Fake Emails</h1>
                <button onclick={faker({emails})}>Fake</button>
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
        updater: updater({ emails })
    }
});
