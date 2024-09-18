import { parseICS } from "./deps.ts";
import { db } from "./db.ts";
import { addItemToCollection, getOrCreateCollection } from "./collections.ts";

export async function clipCalendar(calendarUrl: string, collectionName: string) {
    console.log(`Importing calendar from ${calendarUrl} to collection ${collectionName}`);
    
    db.query("BEGIN TRANSACTION");
    if (!calendarUrl.endsWith('.ics')) {
        console.error('Invalid calendar URL. Must be an ICS file.');
        return;
    }

    try {
        const response = await fetch(calendarUrl);
        const icsData = await response.text();
        const events = parseICS(icsData);

        const collectionId = await getOrCreateCollection(collectionName);
        let importedCount = 0;

        for (const event of events) {
            if (event.type === 'VEVENT') {
                const title = event.name || 'Untitled Event';
                const startDate = event.startDate?.toISOString() || '';
                const endDate = event.endDate?.toISOString() || '';

                const contentJson = {
                    title: title,
                    description: event.description || '',
                    startDate: startDate,
                    endDate: endDate,
                    location: event.location || '',
                    organizer: event.organizer || '',
                };

                const result = await db.query(
                    "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
                    [
                        calendarUrl,
                        title,
                        JSON.stringify(contentJson),
                        event.description || '',
                        "Calendar",
                    ]
                );
                const itemId = result[0][0] as number;

                await db.query(
                    "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
                    [itemId, collectionId]
                );
                importedCount++;
            }
        }

        console.log(`Imported ${importedCount} events to collection "${collectionName}"`);
        db.query("COMMIT");
    } catch (error) {
        console.error(`Error importing Calendar: ${error.message}`);
        db.query("ROLLBACK");
    }
}

// Remove the addItem helper function as it's no longer needed
