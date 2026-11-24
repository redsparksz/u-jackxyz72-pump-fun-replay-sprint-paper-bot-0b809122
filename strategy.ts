// First-light sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea, from the dev window's own numbers: a new coin's whole life is decided in its
// first seconds. Of 1,222 dev coins, 286 more than doubled from their create price and
// the median time to that peak was 52 slots (~21 s); the median coin ends the window
// flat, so holding is a slow bleed and the money is in catching the opening spike and
// getting out. This bot therefore only ever buys a coin in its first few slots, only
// when the opening tape already shows real outside interest (several distinct buyers,
// net SOL flowing in, price already up from create, a real reserve big enough to take
// a meaningful order), and then exits on a tight plan: bank half on the first pop,
// trail the rest, cut losers fast, never hold past a short clock.
//
// The entry filter is deliberately a "crowd" filter, not a "whale" filter: a launch
// whose first buyers are one or two wallets is usually the creator's cluster waiting
// to dump, while several unrelated buyers plus rising price is the closest thing this
// tape has to genuine demand. The creator selling before entry disqualifies the coin.
//
// Exits, in order per batch: take half at +tp1Bps; sell all at +tpBps; sell all at
// -slBps (or -slAfterTp1Bps on what is left after the first take-profit); sell all
// on a trailing stop once the position has been up trailArmBps and then gives back
// trailBps from its best value; sell all when the creator sells while held; sell all
// when maxHold slots pass. A completed curve is closed by the replay itself.
//
// Deterministic by construction: no clock, no environment, no randomness; every
// iteration is over insertion-ordered maps fed by the batch stream, and every amount
// is integer lamports computed from the reserves the harness reports.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Net SOL bought minus sold before entry, at least. */
  minNetSol: number;
  /** Price now over the create price, in bps: entry window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First take-profit: sell this share of the position once it is worth this much over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least this much, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots (0 = off). */
  staleSlots: number;
  /** After the first take-profit, the remainder rides: its trailing stop (bps from best). */
  rideTrailBps: number;
  /** After the first take-profit, the remainder's take-profit (bps over cost). */
  rideTpBps: number;
  /** After the first take-profit, the remainder's max hold (slots). */
  rideMaxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.25,
  minBuySol: 0.012,
  minRealSol: 5,
  maxRealSol: 85,
  minBuyers: 11,
  minNetSol: 2,
  minRunupBps: 300,
  maxRunupBps: 100_000,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 1000,
  tp1PartBps: 5000,
  slAfterTp1Bps: 0,
  tpBps: 3000,
  slBps: 300,
  trailArmBps: 500,
  trailBps: 800,
  maxHold: 40,
  exitOnDevSell: true,
  staleSlots: 0,
  rideTrailBps: 800,
  rideTpBps: 3000,
  rideMaxHold: 40,
};

const BPS = 10_000n;
/** Curve fees on every trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

interface Coin {
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  /** SOL bought minus sold on the tape so far (lamports). */
  netLamports: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** A buy was sent for this coin; never buy it again. */
  bought: boolean;
  /** Never consider it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's fills so far. */
  txPaid: bigint;
  /** Best close value seen (lamports, after curve and tx fees). */
  best: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already in flight. */
  const selling = new Set<Pubkey>();

  const coinOf = (mint: Pubkey): Coin | undefined => coins.get(mint);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          trades: 0,
          buyers: new Set(),
          netLamports: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          bought: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        if (e.is_buy) {
          c.netLamports += sol;
          if (e.user !== c.creator) c.buyers.add(e.user);
        } else {
          c.netLamports -= sol;
          if (e.user === c.creator) c.devSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold fills in: track positions and tx fees, drop what the harness closed.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const c = coinOf(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: c?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      // Exits first: every held position is re-priced against the latest reserves.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coinOf(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        if (basis <= 0n) continue;

        // Bank half on the first pop; the rest then plays with a breakeven stop.
        if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
          const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            h.tookTp1 = true;
            h.best = 0n;
            continue;
          }
        }
        let exit = false;
        // After the first take-profit the remainder keeps the same tight exits
        // (same trail, take-profit and clock), except its stop moves to breakeven:
        // the half already banked pays for the rest of the ride.
        const tp = h.tookTp1 ? BigInt(p.rideTpBps) : BigInt(p.tpBps);
        const trail = h.tookTp1 ? BigInt(p.rideTrailBps) : BigInt(p.trailBps);
        const hold = h.tookTp1 ? p.rideMaxHold : p.maxHold;
        if (value * BPS >= basis * (BPS + tp)) exit = true;
        const sl = h.tookTp1 ? BigInt(p.slAfterTp1Bps) : BigInt(p.slBps);
        if (value * BPS <= basis * (BPS - sl)) exit = true;
        if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - trail)) exit = true;
        if (state.slot - h.openedSlot >= hold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (p.staleSlots > 0 && state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one shot per coin, inside its first maxAge slots, crowd-filtered.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      const stake = BigInt(Math.floor(p.stakeSol * 1e9));
      const minBuy = BigInt(Math.floor(p.minBuySol * 1e9));
      for (const [mint, c] of coins) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.bought) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        if (hasPending(state, mint, 'buy') || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (p.skipDevSold && c.devSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(Math.floor(p.minRealSol * 1e9)) || rq > BigInt(Math.floor(p.maxRealSol * 1e9))) continue;
        if (c.buyers.size < p.minBuyers) continue;
        if (c.netLamports < BigInt(Math.floor(p.minNetSol * 1e9))) continue;
        // Run-up vs create price, in bps, cross-multiplied so no float is involved.
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0) - BPS;
        if (runup < BigInt(p.minRunupBps) || runup > BigInt(p.maxRunupBps)) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.bought = true;
        open += 1;
      }
      return orders;
    },
  };
}
