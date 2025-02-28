// Helper function to decode base64 encoded email parts
function decodeBase64(data: string) {
  // Replace URL-safe characters back to their original form
  const sanitized = data.replace(/-/g, '+').replace(/_/g, '/');
  // Decode the base64 string
  return atob(sanitized);
}

// Helper function to extract email address from a header value
function extractEmailAddress(header: string): string {
  const emailMatch = header.match(/<([^>]*)>/);
  if (emailMatch && emailMatch[1]) {
    return emailMatch[1];
  }
  return header;
}

// Helper function to extract header value from message headers
function getHeader(headers: any[], name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

export async function fetchInboxEmails(accessToken: string) {

  // First, get the list of message IDs from the inbox
  const listResponse = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const listData = await listResponse.json();
  
  if (!listData.messages || !Array.isArray(listData.messages)) {
    return { messages: [] };
  }

  // Fetch full details for each message
  const detailedMessages = await Promise.all(
    listData.messages.map(async (message: { id: string }) => {
      const messageResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const messageData = await messageResponse.json();
      
      // Extract email details from the message data
      const headers = messageData.payload.headers;
      const subject = getHeader(headers, "Subject");
      const from = getHeader(headers, "From");
      const to = getHeader(headers, "To");
      const date = getHeader(headers, "Date");
      
      // Extract plain text content if available
      let plainText = "";
      if (messageData.payload.parts && Array.isArray(messageData.payload.parts)) {
        const textPart = messageData.payload.parts.find(
          (part: any) => part.mimeType === "text/plain"
        );
        if (textPart && textPart.body && textPart.body.data) {
          plainText = decodeBase64(textPart.body.data);
        }
      } else if (messageData.payload.body && messageData.payload.body.data) {
        plainText = decodeBase64(messageData.payload.body.data);
      }

      return {
        id: messageData.id,
        threadId: messageData.threadId,
        labelIds: messageData.labelIds || ["INBOX"],
        snippet: messageData.snippet || "",
        subject,
        from: extractEmailAddress(from),
        date,
        to: extractEmailAddress(to),
        plainText,
      };
    })
  );

  return { messages: detailedMessages };
}
