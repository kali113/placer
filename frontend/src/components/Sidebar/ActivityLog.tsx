import React, { memo, useRef, useEffect } from "react";
import { Zap, Clock } from "lucide-react";
import { Panel } from "../UI/Panel";
import { FeedEntry, type FeedLoadState } from "../../hooks/useReactivityStream";

interface ActivityLogProps {
  feed: FeedEntry[];
  state: FeedLoadState;
}

const feedKindIcons: Record<FeedEntry["kind"], string> = {
  pixel: "PX",
  territory: "TS",
  pattern: "PT",
  penalty: "!!",
  decay: "DC"
};

export const ActivityLog = memo(function ActivityLog({ feed, state }: ActivityLogProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTo({ top: 0, behavior: "smooth" });
  }, [feed]);

  let emptyMessage = "No on-chain activity found in recent history.";
  if (state === "loading") {
    emptyMessage = "Loading recent on-chain activity...";
  } else if (state === "error") {
    emptyMessage = "Unable to load recent activity. Live updates are still active.";
  }

  return (
    <Panel title="Live Activity" icon={<Zap size={18} />} delay={0.2}>
      <div className="activity-list-glass" ref={listRef}>
        {feed.length === 0 ? (
          <div className="empty-state-glass">{emptyMessage}</div>
        ) : (
          feed.slice(0, 30).map((entry) => (
            <div key={entry.id} className={`activity-item-glass kind-${entry.kind}`}>
              <div className="activity-badge-glass">{feedKindIcons[entry.kind]}</div>
              <div className="activity-msg-glass">{entry.message}</div>
              <div className="activity-time-glass">
                 <Clock size={10}/> {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
});
