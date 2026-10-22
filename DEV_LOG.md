# DEV_LOG

Key decisions, experiments and rejected approaches, in order.

## Problem choice
- Picked **PS 4.1** (near-expiry markdown pricing): no dataset download or API key needed, so nothing can fail on the day. A static site deploys reliably, and the open design space (my own simulator) rewards clear thinking over compute.

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

## Usability upgrades (after the MVP and stretch goals were done)
- Added a plain-English verdict box. For a rule that cuts waste but loses margin, it reports the cost: ₹ of margin given up per unit of waste avoided (−Δmargin ÷ units saved, 10-seed means). This makes the trade-off concrete for a store manager.
- Replaced the waste-rate KPI with "₹ thrown away (at cost)". Waste rate is still shown under it.
- Scenario state (rule, seed, shopper response, overstock, cost floor, optimised on/off) is stored in the URL hash, so a judge can reopen the exact scenario from the demo.
- CSV export of per-product results, and print CSS that turns the deals page into shelf-edge labels.

## Action planner ("Recommended next steps")
- Turns results into ranked actions. Each candidate is re-simulated on seeds 1–10 against the current setup, and only changes worth more than ₹200–300 a month are shown.
  - Pricing: switch to the optimised per-category rules.
  - Category: soften markdowns where the rule earns less than fixed price.
  - Ordering: for each product, try stocking up to 1.0–1.4× expected demand (needed a small per-product `overstock` override in `sim.js`).
  - Risk: re-test at half the shopper response and advise a pilot if margin turns negative.
  - Shop floor: today's markdown list, linked to the shelf labels.
- **Guardrail added after testing:** the first version suggested "order less milk" (+₹6.5k) even though it raised empty-shelf lost sales 4×. That's bad advice for a staple, because the model doesn't price lost customer goodwill. Ordering tips are now rejected if lost sales rise more than 50% (or 10 units).

## Role-based views
- Added a sign-in screen with four roles: store manager, analyst, shelf staff, shopper. Each role gets its own tabs and actions (config in `ROLES` in `app.js`). The manager publishes a rule, and staff and shoppers always see the published rule (or the optimised default if none is published).
- **Decision:** no passwords or real auth. The site is static (GitHub Pages) with no backend, so any client-side password would be fake security. The UI says so plainly. Real auth (e.g. a hosted identity provider) is a next step.
- Bug found while testing: a `#role=staff` link was ignored because `render()` rewrote the URL hash before the role was read. The role is now read first.

## UI review pass
- An external UI/UX review rated the app 7.2/10. Main points: settings came before results, labels were technical, and "Publish to store" implied a real integration. Changes made:
  - The first screen is now a compact strategy bar (3 presets plus the current rule in words). Sliders and scenario settings moved into a collapsible "Fine-tune" section, so the verdict and KPIs are visible straight away.
  - Plain labels: Aggressive / Gentle discounts, ★ Recommended category rules, Customer response to discounts, Extra stock buffer (with "1.2× = 120% of expected demand"), Prevent selling below purchase cost, Simulation seed (advanced).
  - "Publish this rule to the store" became "Save as store rule (demo)", and its messages say it is stored in this browser only.
  - KPI cards: big current value, explicit "Fixed price" baseline, and an arrow, % and word (better / worse; revenue is shown neutrally as higher / lower, because more revenue can still mean less margin). The meaning no longer relies on colour alone.
  - A one-line chart takeaway above the charts. The waste-vs-margin chart is labelled as the quick screen (3 seeds) and explains the evaluation stages: 3 → 10 → 30 unseen seeds.
  - 15 px base font, tabs wrap on mobile (no hidden tabs), the header is not sticky on phones, visible keyboard focus outlines, and a clearer selected row in the heatmap.

## Staff to-do list (replaces the Assumptions tab)
- User feedback: the assumptions page was hard to act on. The tab is now a plain-language **daily to-do list** the manager can hand to staff. It is built from the simulated day under the current (or saved store) rule:
  - Before opening: deliveries to receive, rotate stock, and which items get which reduced-price sticker.
  - During the day: shelves likely to run empty (from simulated lost sales), and a check on the reduced shelf.
  - At closing: items expected to be left over and expire, and the waste log.
  - Tomorrow: the delivery to make room for.
- Tasks can be ticked off (saved in this browser), copied as WhatsApp-ready text, or printed. The tab is visible to manager, analyst and shelf staff, and is the first screen for staff.
- The full assumptions table is still there for judges and analysts, folded under "How the numbers are worked out".

## Results honesty
- The optimiser searches only on seeds 1–10. I report a separate out-of-sample check on seeds 101–130.
- I report lost sales (stock-outs) even though they get worse under markdowns.
- The sensitivity grid includes one scenario where the optimised rule loses margin (−1.6 %), and I report it.

## Rejected approaches
- **Price-elasticity curve on a single shelf price:** rejected because it can't represent "only the old batch is discounted", which is the whole point.
- **Reinforcement learning for pricing:** rejected because it can't be explained in one slide or trained reliably in the time available. A transparent grid search over 120 monotone rules is enough and easy to audit.
- **Python/Streamlit:** rejected for deployment risk (cold starts on free tiers). JS runs instantly on GitHub Pages.

## AI assistance
- Claude (Anthropic) was used as a coding assistant for the simulator, dashboard, tests and documentation. All outputs were reviewed and run, and the tests and evaluation script verify the behaviour.
