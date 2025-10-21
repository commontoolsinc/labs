import { DOMParser } from "./dom-parser.ts";
import { assert, assertObjectMatch } from "@std/assert";
import { FeedItem, parseRSSFeed } from "./rss-utils.ts";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>tag:www.githubstatus.com,2005:/history</id>
  <link rel="alternate" type="text/html" href="https://www.githubstatus.com"/>
  <link rel="self" type="application/atom+xml" href="https://www.githubstatus.com/history.atom"/>
  <title>GitHub Status - Incident History</title>
  <updated>2025-10-21T20:25:22Z</updated>
  <author>
    <name>GitHub</name>
  </author>
  <entry>
    <id>tag:www.githubstatus.com,2005:Incident/26837586</id>
    <published>2025-10-21T17:39:34Z</published>
    <updated>2025-10-21T17:39:34Z</updated>
    <link rel="alternate" type="text/html" href="https://www.githubstatus.com/incidents/v61nk2fpysnq"/>
    <title>Disruption with some GitHub services</title>
    <content type="html">&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;17:39&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - This incident has been resolved. Thank you for your patience and understanding as we addressed this issue. A detailed root cause analysis will be shared as soon as it is available.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;17:18&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - Mitigation continues, the impact is limited to Enterprise Cloud customers who have configured SAML at the organization level.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;17:11&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We continuing to work on mitigation of this issue.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;16:33&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We’ve identified the issue affecting some users with SAML/OIDC authentication and are actively working on mitigation. Some users may not be able to authenticate during this time.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;16:03&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We're seeing issues for a small amount of customers with SAML/OIDC authentication for GitHub.com users. We are investigating.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;16:00&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are currently investigating this issue.&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:www.githubstatus.com,2005:Incident/26833707</id>
    <published>2025-10-21T12:28:19Z</published>
    <updated>2025-10-21T12:28:19Z</updated>
    <link rel="alternate" type="text/html" href="https://www.githubstatus.com/incidents/qqd6b1xb63tq"/>
    <title>Incident with Actions</title>
    <content type="html">&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;12:28&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - This incident has been resolved. Thank you for your patience and understanding as we addressed this issue. A detailed root cause analysis will be shared as soon as it is available.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;11:59&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We were able to apply a mitigation and we are now seeing recovery.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;11:37&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We are seeing about 10% of Actions runs taking longer than 5 minutes to start, we're still investigating and will provide an update by 12:00 UTC.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;09:59&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We are still seeing delays in starting some Actions runs and are currently investigating. We will provide updates as we have more information.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;09:25&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We are seeing delays in starting some Actions runs and are currently investigating.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;09:12&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are investigating reports of degraded performance for Actions&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:www.githubstatus.com,2005:Incident/26820913</id>
    <published>2025-10-20T16:40:02Z</published>
    <updated>2025-10-21T20:25:22Z</updated>
    <link rel="alternate" type="text/html" href="https://www.githubstatus.com/incidents/9klytnsknx20"/>
    <title>Disruption with Grok Code Fast 1 in Copilot</title>
    <content type="html">&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;20&lt;/var&gt;, &lt;var data-var='time'&gt;16:40&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - From October 20th at 14:10 UTC until 16:40 UTC, the Copilot service experienced degradation due to an infrastructure issue which impacted the Grok Code Fast 1 model, leading to a spike in errors affecting 30% of users. No other models were impacted. The incident was caused due to an outage with an upstream provider.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;20&lt;/var&gt;, &lt;var data-var='time'&gt;16:39&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - The issues with our upstream model provider continue to improve, and Grok Code Fast 1 is once again stable in Copilot Chat, VS Code and other Copilot products.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;20&lt;/var&gt;, &lt;var data-var='time'&gt;16:07&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We are continuing to work with our provider on resolving the incident with Grok Code Fast 1 which is impacting 6% of users. We’ve been informed they are implementing fixes but users can expect some requests to intermittently fail until all issues are resolved.&lt;br /&gt;&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;20&lt;/var&gt;, &lt;var data-var='time'&gt;14:47&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We are experiencing degraded availability for the Grok Code Fast 1 model in Copilot Chat, VS Code and other Copilot products. This is due to an issue with an upstream model provider. We are working with them to resolve the issue.&lt;br /&gt;&lt;br /&gt;Other models are available and working as expected.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;20&lt;/var&gt;, &lt;var data-var='time'&gt;14:46&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are investigating reports of degraded performance for Copilot&lt;/p&gt;</content>
  </entry>
</feed>
`;

Deno.test("DOMParser/XML", () => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const entries = doc.getElementsByTagName("entry");
  assert(entries.length === 3, "Got 3 entries");
  const entry = entries[0]!;
  assert(
    entry.getElementsByTagName("link")[0]!.getAttribute("rel") ===
      "alternate",
    "Get attribute from element",
  );
  assert(
    entry.getElementsByTagName("title")[0]!.innerHTML ===
      "Disruption with some GitHub services",
    "Get innerHTML",
  );
  assert(
    entry.getElementsByTagName("title")[0]!.textContent ===
      "Disruption with some GitHub services",
    "Get textContent",
  );
});

Deno.test("parseRSSFeed()", () => {
  const entries = parseRSSFeed(
    xml,
    5,
    new Set(["tag:www.githubstatus.com,2005:Incident/26833707"]),
  );
  assert(
    entries.length === 2,
    "Expecting 2 entries after filtering one existing",
  );
  assertObjectMatch(entries[0], {
    author: "",
    id: "tag:www.githubstatus.com,2005:Incident/26837586",
    pubDate: "2025-10-21T17:39:34Z",
    title: "Disruption with some GitHub services",
    link: "https://www.githubstatus.com/incidents/v61nk2fpysnq",
    content:
      "&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;17:39&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - This incident has been resolved. Thank you for your patience and understanding as we addressed this issue. A detailed root cause analysis will be shared as soon as it is available.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;17:18&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - Mitigation continues, the impact is limited to Enterprise Cloud customers who have configured SAML at the organization level.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;17:11&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We continuing to work on mitigation of this issue.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;16:33&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We’ve identified the issue affecting some users with SAML/OIDC authentication and are actively working on mitigation. Some users may not be able to authenticate during this time.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;16:03&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We're seeing issues for a small amount of customers with SAML/OIDC authentication for GitHub.com users. We are investigating.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Oct &lt;var data-var='date'&gt;21&lt;/var&gt;, &lt;var data-var='time'&gt;16:00&lt;/var&gt; UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are currently investigating this issue.&lt;/p&gt;",
  } as FeedItem);
});
