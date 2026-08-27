import { useCallback, useEffect, useState } from 'react';
import { Attachment } from '../types/session';
import './Attachments.css';

interface Props {
  attachments: Attachment[];
  // A sub-agent step's blobs live in that agent's own transcript, so the host
  // needs to be told which file to reach into.
  agentId?: string;
}

// Bytes stay on the host until a badge is opened: one screenshot is ~200 KB of
// base64, and a browser-driving session can carry dozens of them.
interface BlobState {
  loading: boolean;
  dataUrl?: string;
  error?: string;
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

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const Attachments = ({ attachments, agentId }: Props) => {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [blobs, setBlobs] = useState<Record<string, BlobState>>({});

  // The host answers every fetch on the panel's single message channel, so
  // each mounted row keeps only the replies addressed to its own blobs.
  useEffect(() => {
    const ids = new Set(attachments.map(a => a.id));
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== 'attachmentData' || !ids.has(message.id)) return;
      setBlobs(prev => ({
        ...prev,
        [message.id]:
          typeof message.data === 'string'
            ? {
                loading: false,
                dataUrl: `data:${message.mediaType || 'application/octet-stream'};base64,${message.data}`,
              }
            : { loading: false, error: message.error || 'Could not read the attachment.' },
      }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [attachments]);

  const toggle = useCallback(
    (attachment: Attachment) => {
      setOpenIds(prev => {
        const next = new Set(prev);
        if (next.has(attachment.id)) next.delete(attachment.id);
        else next.add(attachment.id);
        return next;
      });

      // Only images are previewed, so only they need the bytes here; a file
      // badge fetches nothing until the user actually asks to save it.
      if (attachment.kind !== 'image' || openIds.has(attachment.id)) return;
      setBlobs(prev => {
        if (prev[attachment.id]?.loading || prev[attachment.id]?.dataUrl) return prev;
        window.vscodeApi?.postMessage({ type: 'requestAttachment', id: attachment.id, agentId });
        return { ...prev, [attachment.id]: { loading: true } };
      });
    },
    [agentId, openIds]
  );

  const open = (attachment: Attachment) => {
    window.vscodeApi?.postMessage({
      type: 'openAttachment',
      id: attachment.id,
      name: attachment.name,
      agentId,
    });
  };

  const save = (attachment: Attachment) => {
    window.vscodeApi?.postMessage({
      type: 'saveAttachment',
      id: attachment.id,
      name: attachment.name,
      agentId,
    });
  };

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
              <button type="button" className="attachment-action" onClick={() => save(attachment)}>
                Save as…
              </button>
            </div>
          );
        }

        return (
          <div key={attachment.id} className="attachment-panel">
            {blob?.loading && <div className="attachment-panel-note">Loading…</div>}
            {blob?.error && <div className="attachment-panel-note error">{blob.error}</div>}
            {blob?.dataUrl && (
              <>
                <img
                  className="attachment-image"
                  src={blob.dataUrl}
                  alt={attachment.name}
                  title="Open in the system image viewer"
                  onClick={() => open(attachment)}
                />
                <div className="attachment-panel-actions">
                  <button type="button" className="attachment-action" onClick={() => open(attachment)}>
                    Open externally
                  </button>
                  <button type="button" className="attachment-action" onClick={() => save(attachment)}>
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
