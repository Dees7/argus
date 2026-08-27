import { useCallback, useEffect, useState } from 'react';
import { Attachment } from '../types/session';
import './Attachments.css';

// Bytes stay on the host until something on screen asks for them: one
// screenshot is ~200 KB of base64, and a browser-driving session can carry
// dozens of them.
export interface BlobState {
  loading: boolean;
  base64?: string;
  mediaType?: string;
  error?: string;
}

/**
 * Fetches attachment bytes from the extension host on request and caches them
 * for the life of the component. Shared with the raw tool view, which shows
 * the same payload as text instead of as a picture.
 */
export function useAttachmentBytes(attachments: Attachment[], agentId?: string) {
  const [blobs, setBlobs] = useState<Record<string, BlobState>>({});

  // The host answers every fetch on the panel's single message channel, so
  // each mounted view keeps only the replies addressed to its own blobs.
  useEffect(() => {
    const ids = new Set(attachments.map(a => a.id));
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== 'attachmentData' || !ids.has(message.id)) return;
      setBlobs(prev => ({
        ...prev,
        [message.id]:
          typeof message.data === 'string'
            ? { loading: false, base64: message.data, mediaType: message.mediaType }
            : { loading: false, error: message.error || 'Could not read the attachment.' },
      }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [attachments]);

  const request = useCallback(
    (id: string) => {
      setBlobs(prev => {
        if (prev[id]?.loading || prev[id]?.base64) return prev;
        window.vscodeApi?.postMessage({ type: 'requestAttachment', id, agentId });
        return { ...prev, [id]: { loading: true } };
      });
    },
    [agentId]
  );

  return { blobs, request };
}

export const dataUrl = (attachment: Attachment, blob: BlobState): string =>
  `data:${blob.mediaType || attachment.mediaType};base64,${blob.base64}`;

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Hand an attachment to whatever the OS opens that file type with. */
export const openAttachment = (attachment: Attachment, agentId?: string) => {
  window.vscodeApi?.postMessage({
    type: 'openAttachment',
    id: attachment.id,
    name: attachment.name,
    agentId,
  });
};

/** Write an attachment wherever the user points — the only route out for
 *  anything that is not an image. */
export const saveAttachment = (attachment: Attachment, agentId?: string) => {
  window.vscodeApi?.postMessage({
    type: 'saveAttachment',
    id: attachment.id,
    name: attachment.name,
    agentId,
  });
};

interface Props {
  attachments: Attachment[];
  // A sub-agent step's blobs live in that agent's own transcript, so the host
  // needs to be told which file to reach into.
  agentId?: string;
}

const ImageIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <circle cx="5.75" cy="6.25" r="1.15" />
    <path d="m2.5 11.5 3.25-3 2.5 2.25 2.5-2.25 3 2.75" strokeLinejoin="round" />
  </svg>
);

const FileIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M9.25 1.75H4.5a1.25 1.25 0 0 0-1.25 1.25v10a1.25 1.25 0 0 0 1.25 1.25h7a1.25 1.25 0 0 0 1.25-1.25V5.25z" strokeLinejoin="round" />
    <path d="M9.25 1.75v3.5h3.5" strokeLinejoin="round" />
  </svg>
);

const Attachments = ({ attachments, agentId }: Props) => {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const { blobs, request } = useAttachmentBytes(attachments, agentId);

  const toggle = useCallback(
    (attachment: Attachment) => {
      const wasOpen = openIds.has(attachment.id);
      setOpenIds(prev => {
        const next = new Set(prev);
        if (wasOpen) next.delete(attachment.id);
        else next.add(attachment.id);
        return next;
      });
      // Only images are previewed, so only they need the bytes here; a file
      // badge fetches nothing until the user actually asks to save it.
      if (!wasOpen && attachment.kind === 'image') request(attachment.id);
    },
    [openIds, request]
  );

  if (attachments.length === 0) return null;

  return (
    <div className="step-attachments">
      <div className="attachment-badges">
        {attachments.map(attachment => {
          const isOpen = openIds.has(attachment.id);
          return (
            <button
              key={attachment.id}
              type="button"
              className={`attachment-badge${isOpen ? ' open' : ''}`}
              onClick={() => toggle(attachment)}
              title={`${attachment.mediaType} · ${formatSize(attachment.size)}`}
            >
              {attachment.kind === 'image' ? <ImageIcon /> : <FileIcon />}
              <span className="attachment-name">{attachment.name}</span>
              <span className="attachment-size">{formatSize(attachment.size)}</span>
              <span className="attachment-caret">{isOpen ? '▾' : '▸'}</span>
            </button>
          );
        })}
      </div>

      {attachments.map(attachment => {
        if (!openIds.has(attachment.id)) return null;
        const blob = blobs[attachment.id];

        if (attachment.kind !== 'image') {
          return (
            <div key={attachment.id} className="attachment-panel">
              <div className="attachment-panel-note">
                {attachment.mediaType} — no preview. Save it to disk to open it yourself.
              </div>
              <button
                type="button"
                className="attachment-action"
                onClick={() => saveAttachment(attachment, agentId)}
              >
                Save as…
              </button>
            </div>
          );
        }

        return (
          <div key={attachment.id} className="attachment-panel">
            {blob?.loading && <div className="attachment-panel-note">Loading…</div>}
            {blob?.error && <div className="attachment-panel-note error">{blob.error}</div>}
            {blob?.base64 && (
              <>
                <img
                  className="attachment-image"
                  src={dataUrl(attachment, blob)}
                  alt={attachment.name}
                  title="Open in the system image viewer"
                  onClick={() => openAttachment(attachment, agentId)}
                />
                <div className="attachment-panel-actions">
                  <button
                    type="button"
                    className="attachment-action"
                    onClick={() => openAttachment(attachment, agentId)}
                  >
                    Open externally
                  </button>
                  <button
                    type="button"
                    className="attachment-action"
                    onClick={() => saveAttachment(attachment, agentId)}
                  >
                    Save as…
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default Attachments;
