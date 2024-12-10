import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import "./Popup.css";

type ClipFormat = 'link' | 'article' | 'social-post' | 'media' | 'code-repo' | 'person';
type CaptureStrategy = 'selection' | 'full-page' | 'readability';

// Base clip content interfaces
interface BaseClipContent {
  sourceUrl: string;
  title?: string;
  snippet?: string;
  tags: string[];
  clippedAt: string;
}

interface ArticleClip extends BaseClipContent {
  type: 'article';
  authors?: string[];
  publishedDate?: string;
  content: string;
  readingTime?: number;
}

interface LinkClip extends BaseClipContent {
  type: 'link';
  url: string;
  favicon?: string;
}

interface SocialPostClip extends BaseClipContent {
  type: 'social-post';
  platform: string;
  author: string;
  content: string;
  engagement?: {
    likes?: number;
    shares?: number;
    comments?: number;
  };
}

interface MediaClip extends BaseClipContent {
  type: 'media';
  mediaType: 'image' | 'video' | 'audio';
  url: string;
  duration?: number;
  dimensions?: {
    width: number;
    height: number;
  };
}

interface CodeRepoClip extends BaseClipContent {
  type: 'code-repo';
  platform: string;
  owner: string;
  repo: string;
  language?: string;
  stars?: number;
  forks?: number;
}

interface PersonClip extends BaseClipContent {
  type: 'person';
  name: string;
  role?: string;
  company?: string;
  socialProfiles?: {
    platform: string;
    url: string;
  }[];
}

type ClippedContent = {
  type: 'text' | 'link' | 'media' | 'webpage';
  mediaType?: string;
  text?: string;
  url?: string;
  pageUrl: string;
  html?: string;
  title?: string;
  selectedContent?: {
    text?: string;
    html?: string;
  };
};

