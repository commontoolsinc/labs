import { ClipFormat, ClippedContent, FormattedClip } from './model';
import browser from 'webextension-polyfill';

export const generateAutoTags = (content: ClippedContent): string[] => {
  const tags: string[] = [];
  const url = content.pageUrl;

  if (url.includes('youtube.com')) {
    tags.push('youtube', 'video');
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

  return tags;
};

export const formatClipContent = (
  clippedContent: ClippedContent,
  selectedFormat: ClipFormat,
  captureStrategy: string,
  autoTags: string[],
  userTags: string[]
): FormattedClip | null => {
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

  switch (selectedFormat) {
    case 'article':
      return {
        ...baseContent,
        type: 'article',
        content: content.html || content.text || '',
        snippet: content.text?.substring(0, 200)
      };

    case 'link':
      return {
        ...baseContent,
        type: 'link',
        url: clippedContent.url || clippedContent.pageUrl
      };

    case 'social-post':
      return {
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

    case 'media':
      return {
        ...baseContent,
        type: 'media',
        mediaType: (clippedContent.mediaType as 'image' | 'video' | 'audio') || 'image',
        url: clippedContent.url || '',
        ...(clippedContent.siteSpecificData?.youtube && {
          duration: 0, // Would need to extract from YouTube
        })
      };

    case 'code-repo':
      const githubData = clippedContent.siteSpecificData?.github;
      return {
        ...baseContent,
        type: 'code-repo',
        platform: 'github',
        owner: githubData?.owner || '',
        repo: githubData?.repo || '',
        language: githubData?.language,
        stars: githubData?.stars,
        forks: githubData?.forks
      };

    case 'person':
      return {
        ...baseContent,
        type: 'person',
        name: clippedContent.title || ''
      };

    default:
      return {
        ...baseContent,
        type: 'link',
        url: clippedContent.pageUrl
      };
  }
};

export const extractSiteSpecificData = async (url: URL, tabId: number) => {
  if (url.hostname.includes('youtube.com') && url.pathname === '/watch') {
    return {
      youtube: await extractYouTubeData(tabId),
      suggestedFormat: 'media' as const
    };
  }

  if (url.hostname === 'github.com') {
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      return {
        github: await extractGitHubData(tabId),
        suggestedFormat: 'code-repo' as const
      };
    }
  }

  return { suggestedFormat: 'link' as const };
};

export const mapStoredClipToPageContent = (
  pageContent: ClippedContent,
  storedClip: ClippedContent
): ClippedContent => {
  if (storedClip.type === 'text' && storedClip.selectedContent) {
    return {
      ...pageContent,
      type: storedClip.type,
      selectedContent: storedClip.selectedContent
    };
  }

  if (storedClip.type === 'link') {
    return {
      ...pageContent,
      type: storedClip.type,
      url: storedClip.url,
      selectedContent: {
        text: storedClip.url,
        html: `<a href="${storedClip.url}">${storedClip.url}</a>`
      }
    };
  }

  if (storedClip.type === 'media') {
    return {
      ...pageContent,
      type: storedClip.type,
      url: storedClip.url,
      mediaType: storedClip.mediaType,
      selectedContent: {
        text: storedClip.url,
        html: `<img src="${storedClip.url}" />`
      }
    };
  }

  return pageContent;
};

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
