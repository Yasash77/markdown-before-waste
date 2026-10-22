# DEV_LOG

Key decisions, experiments and rejected approaches, in order.

## Problem choice
- Picked **PS 4.1** (near-expiry markdown pricing): no dataset download or API key needed, so nothing can fail on the day. A static site deploys reliably, and the open design space (our own simulator) rewards clear thinking over compute.

## Architecture
- **One simulator file (`js/sim.js`) shared by the browser and Node.** The dashboard numbers and the README numbers come from the same code, so they cannot disagree.
- **No backend, no API keys.** The simulation runs in about 1 ms per store-month in the browser, so the server-side option was rejected as unnecessary risk.
- Chart.js is vendored (not loaded from a CDN) so the demo works on restricted campus networks.

## Modelling decisions
1. **Seeded RNG (mulberry32) + common random numbers.** Each (seed, product, day) gets its own random streams for regular demand, bargain demand and shopper choice, so fixed price and markdown face the same regular shoppers. Test: day-1 sales are identical across policies.
2. **Replenishment is identical for all policies** (order-up-to). The comparison isolates pricing.
3. **Experiment: first ordering rule counted all on-hand units as cover.** Fixed-price waste came out at only 1.4 %, which is unrealistically low because the store self-corrected by under-ordering. Changed it so units expiring before the next delivery don't count as cover (what shelf staff actually do). Fixed-price waste is now about 7.8 %, in a realistic range for fresh categories.
4. **Bug found by tests:** short-life items (fish, 2 days; pav, 3 days) were marked down *on their arrival day* because they arrive with ≤ 2 days left. Added the rule "never mark down on arrival day".
5. **Cannibalisation is modelled explicitly** (50 % of regular shoppers take a markdown if one is on the shelf). Without it, any discount looks free and "discount everything" wins, which is the trap the PS warns about.
6. Tried overstock 1.2 vs 1.3 and cannibalisation 0.35 vs 0.5. Kept 1.2 / 0.5 (the more conservative case for markdowns). The other values are exposed in the sensitivity panel.

## Results honesty
- The optimiser searches only on seeds 1–10. We report a separate out-of-sample check on seeds 101–130.
- We report lost sales (stock-outs) even though they get worse under markdowns.
- The sensitivity grid includes one scenario where the optimised rule loses margin (−1.6 %), and we report it.

## Rejected approaches
- **Price-elasticity curve on a single shelf price:** rejected because it can't represent "only the old batch is discounted", which is the whole point.
- **Reinforcement learning for pricing:** rejected because it can't be explained in one slide or trained reliably in the time available. A transparent grid search over 120 monotone rules is enough and easy to audit.
- **Python/Streamlit:** rejected for deployment risk (cold starts on free tiers). JS runs instantly on GitHub Pages.

## AI assistance
- Claude (Anthropic) was used as a coding assistant for the simulator, dashboard, tests and documentation. All outputs were reviewed and run, and the tests and evaluation script verify the behaviour.
