export type ClipFormat = 'link' | 'article' | 'social-post' | 'media' | 'code-repo' | 'person';
export type CaptureStrategy = 'selection' | 'full-page' | 'readability';

// Content Type Interfaces
export interface BaseClipContent {
  sourceUrl: string;
  title?: string;
  snippet?: string;
  tags: string[];
  clippedAt: string;
}

export interface ArticleClip extends BaseClipContent {
  type: 'article';
  authors?: string[];
  publishedDate?: string;
  content: string;
  readingTime?: number;
}

export interface LinkClip extends BaseClipContent {
  type: 'link';
  url: string;
  favicon?: string;
}

export interface SocialPostClip extends BaseClipContent {
  type: 'social-post';
  platform: string;
  author: string;
  content: string;
  engagement?: {
    likes?: number;
    shares?: number;
    comments?: number;
    views?: number;
  };
}

export interface MediaClip extends BaseClipContent {
  type: 'media';
  mediaType: 'image' | 'video' | 'audio';
  url: string;
  duration?: number;
  dimensions?: {
    width: number;
    height: number;
  };
}

export interface CodeRepoClip extends BaseClipContent {
  type: 'code-repo';
  platform: string;
  owner: string;
  repo: string;
  language?: string;
  stars?: number;
  forks?: number;
}

export interface PersonClip extends BaseClipContent {
  type: 'person';
  name: string;
  role?: string;
  company?: string;
  socialProfiles?: {
    platform: string;
    url: string;
  }[];
}

export type ClippedContent = {
  type: 'text' | 'link' | 'media' | 'webpage';
  mediaType?: string;
  text?: string;
  url?: string;
  pageUrl: string;
  html?: string;
  title?: string;
  pageScreenshot?: string; // base64 encoded screenshot
  previewImage?: string;  // URL or base64 of preview image
  selectedContent?: {
    text?: string;
    html?: string;
  };
  siteSpecificData?: {
    youtube?: {
      videoId: string;
      channelName: string;
      description: string;
      transcript?: string;
      views?: number;
      likes?: number;
      uploadDate?: string;
    };
    github?: {
      owner: string;
      repo: string;
      description: string;
      stars?: number;
      forks?: number;
      language?: string;
      topics?: string[];
      lastUpdated?: string;
    };
    twitter?: {
      author: string;
      handle: string;
      content: string;
      likes?: number;
      retweets?: number;
      replies?: number;
      postedAt?: string;
    };
  };
};

export type FormattedClip = ArticleClip | LinkClip | SocialPostClip | MediaClip | CodeRepoClip | PersonClip;
