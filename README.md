# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/redsparksz/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/redsparksz/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A first-light sniper bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a replay of pump.fun chain data (harness `pumpfun-replay/v2`), scored by net PnL.

## Idea

A new pump.fun coin's whole life is decided in its first seconds: on the dev window (1,222 coins) 286 coins more than doubled from their create price, the median time to that peak was 52 slots (~21 s), and the median coin ends the window flat. So this bot only buys a coin in its first few slots, only when the opening tape already shows real outside interest — several distinct buyers, net SOL flowing in, price already up from create, a real reserve big enough to take a meaningful order — and then exits on a tight plan: bank half on the first pop, trail the rest, cut losers fast, never hold past a short clock.

## Entry (one shot per coin, age 0–3 slots)

- ≥ 11 distinct non-creator buyers, net flow ≥ 2 SOL, run-up ≥ 3% vs create
- real SOL reserve 5–85 SOL, creator has not sold
- stake 0.25 SOL per coin (capped at 1% of real reserve per reply)

## Exits

- Take half at +10%; sell all at +30%
- Stop-loss −3% (breakeven on the remainder after the first take-profit)
- Trailing stop: once up ≥ 5%, exit on an 8% pullback from the best value
- Exit at once if the creator sells while held; max hold 40 slots

All arithmetic is integer (`bigint`) on the harness's own reserve units, so two runs on the same data produce identical orders. No network, no wall clock, no randomness, no files.

Dev window (local grade, kit `grade-local --driver process`, reproduced byte for byte twice): **net PnL +0.5089 SOL (+5.09%), 110 fills over 49 coins, 49 round trips, win rate 40.8%, max drawdown 0.68%, fees 0.2180 SOL curve + 0.0117 SOL tx** (at 2x fees still +0.2756 SOL). House baselines on the same window all lose money (momentum −9.49, sniper −0.47, reversion −4.00 SOL).

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot <your repository> --driver docker
```

## Files

- `main.ts` — entrypoint (`node main.ts`)
- `strategy.ts` — the strategy (all logic, deterministic, no clock/random/network)
- `vendor/makefun-bot.ts` — the kit's replay/v2 shim, vendored byte for byte

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
