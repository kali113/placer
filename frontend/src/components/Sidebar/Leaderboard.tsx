import React, { memo } from "react";
import { Trophy } from "lucide-react";
import { Panel } from "../UI/Panel";
import { LeaderboardEntry } from "../../hooks/useGameStats";

interface LeaderboardProps {
  entries: LeaderboardEntry[];
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export const Leaderboard = memo(function Leaderboard({ entries }: LeaderboardProps) {
  return (
    <Panel title="Top Builders" icon={<Trophy size={18} />} delay={0.1}>
      <div className="leaderboard-list-glass">
        {entries.length === 0 ? (
          <div className="empty-state-glass">No scored builders on-chain yet.</div>
        ) : (
          entries.map((entry, i) => (
            <div key={entry.address} className="leaderboard-item-glass">
              <div className="rank-badge-glass">{i + 1}</div>
              <div className="builder-info-glass">
                <span className="builder-address-glass">{shortAddress(entry.address)}</span>
                <span className="builder-stats-glass">{entry.placements.toString()} pixels</span>
              </div>
              <div className="builder-score-glass">{entry.score.toString()} pts</div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
});
