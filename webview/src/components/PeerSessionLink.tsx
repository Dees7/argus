import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How to find the session on the other end of a cross-session message. The
 * sender's row knows the target by name and by `msg_id`; the receiver's row
 * knows the sender by name, pid and the same `msg_id`. Either set resolves.
 */
export interface PeerQuery {
  msgId?: string;
  name?: string;
  pid?: number;
}

interface Resolution {
  found: boolean;
  sessionId?: string;
  cwd?: string;
  /** `registry` — the peer is still running; `transcript` — found by its files. */
  via?: 'registry' | 'transcript';
}

// Replies are matched to their request rather than to the component, so a
// panel with several of these open can't show one row's answer on another.
let nextKey = 0;

/**
 * The session a message came from or went to, resolved on the extension host.
 *
 * Opening the step asks the live registry only, which is a handful of small
 * files. A session that has since exited is found by scanning transcripts for
 * the message id both ends recorded — and that scan is the user's call to
 * make, or a timeline full of sends would read every transcript on disk just
 * because somebody expanded the rows.
 */
const PeerSessionLink = ({ query }: { query: PeerQuery }) => {
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [searching, setSearching] = useState(false);
  const keyRef = useRef('');
  const { msgId, name, pid } = query;

  const request = useCallback(
    (deep: boolean) => {
      window.vscodeApi?.postMessage({
        type: 'resolvePeerSession',
        key: keyRef.current,
        msgId,
        name,
        pid,
        deep,
      });
    },
    [msgId, name, pid]
  );

  useEffect(() => {
    if (!window.vscodeApi) {
      return;
    }

    keyRef.current = `peer-${nextKey++}`;
    const key = keyRef.current;
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === 'peerSessionResolved' && message.key === key) {
        setSearching(false);
        setResolution({
          found: !!message.found,
          sessionId: message.sessionId,
          cwd: message.cwd,
          via: message.via,
        });
      }
    };

    window.addEventListener('message', onMessage);
    request(false);

    return () => window.removeEventListener('message', onMessage);
  }, [request]);

  const open = () => {
    window.vscodeApi?.postMessage({ type: 'openPeerSession', msgId, name, pid });
  };

  if (!resolution) {
    return <span className="tr-meta">Locating session…</span>;
  }

  // Not running — which is the normal state for anything but the last few
  // minutes of a session's life, so it is offered as a search, not an error.
  if (!resolution.found) {
    return (
      <>
        <span className="tr-meta" title="No running session matches this message">
          {searching ? 'Searching transcripts…' : 'Session has exited'}
        </span>
        {msgId && !searching && (
          <button
            className="tr-toggle-btn"
            onClick={() => {
              setSearching(true);
              request(true);
            }}
            type="button"
            title="Search the transcripts for the session that recorded this message id"
          >
            Find session
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <span className="tr-meta tr-mono">{resolution.sessionId}</span>
      {resolution.cwd && <span className="tr-meta">{resolution.cwd}</span>}
      {/* A session found through the registry is still running — worth saying,
          because its transcript will keep growing after this panel opens. */}
      {resolution.via === 'registry' && <span className="tr-badge tr-badge-info">running</span>}
      <button className="tr-toggle-btn" onClick={open} type="button">
        Open session
      </button>
    </>
  );
};

export default PeerSessionLink;
