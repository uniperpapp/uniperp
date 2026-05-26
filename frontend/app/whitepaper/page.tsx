import Link from "next/link";
import Image from "next/image";
import { IS_X_LAYER, FACTORY_ADDRESS, POOL_MANAGER, CANDIDATE_BASES } from "@/lib/config";

// X Layer whitepaper — hackathon-pitched, v4-hook-native framing. Selected by
// app/whitepaper/page.tsx when IS_X_LAYER is true. The mainnet whitepaper lives
// in ./mainnet.tsx and is unchanged from the original v2 PERP paper.

// ── tiny presentational helpers ──────────────────────────────────────────────
function Eq({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 rounded-lg border border-border bg-panel px-5 py-4 text-center text-[15px] leading-relaxed tracking-wide text-text overflow-x-auto">
      {children}
    </div>
  );
}
function C({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-panel px-1 text-[0.95em] text-accent">{children}</span>;
}
function Sec({ id, n, title, children }: { id: string; n: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-border pt-10 mt-10 first:mt-0 first:border-0 first:pt-0">
      <h2 className="text-xl font-semibold text-text mb-4">
        <span className="text-muted mr-3 tabular-nums">{n}</span>{title}
      </h2>
      <div className="space-y-4 text-[14.5px] leading-7 text-text/90">{children}</div>
    </section>
  );
}
function Th({ children, r }: { children: React.ReactNode; r?: boolean }) {
  return <th className={`px-3 py-2 text-[11px] uppercase tracking-wider text-muted font-normal ${r ? "text-right" : "text-left"}`}>{children}</th>;
}
function Td({ children, r, c }: { children: React.ReactNode; r?: boolean; c?: string }) {
  return <td className={`px-3 py-1.5 tabular-nums ${r ? "text-right" : ""} ${c ?? ""}`}>{children}</td>;
}

// ── per-chain deployment data ────────────────────────────────────────────────
const EXPLORER = IS_X_LAYER
  ? { base: "https://www.oklink.com/xlayer/address/", name: "OKLink" }
  : { base: "https://etherscan.io/address/", name: "Etherscan" };

const CHAIN_LABEL = IS_X_LAYER ? "X Layer mainnet · chain 196" : "Ethereum mainnet · chain 1";

const HOOK_DEPLOYER = IS_X_LAYER
  ? "0x1E1B31c2c92b17a0BDbDD32E34AB7000763f224f"
  : "—"; // mainnet HookDeployer address — see factory.hookDeployer() on-chain

function Addr({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const isHex = /^0x[0-9a-fA-F]{40}$/.test(value);
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-2 last:border-0">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
        {sub && <div className="text-[11px] text-muted/80">{sub}</div>}
      </div>
      {isHex ? (
        <a
          href={`${EXPLORER.base}${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12.5px] font-mono text-accent hover:underline truncate"
        >
          {value}
        </a>
      ) : (
        <span className="text-[12.5px] font-mono text-muted">{value}</span>
      )}
    </div>
  );
}

export default function Whitepaper() {
  return (
    <div className="h-screen overflow-auto bg-bg text-text">
      {/* top bar */}
      <header className="sticky top-0 z-10 h-14 px-5 flex items-center justify-between border-b border-border bg-panel/95 backdrop-blur">
        <Link href="/" className="flex items-center gap-2 group">
          <Image src="/logo.png" alt="uniperp" width={26} height={26} />
          <span className="text-accent text-lg font-bold tracking-tight">uniperp</span>
          <span className="text-muted text-xs ml-2 group-hover:text-text transition-colors">← back to app</span>
        </Link>
        <span className="text-muted text-[11px] uppercase tracking-[0.15em]">Whitepaper · {IS_X_LAYER ? "X Layer" : "Mainnet"}</span>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-12">
        {/* title block */}
        <div className="mb-8">
          <div className="text-[11px] uppercase tracking-[0.2em] text-accent/80 mb-3">
            Perp DEX powered by Uniswap v4 hooks
          </div>
          <h1 className="text-3xl font-bold text-text leading-tight">
            Uniperp: a Perp DEX encoded entirely inside a Uniswap v4 hook.
          </h1>
          <p className="mt-4 text-muted text-[14.5px] leading-7">
            Uniperp turns a single Uniswap v4 pool into a full perp market: spot buys &amp; sells,
            3× leveraged longs &amp; shorts, on-chain borrow/lend, and TWAP-based liquidation —
            all carried by the hook&apos;s callbacks (<C>beforeInitialize</C>, <C>beforeSwap</C>,
            <C>afterSwap</C>, plus return-delta variants). No external lender, no oracle, no
            funding rate. Pools are spun up by a permissionless factory, so anyone can list a
            new market against any whitelisted base asset and start trading it with leverage
            from the first block. This paper walks the hook architecture, the math, the live
            on-chain deployment, and the risks.
          </p>
        </div>

        {/* TL;DR badges */}
        <div className="mb-12 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px]">
          {[
            ["v4-hook-native", "all logic in hook callbacks"],
            ["Decimal-generic", "any standard ERC-20 base (6/8/18d)"],
            ["Spot + perps", "in the same v4 pool"],
            ["No funding rate", "one-time borrow fee at open"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-panel px-3 py-2">
              <div className="text-accent font-semibold">{k}</div>
              <div className="text-muted text-[11px] leading-tight mt-0.5">{v}</div>
            </div>
          ))}
        </div>

        {/* Live deployments card */}
        <div className="mb-12 rounded-lg border border-accent/30 bg-accent/[0.04] px-5 py-4">
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-accent">Live deployment</div>
            <div className="text-[11px] text-muted">{CHAIN_LABEL}</div>
          </div>
          <div className="divide-y divide-border/40">
            <Addr label="Perpfactory" sub="deploys per-launch token + hook + lens" value={FACTORY_ADDRESS} />
            <Addr label="HookDeployer" sub="CREATE2 sidecar bound 1:1 to the factory" value={HOOK_DEPLOYER} />
            <Addr label="Uniswap v4 PoolManager" sub="singleton; every launch is a real v4 pool on it" value={POOL_MANAGER} />
          </div>
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Whitelisted base assets ({CANDIDATE_BASES.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {CANDIDATE_BASES.map((b) => (
                <a
                  key={b.address}
                  href={`${EXPLORER.base}${b.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] px-2 py-0.5 rounded border border-border text-text/80 hover:text-accent hover:border-accent transition-colors"
                  title={`${b.name} · ${b.decimals}d`}
                >
                  ${b.symbol}
                </a>
              ))}
            </div>
          </div>
          <p className="mt-4 text-[12px] text-muted leading-6">
            Each launched token mints a fresh <em>per-launch hook</em> (CREATE2, salt-mined so the
            low 14 bits of the address carry the v4 hook-permission flag bits). The full list of
            launched hooks is the directory on the <Link href="/" className="text-accent hover:underline">main page</Link>.
            All contracts verifiable on {EXPLORER.name}.
          </p>
        </div>

        {/* TOC */}
        <nav className="mb-12 rounded-lg border border-border bg-panel px-5 py-4 text-[13px]">
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Contents</div>
          <ol className="space-y-1 text-text/80">
            {[
              ["hook", "1", "Why a v4 hook (and what it enables)"],
              ["arch", "2", "Hook permissions & callback architecture"],
              ["curve", "3", "The bonding curve"],
              ["buying", "4", "Buying & selling on the curve"],
              ["leverage", "5", "Leveraged longs & shorts"],
              ["liquidation", "6", "Liquidation"],
              ["pnl", "7", "PnL & break-even"],
              ["bands", "8", "Where the borrowed liquidity comes from"],
              ["fees", "9", "Fees"],
              ["params", "10", "Parameters"],
              ["risks", "11", "Risk disclosures"],
            ].map(([id, n, t]) => (
              <li key={id}>
                <a href={`#${id}`} className="hover:text-accent transition-colors">
                  <span className="text-muted mr-2 tabular-nums">{n}</span>{t}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* ── 1 ── Why a v4 hook */}
        <Sec id="hook" n="1" title="Why a v4 hook (and what it enables)">
          <p>
            Uniswap v4 lets a hook contract <em>intercept the lifecycle</em> of a pool — pool
            initialization, liquidity adds/removes, and every swap, both before and after the
            swap math runs, with the option to return a custom delta that the PoolManager
            applies. We use every one of those hooks to build a perp DEX on top of an honest
            v4 pool, with the bonding curve + leverage engine living inside the hook itself:
          </p>
          <ul className="list-disc pl-6 space-y-1.5 marker:text-muted">
            <li>
              <strong>The pool IS the curve.</strong> At <C>create()</C>, the hook seeds the
              v4 pool with <C>300</C> stacked LP positions covering the bonding-curve range
              (each spanning a <C>W</C>-wide window of cumulative base flow). The hook is the
              sole LP. The v4 LP primitives literally execute the bonding curve.
            </li>
            <li>
              <strong>Spot + perps share state.</strong> A spot buy and a leveraged open both
              flow through the same v4 swap; <em>afterSwap</em> updates one <C>curveEth</C>
              counter, one TWAP, one set of per-band reserves. No price oracle drift, no
              divergence between &ldquo;the AMM&rdquo; and &ldquo;the perp engine&rdquo;.
            </li>
            <li>
              <strong>Hook-native borrow.</strong> Leverage borrows from already-passed bands
              (base side) or not-yet-touched bands (TOKEN side), via the PoolManager&apos;s
              lock/take/settle primitives — no external lender, no oracle dependency, no
              funding rate.
            </li>
            <li>
              <strong>Decimal-generic engine.</strong> <C>V</C>, <C>K</C>, <C>W</C>, debt, and
              sqrtPrice all work in the base&apos;s raw units. Same hook code launches against
              WOKB (18d), USDC (6d), or WBTC (8d) — V/W are calibrated per-base by the admin
              to hit the same USD-FDV target. The audit suite sweeps 6/8/18-dec bases.
            </li>
            <li>
              <strong>No graduation / no migration.</strong> Conventional launchpads move
              tokens off their custom AMM onto a DEX once a threshold is hit. Here the token
              already <em>is</em> on the DEX — the bonding-pool acts as a price floor under
              the curve and the freely-traded market above it. Leverage works inside the
              curve&apos;s range either way.
            </li>
          </ul>
          <p className="text-muted text-[13px]">
            The judging axis the hackathon scores Innovation on — &ldquo;novel mechanism on
            top of the v4 curve, not a port&rdquo; — describes exactly this design.
          </p>
        </Sec>

        {/* ── 2 ── Hook architecture */}
        <Sec id="arch" n="2" title="Hook permissions & callback architecture">
          <p>
            The hook&apos;s address carries the v4 hook-permission flag bits encoded in its
            low 14 bits. Our flag value is <C>0x2ACC</C> — seven bits set:
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-panel">
                <tr className="border-b border-border">
                  <Th>Bit</Th><Th>Callback</Th><Th>Role</Th>
                </tr>
              </thead>
              <tbody className="text-text/85">
                {[
                  ["0x2000", "beforeInitialize", "Enforce that initialization runs at the exact tick the bonding curve dictates."],
                  ["0x0800", "beforeAddLiquidity", "Block external LPs — only the hook itself can add liquidity."],
                  ["0x0200", "beforeRemoveLiquidity", "Block external LP withdrawal."],
                  ["0x0080", "beforeSwap", "Take the 1% spot fee, anti-snipe gate (first 3 blocks), per-block borrow accounting, and the leveraged-buy fast path."],
                  ["0x0040", "afterSwap", "Update curveEth, observe TWAP, rebalance bands, run liquidation scan (rate-limited)."],
                  ["0x0008", "beforeSwap returnsDelta", "Return a custom delta so internal swaps (leveraged open / close) bypass the spot LP fee."],
                  ["0x0004", "afterSwap returnsDelta", "Symmetric return-delta path for the post-swap leg."],
                ].map((r, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <Td c="font-mono text-accent">{r[0]}</Td>
                    <Td c="font-mono">{r[1]}</Td>
                    <Td>{r[2]}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Because v4 enforces the flag bits at swap time by reading the hook address, the
            factory must <em>mine</em> a CREATE2 salt whose hook address has exactly those
            low bits. The frontend does this in a Web Worker; create() reverts if the salt is
            wrong. The token salt is mined to the same factory CREATE2 space with an ordering
            constraint (<C>token &gt; base</C>) so the v4 pool key&apos;s currency ordering is
            fixed at launch.
          </p>
          <p>
            Hot state during a swap (per-block borrow tally, reentrancy guard) lives in EVM
            <em> transient storage</em> (TSTORE/TLOAD) — cleared at the end of every tx and
            gas-free vs. SSTORE. The TWAP rides on v4&apos;s built-in observation buffer; the
            5-minute window is the liquidation oracle (§6).
          </p>
        </Sec>

        {/* ── 3 ── Bonding curve */}
        <Sec id="curve" n="3" title="The bonding curve">
          <p>
            The curve is a <em>constant product</em>. Two reserves: a base-asset reserve and a
            token reserve. Their product is invariant:
          </p>
          <Eq>realTOKEN &nbsp;×&nbsp; (V + E) &nbsp;=&nbsp; K</Eq>
          <p>
            <C>E</C> is the cumulative <em>base</em> bought into the curve, <C>realTOKEN</C> is
            the token still inside the curve, and <C>V</C> is a virtual base reserve that sets
            the launch price and damps early-buy impact. <C>K = totalSupply × V</C>, so at
            launch <C>realTOKEN = 1,000,000</C> tokens (all supply starts in the curve).
          </p>
          <p>The price of one token, in base units, follows from constant-product:</p>
          <Eq>P(E) &nbsp;=&nbsp; (V + E)<sup>2</sup> &nbsp;/&nbsp; K</Eq>
          <p>
            Price grows with the <em>square</em> of curve level. Total supply is fixed at
            <C> 1,000,000 </C> per launch. <C>V</C> and the band width <C>W</C> are admin-set
            per base, calibrated so every launch opens at the same USD FDV regardless of which
            base it&apos;s paired against:
          </p>
          <Eq>
            V<sub>base</sub>(human) &nbsp;=&nbsp; target<sub>USD</sub> &nbsp;/&nbsp; base<sub>USD</sub>
            &nbsp;&nbsp;&nbsp;&nbsp; W<sub>base</sub> &nbsp;=&nbsp; V<sub>base</sub> &nbsp;×&nbsp; 10/7
          </Eq>
          <p className="text-muted text-[13px]">
            <C>target<sub>USD</sub></C> is the opening USD FDV the admin targets at whitelist time
            (≈ $7,500 across every base, so a launch is the same &ldquo;size&rdquo; in USD whether
            you pair against WOKB or USDC). The audited <C>W/V = 10/7</C> ratio keeps band
            geometry self-similar across bases; <C>10/7</C> ≈ <C>1.4286</C>, so with current
            calibration: a WOKB launch&apos;s W ≈ <C>95.7</C> WOKB (≈ $10.7K at OKB ≈ $112);
            a USDC launch&apos;s W ≈ <C>10,696</C> USDC. The protocol&apos;s economic floors
            (minimum collateral, anti-flash-loan caps, bad-debt thresholds) all derive from
            <C>W</C>, so they auto-scale per base without any per-base tuning.
          </p>
        </Sec>

        {/* ── 4 ── */}
        <Sec id="buying" n="4" title="Buying & selling on the curve">
          <p>
            A plain spot buy of <C>ΔE</C> base moves the curve level from <C>E</C> to
            <C>E + ΔE</C> and pays out the difference in token reserves:
          </p>
          <Eq>
            TOKEN out &nbsp;=&nbsp; realTOKEN(E) − realTOKEN(E + ΔE) &nbsp;=&nbsp; K · ΔE &nbsp;/&nbsp; [ (V + E)(V + E + ΔE) ]
          </Eq>
          <p>
            Selling reverses it: feed token back, curve level drops, you receive base. Because
            price is convex, you always sell into a falling price — the bigger the sale, the
            worse the average fill. A <C>1%</C> spot fee, taken in the base asset, applies to
            every direct spot swap routed through the v4 pool (via the hook&apos;s
            <em> beforeSwap </em>callback). Swaps the protocol performs internally for leverage
            (the leveraged buy on open, the sell-back on close, the forced sale on a
            liquidation) bypass this fee via the custom-delta return path (§2) — leverage has
            its own fee schedule (§9).
          </p>
        </Sec>

        {/* ── 5 ── Leverage */}
        <Sec id="leverage" n="5" title="Leveraged longs & shorts">
          <p>
            Open a position with two inputs: collateral <C>C</C> (in base) and leverage <C>L</C> ∈ {"{2, 3}"}.
            The hook then (long shown; short is the mirror — borrow token, sell for base):
          </p>
          <ol className="list-decimal pl-6 space-y-2 marker:text-muted">
            <li>Borrows <C>B = C · (L − 1)</C> base from the curve&apos;s already-passed bands (§8).</li>
            <li>
              Takes a <C>1%</C> origination fee on the borrow — <C>f = 0.01 · B</C> — routed
              to the leverage-fee recipient. Effective collateral becomes <C>C′ = C − f</C>.
            </li>
            <li>
              Buys token with <C>C′ + B</C> base via the v4 PoolManager. The hook returns a
              custom delta so this internal swap does <em>not</em> pay the 1% spot LP fee.
            </li>
            <li>Holds <C>H</C> token as your position; you owe debt <C>D = B</C> base to the curve.</li>
          </ol>
          <p>Exposure is roughly <C>L ×</C> collateral, financed by a one-time origination fee — no funding rate. The position&apos;s value at any later price <C>P</C> is just <C>H · P</C>. Safety is tracked by a <em>health ratio</em>:</p>
          <Eq>Health &nbsp;=&nbsp; (position value) / (debt) &nbsp;=&nbsp; (H · P) / D</Eq>
          <p>
            Ignoring fees: at open <C>H ≈ L·C / P<sub>entry</sub></C> and <C>D = (L−1)·C</C>, so
          </p>
          <Eq>
            Health<sub>entry</sub> &nbsp;≈&nbsp; L / (L − 1) &nbsp;&nbsp;&nbsp;&nbsp; → &nbsp;&nbsp; 3×: 150% &nbsp;·&nbsp; 2×: 200%
          </Eq>
          <p>Higher leverage = thinner buffer between your entry health and the liquidation line.</p>
        </Sec>

        {/* ── 6 ── Liquidation */}
        <Sec id="liquidation" n="6" title="Liquidation">
          <p>A position is liquidated the moment health falls to <C>1.05</C> (105%):</p>
          <Eq>Health ≤ 1.05 &nbsp;&nbsp;⇒&nbsp;&nbsp; liquidate</Eq>
          <p>
            Solving for the price at which that happens gives a clean result depending only on
            leverage:
          </p>
          <Eq>P<sub>liq</sub> &nbsp;=&nbsp; P<sub>entry</sub> · 1.05 · (L − 1) / L</Eq>
          <p>In words — the percentage move from entry that triggers liquidation:</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-panel">
                <tr className="border-b border-border">
                  <Th>Leverage</Th>
                  <Th r>Entry health</Th>
                  <Th r>Liq. factor</Th>
                  <Th r>Price move to liq.</Th>
                </tr>
              </thead>
              <tbody className="text-text/85">
                {[
                  ["2× long",  "200%", "0.525",  "−47.5%"],
                  ["3× long",  "150%", "0.700",  "−30.0%"],
                  ["2× short", "200%", "1.905",  "+90.5%"],
                  ["3× short", "150%", "1.429",  "+42.9%"],
                ].map((row, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <Td>{row[0]}</Td><Td r>{row[1]}</Td><Td r>{row[2]}</Td><Td r c="text-danger">{row[3]}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <strong>The health check uses a 5-minute TWAP, not instantaneous spot.</strong> A
            single-block price spike — a flash dump, a sandwich — moves spot but barely budges
            a 5-minute average, so it cannot manufacture liquidations out of healthy positions.
            Liquidation does <em>not</em> fire-sell — the position is seized whole into a
            protocol reserve (rate-limited per block), so no forced-sale cascade can spiral.
          </p>
          <p>
            <strong>Partial closes make positions safer.</strong> Closing part of a position
            repays debt first, which pushes the live <C>P<sub>liq</sub></C> away from current
            price:
          </p>
          <Eq>P<sub>liq</sub> (live) &nbsp;=&nbsp; 1.05 · (current debt) / (current holding)</Eq>
          <p>
            <strong>Bad debt.</strong> In a severe drawdown a liquidation sale can recover less
            base than the debt owed. The shortfall is a realized loss to the protocol —
            recorded openly on-chain (a public bad-debt counter) rather than hidden — and is
            healed over time from the insurance fund and seized-collateral reserve, never from
            other users&apos; funds.
          </p>
        </Sec>

        {/* ── 7 ── PnL */}
        <Sec id="pnl" n="7" title="PnL & break-even">
          <p>
            On close: the hook sells the requested fraction of your token back into the curve
            (no spot LP fee — internal swap), repays your debt first, credits the surplus
            minus a <C>1%</C> close fee. You withdraw what&apos;s credited with a separate
            <em> claim</em> call. Profit on a full close is approximately:
          </p>
          <Eq>profit &nbsp;≈&nbsp; (H · P<sub>close</sub> − D) · 0.99 &nbsp;−&nbsp; C</Eq>
          <p>
            The only frictions are the <C>1%</C> origination fee at open (on the borrowed
            amount) and the <C>1%</C> close fee at exit (on the surplus). Setting profit to
            zero, the favorable price move just to recover collateral works out to roughly:
          </p>
          <Eq>break-even move &nbsp;≈&nbsp; +1%&nbsp;–&nbsp;2%</Eq>
          <p className="text-muted text-[13px]">
            About the same at every leverage because round-trip friction is ~1% of the
            <em> position notional </em>regardless of <C>L</C>. A losing close pays no close
            fee at all. For an asset that routinely moves tens of percent, this is a small
            tax — but a position that drifts sideways bleeds it.
          </p>
        </Sec>

        {/* ── 8 ── Bands */}
        <Sec id="bands" n="8" title="Where the borrowed liquidity comes from">
          <p>
            The smooth curve is realized as <C>300</C> stacked v4 LP positions — <em>bands</em>
            — each covering a <C>W</C>-wide window of cumulative base flow (band <C>i</C>
            covers <C>[i·W, (i+1)·W)</C>). Each band is born holding only token; as buyers push
            the curve level through a band&apos;s window, that band converts from token into
            base. A band the curve level has already moved past is therefore pure base — and
            that idle base is what leveraged longs borrow. Shorts are the mirror: they borrow
            token from bands the price has not yet reached, and sell it.
          </p>
          <p>
            A borrow draws the protocol reserve first, then bands. No band is ever drained
            more than <C>40%</C> (long) / <C>25%</C> (short), and a hard <em>per-block</em>
            borrow cap of <C>W</C> base-equivalent (anti-flash-loan) bounds how much can be
            borrowed in any single block regardless of source. On close, repaid funds go back
            to bands (refill first, then deepen the curve) — never to the reserve; the
            reserve is fed only by liquidation seizes.
          </p>
          <p>
            Borrowing and refilling only ever touch fully-passed (base-only) or fully-ahead
            (token-only) bands, never the live band straddling the current price — so the
            curve&apos;s price function stays exactly intact and leverage never distorts the
            published price.
          </p>
        </Sec>

        {/* ── 9 ── Fees */}
        <Sec id="fees" n="9" title="Fees">
          <p>
            Three fees, each on a different event. <strong>No transaction ever pays more than
            one of them.</strong>
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-panel">
                <tr className="border-b border-border">
                  <Th>Fee</Th><Th r>Rate</Th><Th>Charged on</Th><Th>Goes to</Th>
                </tr>
              </thead>
              <tbody className="text-text/85">
                <tr className="border-b border-border/40">
                  <Td>Spot fee</Td><Td r>1%</Td><Td>Each direct spot buy/sell (in base). Not the leveraged buy or close sell-back.</Td><Td>protocol fee recipient</Td>
                </tr>
                <tr className="border-b border-border/40">
                  <Td>Borrow origination</Td><Td r>1%</Td><Td>The borrowed amount, once at open.</Td><Td>leverage-fee recipient</Td>
                </tr>
                <tr className="border-b border-border/40">
                  <Td>Close fee</Td><Td r>1%</Td><Td>Surplus on close (proceeds after debt repayment). A losing close pays nothing.</Td><Td>leverage-fee recipient</Td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-muted text-[13px]">
            A spot trader pays one fee. A leverage trader pays one on the way in (origination
            on the borrowed amount) and one on the way out (on the surplus, if any). The
            leveraged buy and the close sell-back are themselves fee-free (custom-delta path,
            §2). No funding rate.
          </p>
        </Sec>

        {/* ── 10 ── Parameters */}
        <Sec id="params" n="10" title="Parameters">
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-[13px]">
              <tbody className="text-text/85">
                {[
                  ["Total supply (per launch)", "1,000,000 tokens, fixed, all in the curve at genesis"],
                  ["V (virtual base reserve)", "WOKB base: 67.02 WOKB · USDC base: 7,487 USDC (both target ≈ $7,487 opening USD FDV)"],
                  ["K", "TOTAL_SUPPLY · V  →  WOKB: 67,023,136 · USDC: 7,487,130,000 (raw, base units)"],
                  ["W (band width)", "V · 10/7 (audited W/V ratio)  →  WOKB: 95.75 · USDC: 10,696"],
                  ["Bands", "300 × W-wide LP positions covering the curve range  →  WOKB curve top ≈ 28,725 WOKB · USDC curve top ≈ 3.21M USDC"],
                  ["Genesis price", "V / TOTAL_SUPPLY  →  WOKB: 0.0000670 WOKB/token (≈ $0.0063 at OKB $94) · USDC: 0.00749 USDC/token"],
                  ["Sides", "leveraged longs and shorts"],
                  ["Leverage", "2× – 3×"],
                  ["Per-band borrow cap", "40% (long) / 25% (short)"],
                  ["Per-block borrow cap", "= W base-equivalent (anti-flash-loan, counts reserve draws)  →  WOKB ≈ 95.75 WOKB (~$9K) · USDC ≈ 10,696 USDC"],
                  ["Min collateral", "W / 500 (≈ $20 USD-equivalent on every base)  →  WOKB ≈ 0.192 WOKB · USDC ≈ 21.4 USDC"],
                  ["Liquidation health", "105% — liquidate below it"],
                  ["Liquidation oracle", "5-minute TWAP (v4 observations)"],
                  ["Liquidation action", "seize whole position → reserve (no fire-sale)"],
                  ["Close cooldown", "2 blocks after opening"],
                  ["Anti-snipe", "no external trades/opens for 3 blocks post-launch"],
                  ["Hook flags", "0x2ACC (7 callbacks, including return-delta on both swap legs)"],
                  ["Spot fee", "1% per direct spot trade, in base → protocol fee recipient"],
                  ["Borrow origination fee", "1% of borrowed amount, once at open → leverage-fee recipient"],
                  ["Close fee", "1% of close surplus → leverage-fee recipient (losing close pays 0)"],
                  ["Funding rate", "none — one-time fees, not per-hour"],
                ].map(([k, v], i) => (
                  <tr key={i} className="border-b border-border/40">
                    <td className="px-3 py-2 text-muted whitespace-nowrap align-top">{k}</td>
                    <td className="px-3 py-2 text-text/90">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Sec>

        {/* ── 11 ── Risks */}
        <Sec id="risks" n="11" title="Risk disclosures">
          <ul className="list-disc pl-6 space-y-2 marker:text-muted">
            <li>
              <strong>Leverage cuts both ways.</strong> A 3× long is liquidated by a ~30% drop,
              a 2× long by ~47.5%; shorts symmetrically on the way up. Liquidation is automatic,
              on-chain, and final — no margin call to top up.
            </li>
            <li>
              <strong>You can lose your whole collateral.</strong> After liquidation the
              residual credited back to you is typically near zero; in a deep drawdown, zero.
            </li>
            <li>
              <strong>Leverage lives inside the curve&apos;s range.</strong> Longs can only be
              opened while the price is inside the bonding range. Once a token graduates above
              the top of the curve it trades freely; the bonding pool re-activates as a price
              floor (leverage included) if price ever trades back into range.
            </li>
            <li>
              <strong>Bad debt is possible.</strong> Extreme, fast drawdowns can leave a
              liquidation recovering less base than the debt. The shortfall is tracked openly
              on-chain and is isolated from user balances, but it is a real risk borne by the
              pool.
            </li>
            <li>
              <strong>Thin launch liquidity.</strong> A new pool launches with a small base
              float against a large circulating supply; price can move sharply on modest flow,
              and the per-block borrow cap bounds (but does not eliminate) per-block leverage
              activity.
            </li>
            <li>
              <strong>Smart-contract risk.</strong> Like any on-chain protocol, bugs are
              possible. Use only funds you can afford to lose, and only on the network the app
              is configured for — signing on the wrong chain can route funds to addresses
              that don&apos;t exist.
            </li>
          </ul>
        </Sec>

        <footer className="mt-16 border-t border-border pt-6 text-[12px] text-muted leading-6">
          <p>
            This document describes the protocol&apos;s mechanics and is not investment advice.
            All addresses above are verifiable on {EXPLORER.name}. Leverage trading carries
            substantial risk of total loss.
          </p>
          <p className="mt-3">
            <Link href="/" className="text-accent hover:underline">← back to the app</Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
