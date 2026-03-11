import React, { memo } from "react";
import { Wallet, Activity, Users } from "lucide-react";
import { Button } from "../UI/Button";
import { Badge } from "../UI/Badge";
import { Address } from "viem";

interface NavbarProps {
  account: Address | null;
  status: string;
  builderCount: number;
  onConnect: () => void;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export const Navbar = memo(function Navbar({ account, status, builderCount, onConnect }: NavbarProps) {
  return (
    <nav className="navbar-glass">
      <div className="navbar-brand">
        <div className="brand-dot-pulse" />
        <span className="brand-text">Somnia<span className="brand-accent">Place</span></span>
      </div>

      <div className="navbar-actions">
        <Badge variant="info" icon={<Users size={14} />}>
          {builderCount} Builders
        </Badge>

        <div className="status-display">
          <Activity size={14} className="pulse-icon" />
          <span className="status-text">{status}</span>
        </div>

        <Button
          variant={account ? "secondary" : "primary"}
          icon={<Wallet size={16} />}
          onClick={onConnect}
          className={`wallet-button${account ? " wallet-button-connected" : ""}`}
          aria-label={account ? `Wallet connected: ${account}` : "Connect Wallet"}
        >
          {account ? (
            <span className="wallet-button-copy">
              <span className="wallet-button-state">Wallet Connected</span>
              <span className="wallet-button-address">{shortAddress(account)}</span>
            </span>
          ) : (
            "Connect Wallet"
          )}
        </Button>
      </div>
    </nav>
  );
});
