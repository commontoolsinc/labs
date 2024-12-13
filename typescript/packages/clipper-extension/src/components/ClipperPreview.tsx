import { CaptureStrategy, ClippedContent } from "../model.js";

interface ClipperPreviewProps {
  content: ClippedContent;
  strategy: CaptureStrategy;
  hasSelectedContent: boolean;
  showRaw: boolean;
  onStrategyChange: (strategy: CaptureStrategy) => void;
  onShowRawChange: (showRaw: boolean) => void;
}

export function ClipperPreview({ content, strategy, hasSelectedContent, showRaw, onStrategyChange, onShowRawChange }: ClipperPreviewProps) {
  const previewContent = strategy === 'selection' ? content.selectedContent : content;

  return (
    <div className="preview-content">
      <select
        value={strategy}
        onChange={(e) => onStrategyChange(e.target.value as CaptureStrategy)}
        className="strategy-picker"
      >
        {hasSelectedContent && <option value="selection">Selected Content</option>}
        <option value="full-page">Full Page</option>
        <option value="readability">Reader View</option>
      </select>

      <div className="preview-tabs">
        <button
          className={!showRaw ? 'active' : ''}
          onClick={() => onShowRawChange(false)}
        >
          Preview
        </button>
        <button
          className={showRaw ? 'active' : ''}
          onClick={() => onShowRawChange(true)}
        >
          Raw Content
        </button>
      </div>

      {!showRaw ? (
        <MediaPreview content={content} previewContent={previewContent} />
      ) : (
        <RawContentView content={previewContent} />
      )}
    </div>
  );
}


// Media preview component
interface MediaPreviewProps {
  content: ClippedContent;
  previewContent: any;
}

export function MediaPreview({ content, previewContent }: MediaPreviewProps) {
  if (!content) return null;

  return (
    <div>
      {content.type === 'text' && (
        <div>
          <h3>Selected Text</h3>
          <p>{previewContent?.text}</p>
          <div className="meta">
            <span>From: {content.pageUrl}</span>
          </div>
        </div>
      )}

      {content.type === 'link' && (
        <div>
          <h3>Link</h3>
          <a href={content.url} target="_blank" rel="noopener noreferrer">
            {content.url}
          </a>
          <div className="meta">
            <span>From: {content.pageUrl}</span>
          </div>
        </div>
      )}

      {content.type === 'media' && (
        <div>
          <h3>Media</h3>
          {content.mediaType === 'image' && (
            <img
              src={content.url}
              alt="Clipped content"
              style={{ maxWidth: '100%', height: 'auto' }}
            />
          )}
          {content.mediaType === 'video' && (
            <video
              src={content.url}
              controls
              style={{ maxWidth: '100%', height: 'auto' }}
            />
          )}
          {content.mediaType === 'audio' && (
            <audio
              src={content.url}
              controls
              style={{ width: '100%' }}
            />
          )}
          <div className="meta">
            <span>From: {content.pageUrl}</span>
            {content.siteSpecificData?.youtube && (
              <div>
                <p>Channel: {content.siteSpecificData.youtube.channelName}</p>
                <p>Views: {content.siteSpecificData.youtube.views?.toLocaleString()}</p>
                <p>Likes: {content.siteSpecificData.youtube.likes?.toLocaleString()}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {content.type === 'webpage' && (
        <div>
          <h3>{content.title || 'Web Page'}</h3>
          <p>{content.pageUrl}</p>
          <div className="meta">
            <span>{previewContent?.html?.length || 0} characters of HTML content</span>
            {content.siteSpecificData?.github && (
              <div>
                <p>Owner: {content.siteSpecificData.github.owner}</p>
                <p>Repo: {content.siteSpecificData.github.repo}</p>
                <p>Stars: {content.siteSpecificData.github.stars?.toLocaleString()}</p>
                <p>Language: {content.siteSpecificData.github.language}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Raw content view component
export function RawContentView({ content }: { content: any }) {
  return (
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
          {JSON.stringify(content, null, 2)}
        </pre>
      </div>
    </div>
  );
}
