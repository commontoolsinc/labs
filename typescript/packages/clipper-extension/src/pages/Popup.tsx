import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import "./Popup.css";

interface ClippedContent {
  type: 'text' | 'link' | 'image' | 'webpage';
  text?: string;
  url?: string;
  pageUrl: string;
  html?: string;
  title?: string;
}

export default function Popup() {
  const [clippedContent, setClippedContent] = useState<ClippedContent | null>(null);

  useEffect(() => {
    async function initializeContent() {
      // Check storage first for existing selection
      const { clipContent } = await browser.storage.local.get('clipContent');

      if (clipContent) {
        setClippedContent(clipContent);
        return;
      }

      // Get current tab info if no stored content
      const [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true
      });

      const pageContent: ClippedContent = {
        type: 'webpage',
        pageUrl: currentTab.url!,
        title: currentTab.title,
      };

      // Get page HTML
      const [{ result: html }] = await browser.scripting.executeScript({
        target: { tabId: currentTab.id! },
        func: () => document.documentElement.outerHTML,
      });

      pageContent.html = html;
      setClippedContent(pageContent);
    }

    initializeContent().catch(console.error);
  }, []);

  async function clearClipContent() {
    await browser.storage.local.remove('clipContent');
    setClippedContent(null);
  }

  function renderPreview() {
    if (!clippedContent) return <div>Loading...</div>;

    switch (clippedContent.type) {
      case 'text':
        return (
          <div className="preview-content">
            <h3>Selected Text</h3>
            <p>{clippedContent.text}</p>
            <div className="meta">
              <span>From: {clippedContent.pageUrl}</span>
            </div>
          </div>
        );

      case 'link':
        return (
          <div className="preview-content">
            <h3>Link</h3>
            <a href={clippedContent.url} target="_blank" rel="noopener noreferrer">
              {clippedContent.url}
            </a>
            <div className="meta">
              <span>From: {clippedContent.pageUrl}</span>
            </div>
          </div>
        );

      case 'image':
        return (
          <div className="preview-content">
            <h3>Image</h3>
            <img
              src={clippedContent.url}
              alt="Clipped content"
              style={{ maxWidth: '100%', height: 'auto' }}
            />
            <div className="meta">
              <span>From: {clippedContent.pageUrl}</span>
            </div>
          </div>
        );

      case 'webpage':
        return (
          <div className="preview-content">
            <h3>{clippedContent.title || 'Web Page'}</h3>
            <p>{clippedContent.pageUrl}</p>
            <div className="meta">
              <span>{clippedContent.html?.length} characters of HTML content</span>
            </div>
          </div>
        );
    }
  }

  return (
    <div className="clipper-popup">
      <div className="preview-section">
        {renderPreview()}
      </div>

      <div className="clipping-controls">
        {/* Format & tag controls will go here */}
      </div>

      <style>{`
        .clipper-popup {
          width: 100%;
          height: 100%;
        }

        .preview-section {
          border: 1px solid #ddd;
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 16px;
          background: #f9f9f9;
        }

        .preview-content {
          max-width: 100%;
          overflow-wrap: break-word;
          word-wrap: break-word;
          word-break: break-word;
        }

        .preview-content h3 {
          margin: 0 0 8px 0;
          font-size: 16px;
          color: #333;
        }

        .meta {
          margin-top: 8px;
          font-size: 12px;
          color: #666;
        }

        .clipping-controls {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
      `}</style>
    </div>
  );
}
