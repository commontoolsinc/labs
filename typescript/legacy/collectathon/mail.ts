import { serve } from "https://deno.land/std@0.184.0/http/server.ts";
import { fastCompletion } from "./llm.ts";
import { clip, clipEmail } from "./synopsys.ts";

const port = 8025;

export async function ingestEmail(subject: string, body: string): Promise<any[]> {
  const systemPrompt =
    "Convert the attached email into a JSON object. The content of the email or subject may have further instructions on how to format the data but you must return a JSON array of objects e.g. a ```json [{...}]``` block, no commentary. Each object must be flat, no nested object hierarachy is permitted.";
  const userPrompt = `
Subject: ${subject}

Body:
${body}

---

Format the output as a JSON array of one or more objects in a \`\`\`json\`\`\ block.
  `;

  const response = await fastCompletion(systemPrompt, [
    { role: "user", content: userPrompt },
  ]);

  return response;
}

async function handleWebhook(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const formData = await req.formData();
    const sender = formData.get('sender')?.toString();
    const recipient = formData.get('recipient');
    const subject = formData.get('subject')?.toString();
    const bodyPlain = formData.get('body-plain')?.toString();

    console.log('Received email:');
    console.log('From:', sender);
    console.log('To:', recipient);
    ;
    const allNames: string[] = [];

    const recipientName = recipient?.toString().split('@')[0];
    if (recipientName) {
      allNames.push(recipientName);
    }
    console.log('Recipient Name:', recipientName);

    const cc = formData.get('cc');
    if (cc) {
      const ccNames = cc.toString().split(',').map(email => email.trim().split('@')[0]);
      allNames.push(...ccNames);
      console.log('CC Names:', ccNames);
    }

    console.log('All Names:', allNames);

    console.log('Subject:', subject);
    console.log('Body:', bodyPlain);
    if (!subject || !bodyPlain || !sender || !recipient) {
      throw new Error('Missing data');
    }
    const ingested = await ingestEmail(subject, bodyPlain);
    for (const entity of ingested) {
      console.log('Entity:', entity);
      clipEmail(sender, allNames, entity);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export async function start() {

  console.log(`Webhook server running on http://localhost:${port}`);
  await serve(handleWebhook, { port });
}
