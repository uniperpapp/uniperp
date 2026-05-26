"use client";

import { useMemo, useState } from "react";
import { TradePanel } from "./TradePanel";
import { SpotPanel } from "./SpotPanel";
import { StakingPanel } from "./StakingPanel";
import { useContracts } from "@/lib/contracts";

type Tab = "spot" | "leverage" | "stake";

/// Trade surface, version-aware:
///   launch  → [Spot | Leverage]            (perp engine, no staking)
///   v2 PERP → [Spot | Leverage | Stake]    (perp engine + staking)
///   v1      → [Leverage | Stake]           (legacy Boost engine, no v4 spot)
export function TradeStakeTabs() {
  const { version } = useContracts();

  const tabs = useMemo<Tab[]>(() => {
    const spot  = version === "v2" || version === "launch";
    const stake = version === "v1" || version === "v2";
    return [
      ...(spot ? (["spot"] as Tab[]) : []),
      "leverage" as Tab,
      ...(stake ? (["stake"] as Tab[]) : []),
    ];
  }, [version]);

  const [tab, setTab] = useState<Tab>(tabs[0]);

  // Keep the active tab valid if the version (and thus tab set) changes.
  const active = tabs.includes(tab) ? tab : tabs[0];

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 mb-3">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors border ${
              active === t
                ? "bg-accent/20 border-accent text-accent"
                : "bg-bg border-border text-muted hover:border-muted"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {active === "spot" ? <SpotPanel />
          : active === "leverage" ? <TradePanel />
          : <StakingPanel />}
      </div>
    </div>
  );
}
