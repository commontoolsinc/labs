import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import "./Popup.css";
import { CaptureStrategy, ClipFormat, ClippedContent, FormattedClip } from '../model';
import { ClipperPreview } from '../components/ClipperPreview';
import { TagManager } from '../components/TagManager';
import { ActionBar } from '../components/ActionBar';
import { extractSiteSpecificData, formatClipContent, generateAutoTags, mapStoredClipToPageContent } from '../clipping';

export default function Popup() {
  const [clippedContent, setClippedContent] = useState<ClippedContent | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<ClipFormat>('link');
  const [captureStrategy, setCaptureStrategy] = useState<CaptureStrategy>('full-page');
  const [userTags, setUserTags] = useState<string[]>([]);
  const [autoTags, setAutoTags] = useState<string[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [hasSelectedContent, setHasSelectedContent] = useState(false);

  // Connect to background script and handle cleanup
  useEffect(() => {
    const port = browser.runtime.connect({ name: "popup" });
    return () => {
      port.disconnect();
    };
  }, []);

  useEffect(() => {
    async function initializeContent() {
      const [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true
      });

      // Initialize base page content
      const pageContent: ClippedContent = {
        type: 'webpage',
        pageUrl: currentTab.url!,
        title: currentTab.title,
      };

      // Extract site-specific data
      const url = new URL(currentTab.url!);
      const { suggestedFormat, ...siteData } = await extractSiteSpecificData(url, currentTab.id!);
      pageContent.siteSpecificData = siteData;
      setSelectedFormat(suggestedFormat);

      // Check for stored selection
      const stored = await browser.storage.local.get('clipContent');
      const clipContent = stored.clipContent as ClippedContent | undefined;

      // Always fetch full page HTML
      const [{ result: html }] = await browser.scripting.executeScript({
        target: { tabId: currentTab.id! },
        func: () => document.documentElement.outerHTML,
      });
      pageContent.html = html;

      // Handle stored selection if it exists
      if (clipContent) {
        setHasSelectedContent(true);
        setCaptureStrategy('selection');
        setClippedContent(mapStoredClipToPageContent(pageContent, clipContent));
      } else {
        setHasSelectedContent(false);
        setCaptureStrategy('full-page');
        setClippedContent(pageContent);
      }

      const tags = generateAutoTags(pageContent);
      setAutoTags(tags);
    }

    initializeContent().catch(console.error);
  }, []);

  const getPayload = () => {
    if (!clippedContent) return null;

    const formattedContent = formatClipContent(
      clippedContent,
      selectedFormat,
      captureStrategy,
      autoTags,
      userTags
    );

    return {
      format: selectedFormat,
      content: formattedContent,
      strategy: captureStrategy
    };
  };

  const handleClip = async () => {
    const payload = getPayload();
    if (!payload) return;

    try {
      const response = await fetch(process.env.INGESTION_SERVER_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error('Failed to clip content');

      await browser.storage.local.remove('clipContent');
    } catch (error) {
      console.error('Clipping failed:', error);
    }
  };

  return (
    <div className="clipper-popup">
      <div className="preview-section">
        {clippedContent && (
          <ClipperPreview
            content={clippedContent}
            strategy={captureStrategy}
            hasSelectedContent={hasSelectedContent}
            showRaw={showRaw}
            onStrategyChange={setCaptureStrategy}
            onShowRawChange={setShowRaw}
          />
        )}
      </div>

      <div className="clipping-controls">
        <ActionBar
          selectedFormat={selectedFormat}
          onFormatChange={setSelectedFormat}
          onClip={handleClip}
        />

        <TagManager
          autoTags={autoTags}
          userTags={userTags}
          onTagsChange={setUserTags}
        />
      </div>
    </div>
  );
}