type FormattedClip = ArticleClip | LinkClip | SocialPostClip | MediaClip | CodeRepoClip | PersonClip;

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

        if (clipContent.type === 'text' && clipContent.selectedContent) {
          // Handle text selection - note the selectedContent structure matches exactly
          pageContent.selectedContent = clipContent.selectedContent;
          pageContent.type = clipContent.type;
        } else if (clipContent.type === 'link') {
          pageContent.type = clipContent.type;
          pageContent.url = clipContent.url;
          pageContent.selectedContent = {
            text: clipContent.url,
            html: `<a href="${clipContent.url}">${clipContent.url}</a>`
          };
        } else if (clipContent.type === 'media') {
          pageContent.type = clipContent.type;
          pageContent.url = clipContent.url;
          pageContent.mediaType = clipContent.mediaType;
          pageContent.selectedContent = {
            text: clipContent.url,
            html: `<img src="${clipContent.url}" />`
          };
        }
      } else {
        setHasSelectedContent(false);
        setCaptureStrategy('full-page');
      }

      setClippedContent(pageContent);
      generateAutoTags(pageContent);
    }

    initializeContent().catch(console.error);
  }, []);

  const generateAutoTags = (content: ClippedContent) => {
    const tags: string[] = [];
    const url = content.pageUrl;

    if (url.includes('youtube.com')) tags.push('youtube');
    if (url.includes('github.com')) tags.push('github');
    if (content.type === 'media') tags.push('media');
    if (content.type === 'media' && content.mediaType === 'image') {
      tags.push('image');
    }
    if (content.type === 'media' && content.mediaType === 'video') {
      tags.push('video');
    }
    if (content.type === 'media' && content.mediaType === 'audio') {
      tags.push('audio');
    }
    if (content.type === 'text') tags.push('text');

    setAutoTags(tags);
  };

  const handleFormatChange = (format: ClipFormat) => {
    setSelectedFormat(format);
  };

  const handleTagInput = (input: string) => {
    const newTags = input.split(',').map(tag =>
      tag.trim().startsWith('#') ? tag.trim() : `#${tag.trim()}`
    );
    setUserTags(newTags);
  };

  const getPayload = () => {
    if (!clippedContent) return null;

    const baseContent = {
      sourceUrl: clippedContent.pageUrl,
      title: clippedContent.title,
      tags: [...autoTags, ...userTags],
      clippedAt: new Date().toISOString()
    };

    const content = captureStrategy === 'selection' && clippedContent.selectedContent
      ? clippedContent.selectedContent
      : clippedContent;

    let formattedContent: FormattedClip;

    switch (selectedFormat) {
      case 'article':
        formattedContent = {
          ...baseContent,
          type: 'article',
          content: content.html || content.text || '',
          snippet: content.text?.substring(0, 200)
        };
        break;

      case 'link':
        formattedContent = {
          ...baseContent,
          type: 'link',
          url: clippedContent.url || clippedContent.pageUrl
        };
        break;

      case 'social-post':
        formattedContent = {
          ...baseContent,
          type: 'social-post',
          platform: new URL(clippedContent.pageUrl).hostname,
          author: '', // Would need additional parsing
          content: content.text || ''
        };
        break;

      case 'media':
        formattedContent = {
          ...baseContent,
          type: 'media',
          mediaType: (clippedContent.mediaType as 'image' | 'video' | 'audio') || 'image',
          url: clippedContent.url || ''
        };
        break;

      case 'code-repo':
        formattedContent = {
          ...baseContent,
          type: 'code-repo',
          platform: 'github', // Would need to handle other platforms
          owner: '',  // Would need parsing
          repo: ''    // Would need parsing
        };
        break;

      case 'person':
        formattedContent = {
          ...baseContent,
          type: 'person',
          name: clippedContent.title || ''
        };
        break;

      default:
        formattedContent = {
          ...baseContent,
          type: 'link',
          url: clippedContent.pageUrl
        };
    }

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

  function renderPreview() {
    if (!clippedContent) return <div>Loading...</div>;

    const payload = getPayload();
    const content = captureStrategy === 'selection' ?
      clippedContent.selectedContent :
      clippedContent;

    return (
      <div className="preview-content">
        <select
          value={captureStrategy}
          onChange={(e) => setCaptureStrategy(e.target.value as CaptureStrategy)}
          className="strategy-picker"
        >
          {hasSelectedContent && <option value="selection">Selected Content</option>}
          <option value="full-page">Full Page</option>
          <option value="readability">Reader View</option>
        </select>

        <div className="preview-tabs">
          <button
            className={!showRaw ? 'active' : ''}
            onClick={() => setShowRaw(false)}
          >
            Preview
          </button>
          <button
            className={showRaw ? 'active' : ''}
            onClick={() => setShowRaw(true)}
          >
            Raw Content
          </button>
        </div>

        {!showRaw ? (
          <div>
            {clippedContent.type === 'text' && (
              <div>
                <h3>Selected Text</h3>
                <p>{content?.text}</p>
                <div className="meta">
                  <span>From: {clippedContent.pageUrl}</span>
                </div>
              </div>
            )}

            {clippedContent.type === 'link' && (
              <div>
                <h3>Link</h3>
                <a href={clippedContent.url} target="_blank" rel="noopener noreferrer">
                  {clippedContent.url}
                </a>
                <div className="meta">
                  <span>From: {clippedContent.pageUrl}</span>
                </div>
              </div>
            )}

            {clippedContent.type === 'media' && (
              <div>
                <h3>Media</h3>
                {clippedContent.mediaType === 'image' && (
                  <img
                    src={clippedContent.url}
                    alt="Clipped content"
                    style={{ maxWidth: '100%', height: 'auto' }}
                  />
                )}
                {clippedContent.mediaType === 'video' && (
                  <video
                    src={clippedContent.url}
                    controls
                    style={{ maxWidth: '100%', height: 'auto' }}
                  />
                )}
                {clippedContent.mediaType === 'audio' && (
                  <audio
                    src={clippedContent.url}
                    controls
                    style={{ width: '100%' }}
                  />
                )}
                <div className="meta">
                  <span>From: {clippedContent.pageUrl}</span>
                </div>
              </div>
            )}

            {clippedContent.type === 'webpage' && (
              <div>
                <h3>{clippedContent.title || 'Web Page'}</h3>
                <p>{clippedContent.pageUrl}</p>
                <div className="meta">
                  <span>{content?.html?.length || 0} characters of HTML content</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="raw-section">
              <h4>Raw HTML/Content</h4>
              <pre>
                {content?.html || content?.text || JSON.stringify(content, null, 2)}
              </pre>
            </div>
            <div className="raw-section">
              <h4>Payload to Server</h4>
              <pre>
                {JSON.stringify(payload, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="clipper-popup">
      <div className="preview-section">
        {renderPreview()}
      </div>

      <div className="clipping-controls">
        <select
          value={selectedFormat}
          onChange={(e) => handleFormatChange(e.target.value as ClipFormat)}
        >
          <option value="link">Link</option>
          <option value="article">Article</option>
          <option value="social-post">Social Post</option>
          <option value="media">Media</option>
          <option value="code-repo">Code Repository</option>
          <option value="person">Person Profile</option>
        </select>

        <div>
          <div>Auto Tags: {autoTags.map(tag => <span key={tag}>#{tag} </span>)}</div>
          <input
            type="text"
            placeholder="Add tags (comma-separated)"
            onChange={(e) => handleTagInput(e.target.value)}
          />
        </div>

        <button onClick={handleClip}>Clip Content</button>
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

        .preview-tabs {
          display: flex;
          gap: 8px;
          margin-bottom: 16px;
        }

        .preview-tabs button {
          padding: 8px 16px;
          border: 1px solid #ddd;
          background: white;
          border-radius: 4px;
          cursor: pointer;
        }

        .preview-tabs button.active {
          background: #e0e0e0;
        }

        .raw-section {
          margin-bottom: 16px;
        }

        .raw-section h4 {
          margin: 0 0 8px 0;
        }

        .raw-section pre {
          max-width: 320px;
          background: #f0f0f0;
          padding: 12px;
          border-radius: 4px;
          max-height: 200px;
          overflow: auto;
          margin: 0;
          font-size: 12px;
        }

        .strategy-picker {
          position: absolute;
          top: 16px;
          left: 16px;
          z-index: 1;
        }
      `}</style>
    </div>
  );
}
