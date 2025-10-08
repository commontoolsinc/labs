# Doc Level Subscriptions

## Problem

Our current schema query system can be quite slow to evaluate, leading to slow round trips from the client, which can result in unneccessary conflicts.

While we can issue guidance to avoid using schemas that do span large amounts of the space, building useful apps sometimes requires them. In any case, developers are likely to accidentally include much more content than needed, and we should still perform reasonably there, even if we don't perform well.

## Current Implementation

The client sends a query/subscribe command with a set of documents, and for each document, the path and schema (this combination is a SchemaPathSelector) to be used for that document.
We then run a schema query using that information, and return the set of documents we used to traverse the schema. This ensures that a client with the same set of documents will be have all the linked documents needed based on the specified schema.

We also maintain a set of watched documents, and add our query to the set of queries that should be re-run if one of those documents is changed. This means we don't need to re-run a query when an unrelated doc changes. When one of the documents in a transaction does match, we re-run the query, and update our set of watched documents when we're done.

As an implementation detail, we also maintain a structure of per-document subscriptions that are created while evaluating the initial subscription. This means that if we traverse back into the same document multiple times with the same SchemaPathSelector, we can skip evaluating it again.

## Change Suggestions

The per-document subscription tracking that we use when evaluating a single query could be maintained across queries, and across time.
* Across Queries - multiple subscriptions can each result in the same SchemaPathSelector on a document. Right now, each of those would re-run that portion of the query.
* Across Time - modifying one of the documents that was a result of our initial query may alter part of the query, but for most of the resulting documents, there is no change.

In this model, when any of the docs for which we have already evaluated the query is altered, we mark the SchemaPathSelector associated with the changed docs stale (removing them from the cache), and re-evaluate only those. Often, evaluating those queries won't have to traverse many documents, since they will typically result in the same SchemaPathSelector on linked documents that we already have in our cache.

## Complications
### Watch List and SchemaTracker
The watch list *should* change when we re-evaluate a query. While it's trivial to add the new results, it's difficult to determine whether existing results should still be flagged as included. This is also true for our SchemaPathSelector tracking. A change to document A can mean that we no longer have a SchemaPathSelector for document B, but it isn't obvious that the selector we have for document B was caused by this selector on document A, or even whether it was caused by this subscription at all.

While I can maintain reference counts and links, I may try to see what happens if I we just ignore this for now, and allow the client to get updates for documents that no longer match their query.

### AnyOf
When using the `anyOf` schema property, the matching for a linked document may depend on properties of the containing document. Without the cache, this is ok, because we're always generating document B's SchemaPathSelector for the cache based on document A's value.

I plan to ignore this one. For example, if your `country` changes to one without states, the linked `state` would still be returned to the client.

This should probably be part of our defined behavior, and not just an implementation quirk.