import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { authenticate } from 'npm:@google-cloud/local-auth@3.0.1';
import { OAuth2Client } from "npm:google-auth-library@9.14.2";
import { google } from "npm:googleapis@144.0.0";
import { clipEmail, cid  } from "./synopsys.ts";

type GmailEntity = {
    messageId: string;
    subject: string;
    from: string;
    date: string;
    snippet: string;
}

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes the first time
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

async function loadSavedCredentialsIfExist(): Promise<OAuth2Client | null> {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content.toString());
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

async function saveCredentials(client: OAuth2Client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content.toString());
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize(): Promise<OAuth2Client> {
    let client: any = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
}

async function listMessages(auth: OAuth2Client, maxResults: number = 10) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.list({
        userId: 'me',
        maxResults: maxResults
    });

    return res.data.messages || [];
}

async function getMessage(auth: OAuth2Client, messageId: string) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId
    });

    return res.data;
}

async function getMessageDetails(auth: OAuth2Client, messageId: string): Promise<GmailEntity> {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
    });

    const headers = res.data.payload?.headers;
    const subject = headers?.find(h => h.name === 'Subject')?.value || 'No subject';
    const from = headers?.find(h => h.name === 'From')?.value || 'Unknown sender';
    const date = headers?.find(h => h.name === 'Date')?.value || 'Unknown date';

    return {
        messageId,
        subject,
        from,
        date,
        snippet: res.data.snippet || 'No snippet available',
    };
}

async function importGmail(message: GmailEntity) {
    const entityCid = await cid({ messageId: message.messageId, source: "gmail" });
    clipEmail(message.from, ["gmail"], message, entityCid);
}

if (import.meta.main) {
    const maxResults = parseInt(process.argv[2]) || 10;
    const auth = await authorize();
    const messages = await listMessages(auth, maxResults);
    for (const message of messages) {
        const messageDetails = await getMessageDetails(auth, message.id);
        importGmail(messageDetails);
    }
}