import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import "./Popup.css";
import { CaptureStrategy, ClipFormat, ClippedContent, FormattedClip } from '../model';
import { ClipperPreview } from '../components/ClipperPreview';
import { TagManager } from '../components/TagManager';
import { ActionBar } from '../components/ActionBar';

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


  // Connect to background script and handle cleanup
  useEffect(() => {
    const port = browser.runtime.connect({ name: "popup" });
    return () => {
      port.disconnect();
    };
  }, []);

  const extractYouTubeData = async (tabId: number) => {
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const videoId = new URLSearchParams(window.location.search).get('v');
        const channelName = document.querySelector('#channel-name')?.textContent || '';
        const description = document.querySelector('#description-text')?.textContent || '';
        const views = document.querySelector('.view-count')?.textContent;
        const likes = document.querySelector('#top-level-buttons-computed ytd-toggle-button-renderer:first-child #text')?.textContent;
        const uploadDate = document.querySelector('#info-strings yt-formatted-string')?.textContent;

        return {
          videoId,
          channelName,
          description,
          views: views ? parseInt(views.replace(/[^0-9]/g, '')) : undefined,
          likes: likes ? parseInt(likes.replace(/[^0-9]/g, '')) : undefined,
          uploadDate
        };
      }
    });
    return result;
  };

  const extractGitHubData = async (tabId: number) => {
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const [owner, repo] = window.location.pathname.split('/').filter(Boolean);
        const description = document.querySelector('div[data-pjax="#js-repo-pjax-container"] p')?.textContent || '';
        const stars = document.querySelector('a[href$="/stargazers"] span')?.textContent;
        const forks = document.querySelector('a[href$="/network/members"] span')?.textContent;
        const language = document.querySelector('span[itemprop="programmingLanguage"]')?.textContent;
        const topics = Array.from(document.querySelectorAll('a[data-octo-click="topic_click"]')).map(el => el.textContent || '');
        const lastUpdated = document.querySelector('relative-time')?.getAttribute('datetime');

        return {
          owner,
          repo,
          description,
          stars: stars ? parseInt(stars.replace(/[^0-9]/g, '')) : undefined,
          forks: forks ? parseInt(forks.replace(/[^0-9]/g, '')) : undefined,
          language,
          topics,
          lastUpdated
        };
      }
    });
    return result;
  };

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
      if (url.hostname.includes('youtube.com') && url.pathname === '/watch') {
        pageContent.siteSpecificData = {
          youtube: await extractYouTubeData(currentTab.id!)
        };
        setSelectedFormat('media');
      } else if (url.hostname === 'github.com') {
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) { // It's a repo
          pageContent.siteSpecificData = {
            github: await extractGitHubData(currentTab.id!)
          };
          setSelectedFormat('code-repo');
        }
      }

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

    if (url.includes('youtube.com')) {
      tags.push('youtube', 'video');
      content.type = 'media';
      content.mediaType = 'video';
      if (content.siteSpecificData?.youtube?.channelName) {
        tags.push(content.siteSpecificData.youtube.channelName.toLowerCase().replace(/\s+/g, '-'));
      }
    }

    if (url.includes('github.com')) {
      tags.push('github', 'code');
      if (content.siteSpecificData?.github?.language) {
        tags.push(content.siteSpecificData.github.language.toLowerCase());
      }
      content.siteSpecificData?.github?.topics?.forEach(topic =>
        tags.push(topic.toLowerCase())
      );
    }

    if (content.type === 'media') tags.push('media');
    if (content.type === 'media' && content.mediaType === 'image') tags.push('image');
    if (content.type === 'media' && content.mediaType === 'video') tags.push('video');
    if (content.type === 'media' && content.mediaType === 'audio') tags.push('audio');
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
          author: clippedContent.siteSpecificData?.youtube?.channelName || '',
          content: content.text || '',
          engagement: clippedContent.siteSpecificData?.youtube ? {
            likes: clippedContent.siteSpecificData.youtube.likes,
            views: clippedContent.siteSpecificData.youtube.views
          } : undefined
        };
        break;

      case 'media':
        formattedContent = {
          ...baseContent,
          type: 'media',
          mediaType: (clippedContent.mediaType as 'image' | 'video' | 'audio') || 'image',
          url: clippedContent.url || '',
          ...(clippedContent.siteSpecificData?.youtube && {
            duration: 0, // Would need to extract from YouTube
          })
        };
        break;

      case 'code-repo':
        const githubData = clippedContent.siteSpecificData?.github;
        formattedContent = {
          ...baseContent,
          type: 'code-repo',
          platform: 'github',
          owner: githubData?.owner || '',
          repo: githubData?.repo || '',
          language: githubData?.language,
          stars: githubData?.stars,
          forks: githubData?.forks
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
