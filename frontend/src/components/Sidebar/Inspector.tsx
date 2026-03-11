import React, { memo } from "react";
import { Map, User, Trophy, Calendar, Hash } from "lucide-react";
import { Panel } from "../UI/Panel";
import { DecodedPixel } from "../../lib/pixels";
import { palette } from "../../hooks/useCanvasBoard";

interface InspectorProps {
  x: number;
  y: number | null;
  colorId: number | null;
  pixel: DecodedPixel | null;
  ownerScore: bigint | null;
}

function shortAddress(address: string | null): string {
  if (!address) return "Unclaimed";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export const Inspector = memo(function Inspector({
  x,
  y,
  colorId,
  pixel,
  ownerScore
}: InspectorProps) {
  const displayColorId = pixel?.color ?? colorId;

  return (
    <Panel title="Pixel Inspector" icon={<Map size={18} />}>
      <div className="inspector-coords-glass">
        {y !== null ? `[${x}, ${y}]` : "[ -- , -- ]"}
      </div>

      <div className="inspector-grid-glass">
        <div className="inspector-card-glass">
          <span className="card-label-glass"><Hash size={12}/> Color</span>
          <div className="card-value-glass">
             <div
               className="color-preview-glass"
               style={{ backgroundColor: displayColorId !== null ? palette[displayColorId] : "#000" }}
             />
             {displayColorId !== null ? `ID ${displayColorId}` : "-"}
          </div>
        </div>

        <div className="inspector-card-glass">
          <span className="card-label-glass"><User size={12}/> Owner</span>
          <span className="card-value-glass">{shortAddress(pixel?.owner || null)}</span>
        </div>

        <div className="inspector-card-glass">
          <span className="card-label-glass"><Calendar size={12}/> Updated</span>
          <span className="card-value-glass small">
            {pixel?.lastUpdated ? new Date(pixel.lastUpdated * 1000).toLocaleString() : '-'}
          </span>
        </div>

        <div className="inspector-card-glass">
          <span className="card-label-glass"><Trophy size={12}/> Score</span>
          <span className="card-value-glass highlight">
            {ownerScore !== null ? `${ownerScore.toString()} pts` : '-'}
          </span>
        </div>
      </div>
    </Panel>
  );
});
