/*
 * Markdown Before Waste — store simulator (pure JS, no dependencies).
 * Runs in the browser (window.MBW) and in Node (require('./js/sim.js')).
 *
 * One store, ~20 perishable products, 30 days. Stock arrives in batches with
 * expiry dates; daily demand depends on weekday, price and days to expiry.
 * Every assumption is listed in ASSUMPTIONS below and in README.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MBW = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Assumptions (all editable, all documented)
  // ---------------------------------------------------------------------------
  // Weekday demand shape, Monday..Sunday, mean = 1.0. Weekend grocery peak.
  const WEEKDAY = [0.90, 0.85, 0.90, 0.95, 1.10, 1.25, 1.05];
  const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Delivery cadence in days per category (bakery & ready meals daily, others every 2 days).
  const CATEGORIES = {
    'Bakery': { cadence: 1 },
    'Dairy': { cadence: 2 },
    'Produce': { cadence: 2 },
    'Meat & Fish': { cadence: 2 },
    'Ready meals': { cadence: 1 },
  };

  // Product master. Prices in ₹. shelfLife = days a unit can be sold, counting
  // the arrival day. demand = average units/day at full price. sens = price
  // sensitivity: a discount x (0..1) attracts extra "bargain" shoppers at rate
  // demand × weekday × sens × x.
  const PRODUCTS = [
    { id: 'bread-white', name: 'White bread loaf', category: 'Bakery', shelfLife: 4, unitCost: 30, basePrice: 45, demand: 30, sens: 2.5 },
    { id: 'bread-brown', name: 'Brown bread loaf', category: 'Bakery', shelfLife: 4, unitCost: 38, basePrice: 55, demand: 15, sens: 2.5 },
    { id: 'pav', name: 'Pav buns (6)', category: 'Bakery', shelfLife: 3, unitCost: 20, basePrice: 30, demand: 20, sens: 3.0 },
    { id: 'croissant', name: 'Butter croissant', category: 'Bakery', shelfLife: 3, unitCost: 25, basePrice: 45, demand: 10, sens: 3.5 },
    { id: 'milk', name: 'Toned milk 1 L', category: 'Dairy', shelfLife: 3, unitCost: 52, basePrice: 60, demand: 60, sens: 1.2 },
    { id: 'curd', name: 'Curd 400 g', category: 'Dairy', shelfLife: 5, unitCost: 30, basePrice: 40, demand: 25, sens: 1.8 },
    { id: 'paneer', name: 'Paneer 200 g', category: 'Dairy', shelfLife: 6, unitCost: 70, basePrice: 95, demand: 12, sens: 2.2 },
    { id: 'yogurt', name: 'Flavoured yogurt', category: 'Dairy', shelfLife: 10, unitCost: 22, basePrice: 35, demand: 14, sens: 3.0 },
    { id: 'cream', name: 'Fresh cream 200 ml', category: 'Dairy', shelfLife: 7, unitCost: 50, basePrice: 70, demand: 6, sens: 2.0 },
    { id: 'batter', name: 'Idli/dosa batter 1 kg', category: 'Dairy', shelfLife: 4, unitCost: 50, basePrice: 75, demand: 15, sens: 2.0 },
    { id: 'banana', name: 'Bananas (dozen)', category: 'Produce', shelfLife: 5, unitCost: 40, basePrice: 60, demand: 20, sens: 2.0 },
    { id: 'tomato', name: 'Tomatoes 1 kg', category: 'Produce', shelfLife: 6, unitCost: 25, basePrice: 40, demand: 25, sens: 1.5 },
    { id: 'spinach', name: 'Spinach bunch', category: 'Produce', shelfLife: 3, unitCost: 15, basePrice: 30, demand: 15, sens: 2.5 },
    { id: 'strawberry', name: 'Strawberries 200 g', category: 'Produce', shelfLife: 3, unitCost: 70, basePrice: 120, demand: 6, sens: 3.5 },
    { id: 'lettuce', name: 'Iceberg lettuce', category: 'Produce', shelfLife: 4, unitCost: 35, basePrice: 60, demand: 5, sens: 3.0 },
    { id: 'coriander', name: 'Coriander bunch', category: 'Produce', shelfLife: 3, unitCost: 8, basePrice: 15, demand: 18, sens: 2.0 },
    { id: 'chicken', name: 'Chicken curry cut 500 g', category: 'Meat & Fish', shelfLife: 3, unitCost: 140, basePrice: 190, demand: 10, sens: 2.0 },
    { id: 'fish', name: 'Fish fillet 250 g', category: 'Meat & Fish', shelfLife: 2, unitCost: 200, basePrice: 280, demand: 5, sens: 2.5 },
    { id: 'sandwich', name: 'Veg sandwich', category: 'Ready meals', shelfLife: 2, unitCost: 40, basePrice: 70, demand: 12, sens: 3.5 },
    { id: 'salad', name: 'Salad bowl', category: 'Ready meals', shelfLife: 2, unitCost: 80, basePrice: 140, demand: 6, sens: 3.5 },
  ];

  const DEFAULT_PARAMS = {
    days: 30,            // simulation horizon
    startWeekday: 0,     // day 0 is a Monday
    overstock: 1.2,      // order-up-to = 1.2 × expected demand until next delivery
    fifoShare: 0.6,      // share of full-price shoppers who take the front (oldest) unit
    dealSeekShare: 0.5,  // share of regular shoppers who pick a marked-down unit when one is on the shelf
    responseMult: 1.0,   // scales how strongly shoppers react to discounts (sensitivity panel)
    costFloor: false,    // if true, never price below unit cost
  };

  const ASSUMPTIONS = [
    ['Horizon', '30 days, day 0 = Monday, one store, 20 products in 5 categories.'],
    ['Weekday shape', 'Mon 0.90, Tue 0.85, Wed 0.90, Thu 0.95, Fri 1.10, Sat 1.25, Sun 1.05 (mean 1.0): weekend grocery peak.'],
    ['Base demand', 'Regular shoppers per day ~ Poisson(avg daily demand × weekday factor). Poisson = independent arrivals.'],
    ['Replenishment', 'Order-up-to: on delivery days (bakery/ready meals daily, others every 2 days) the store tops stock up to 1.2× expected demand until the next delivery. Same rule for every pricing policy, so only price differs.'],
    ['Shelf life', 'A batch can be sold from its arrival day for shelfLife days; unsold units are wasted at close on the last day (cost is lost).'],
    ['No day-one markdown', 'A batch is never discounted on the day it arrives, even for 2–3 day items (fish, sandwiches, pav). Stores do not mark down fresh deliveries.'],
    ['Shelf picking', 'Full-price shoppers take the front (oldest) unit 60% of the time and dig for the freshest 40% of the time. This is why old stock is left behind.'],
    ['Cannibalisation', 'When marked-down units are on the shelf, 50% of regular shoppers (who would have paid full price) take the cheaper unit. This is the margin cost of discounting.'],
    ['Discount lift', 'A discount x brings extra bargain shoppers ~ Poisson(demand × weekday × sens × x × response). They only buy marked-down units. sens ranges 1.2 (milk, staple) to 3.5 (impulse items like croissants, salads).'],
    ['Margin', 'Revenue − purchase cost of all units received + ending stock valued at cost (so end-of-month stock is not counted as waste or profit).'],
    ['Fairness', 'Common random numbers: each (seed, product, day) has its own random streams, so both policies face the same shoppers.'],
  ];

  // ---------------------------------------------------------------------------
  // Random numbers (seeded, reproducible)
  // ---------------------------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(...xs) {
    let h = 2166136261 >>> 0;
    for (const x of xs) {
      h ^= (x + 0x9e3779b9) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
      h ^= h >>> 13;
    }
    return h >>> 0;
  }
  function poisson(lambda, r) {
    if (!(lambda > 0)) return 0;
    if (lambda > 60) { // normal approximation for large means
      const u1 = Math.max(r(), 1e-12), u2 = r();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
    }
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= r(); } while (p > L);
    return k - 1;
  }

  // ---------------------------------------------------------------------------
  // Pricing policies
  // ---------------------------------------------------------------------------
  // tiers: discount when 2 days left (d2), 1 day left (d1), last day (d0).
  // "days left" = days remaining after today; 0 = last day the unit can be sold.
  const FIXED = { name: 'Fixed price', tiers: { d2: 0, d1: 0, d0: 0 } };
  const DEFAULT_MARKDOWN = { name: 'Markdown rule', tiers: { d2: 0.2, d1: 0.4, d0: 0.5 } };

  function tiersFor(policy, category) {
    return (policy.byCategory && policy.byCategory[category]) || policy.tiers;
  }
  function discountFor(daysLeft, tiers) {
    if (daysLeft >= 3) return 0;
    if (daysLeft === 2) return tiers.d2 || 0;
    if (daysLeft === 1) return tiers.d1 || 0;
    return tiers.d0 || 0;
  }
  function unitPrice(product, discount, params) {
    let p = product.basePrice * (1 - discount);
    if (params.costFloor) p = Math.max(p, product.unitCost);
    return Math.round(p * 100) / 100;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------
  function simulate(opts) {
    const params = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    const products = opts.products || PRODUCTS;
    const policy = opts.policy || FIXED;
    const seed = opts.seed == null ? 42 : opts.seed;
    const D = params.days;

    const daily = Array.from({ length: D }, (_, d) => ({
      day: d, weekday: WEEKDAY_NAMES[(params.startWeekday + d) % 7],
      revenue: 0, unitsSold: 0, markdownUnits: 0, wastedUnits: 0, wasteCost: 0, lostSales: 0,
    }));
    const deals = Array.from({ length: D }, () => []);
    const perProduct = [];

    products.forEach((prod, pi) => {
      const cadence = (CATEGORIES[prod.category] || { cadence: 1 }).cadence;
      const tiers = tiersFor(policy, prod.category);
      const st = {
        id: prod.id, name: prod.name, category: prod.category,
        received: 0, sold: 0, markdownUnits: 0, wasted: 0, lostSales: 0,
        revenue: 0, purchaseCost: 0, wasteCost: 0, endingStock: 0,
        timeline: [], // per day: {day, price levels, sold, markdownSold, wasted, received}
      };
      let batches = []; // {qty, expiry}

      for (let d = 0; d < D; d++) {
        const wd = (params.startWeekday + d) % 7;
        const rA = mulberry32(hashSeed(seed, pi, d, 1)); // regular demand
        const rB = mulberry32(hashSeed(seed, pi, d, 2)); // bargain demand
        const rC = mulberry32(hashSeed(seed, pi, d, 3)); // shopper choices
        const day = { day: d, received: 0, sold: 0, markdownSold: 0, wasted: 0, lost: 0, discounts: [] };

        // 1) Morning delivery (order-up-to, identical rule for all policies)
        if (d % cadence === 0) {
          let expected = 0;
          for (let k = 0; k < cadence; k++) expected += prod.demand * WEEKDAY[(wd + k) % 7];
          // Units that expire before the next delivery do not count as cover.
          const onHand = batches.reduce((s, b) => s + (b.expiry - d >= cadence ? b.qty : 0), 0);
          const q = Math.max(0, Math.round((prod.overstock || params.overstock) * expected - onHand)); // per-product override used by the action planner
          if (q > 0) {
            batches.push({ qty: q, expiry: d + prod.shelfLife - 1, arrival: d });
            st.received += q; st.purchaseCost += q * prod.unitCost; day.received = q;
          }
        }

        // 2) Price each batch by days to expiry
        batches.forEach(b => {
          b.daysLeft = b.expiry - d;
          // A batch is never marked down on its arrival day (short-life items would otherwise be discounted fresh).
          b.discount = b.arrival === d ? 0 : discountFor(b.daysLeft, tiers);
          b.price = unitPrice(prod, b.discount, params);
          b.effDiscount = 1 - b.price / prod.basePrice;
        });
        const marked = () => batches.filter(b => b.qty > 0 && b.effDiscount > 1e-9);
        const full = () => batches.filter(b => b.qty > 0 && b.effDiscount <= 1e-9);
        const md0 = marked();
        md0.forEach(b => {
          day.discounts.push({ daysLeft: b.daysLeft, discount: b.effDiscount, units: b.qty, price: b.price });
          deals[d].push({ id: prod.id, name: prod.name, category: prod.category, basePrice: prod.basePrice,
            price: b.price, discount: b.effDiscount, units: b.qty, daysLeft: b.daysLeft });
        });
        const maxDisc = md0.reduce((m, b) => Math.max(m, b.effDiscount), 0);

        // 3) Shoppers arrive
        const nReg = poisson(prod.demand * WEEKDAY[wd], rA);
        const nBar = maxDisc > 0 ? poisson(prod.demand * WEEKDAY[wd] * prod.sens * maxDisc * params.responseMult, rB) : 0;
        const queue = [];
        for (let i = 0; i < nReg; i++) queue.push(0);
        for (let i = 0; i < nBar; i++) queue.push(1);
        for (let i = queue.length - 1; i > 0; i--) { // shuffle
          const j = Math.floor(rC() * (i + 1)); const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
        }
        const sell = (b) => {
          b.qty--; st.sold++; st.revenue += b.price; day.sold++;
          daily[d].revenue += b.price; daily[d].unitsSold++;
          if (b.effDiscount > 1e-9) { st.markdownUnits++; day.markdownSold++; daily[d].markdownUnits++; }
        };
        const oldest = (arr) => arr.reduce((a, b) => (b.expiry < a.expiry ? b : a));
        const freshest = (arr) => arr.reduce((a, b) => (b.expiry > a.expiry ? b : a));
        const deepest = (arr) => arr.reduce((a, b) => (b.effDiscount > a.effDiscount || (b.effDiscount === a.effDiscount && b.expiry < a.expiry) ? b : a));

        for (const type of queue) {
          const m = marked(), f = full();
          const u = rC();
          if (type === 1) { // bargain shopper: only buys marked-down stock
            if (m.length) sell(deepest(m));
            continue;
          }
          if (m.length && u < params.dealSeekShare) { sell(deepest(m)); continue; }
          if (f.length) { sell(rC() < params.fifoShare ? oldest(f) : freshest(f)); continue; }
          if (m.length) { sell(deepest(m)); continue; }
          st.lostSales++; day.lost++; daily[d].lostSales++;
        }

        // 4) Close: expire batches whose last day is today
        batches = batches.filter(b => {
          if (b.expiry <= d) {
            if (b.qty > 0) {
              st.wasted += b.qty; st.wasteCost += b.qty * prod.unitCost; day.wasted += b.qty;
              daily[d].wastedUnits += b.qty; daily[d].wasteCost += b.qty * prod.unitCost;
            }
            return false;
          }
          return b.qty > 0;
        });
        st.timeline.push(day);
      }
      st.endingStock = batches.reduce((s, b) => s + b.qty, 0);
      st.margin = st.revenue - st.purchaseCost + st.endingStock * prod.unitCost;
      st.wastePct = st.received ? st.wasted / st.received : 0;
      perProduct.push(st);
    });

    const totals = summarize(perProduct);
    return { seed, policy: policy.name, params, totals, products: perProduct, daily, deals };
  }

  function summarize(perProduct) {
    const t = { received: 0, sold: 0, markdownUnits: 0, wasted: 0, lostSales: 0, revenue: 0, purchaseCost: 0, wasteCost: 0, margin: 0, endingStock: 0 };
    perProduct.forEach(p => { for (const k in t) t[k] += p[k]; });
    t.wastePct = t.received ? t.wasted / t.received : 0;
    t.marginPct = t.revenue ? t.margin / t.revenue : 0;
    return t;
  }

  // Run many seeds and return mean / std / per-seed values of the key metrics.
  function multiSeed(opts, seeds) {
    const keys = ['wasted', 'wastePct', 'revenue', 'margin', 'marginPct', 'sold', 'lostSales', 'markdownUnits', 'wasteCost'];
    const runs = seeds.map(s => simulate(Object.assign({}, opts, { seed: s })).totals);
    const out = { n: seeds.length, seeds: seeds.slice(), runs };
    keys.forEach(k => {
      const v = runs.map(r => r[k]);
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
      out[k] = { mean, sd };
    });
    return out;
  }

  // Compare a policy against fixed price on the same seeds (paired).
  function compare(policy, opts, seeds) {
    const base = multiSeed(Object.assign({}, opts, { policy: FIXED }), seeds);
    const pol = multiSeed(Object.assign({}, opts, { policy }), seeds);
    const pairedDiff = (k) => {
      const v = seeds.map((_, i) => pol.runs[i][k] - base.runs[i][k]);
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
      return { mean, sd };
    };
    return {
      fixed: base, policy: pol,
      wasteReductionPct: base.wasted.mean ? (1 - pol.wasted.mean / base.wasted.mean) * 100 : 0,
      marginChange: pairedDiff('margin'),
      marginChangePct: base.margin.mean ? (pol.margin.mean / base.margin.mean - 1) * 100 : 0,
      revenueChange: pairedDiff('revenue'),
      wastedChange: pairedDiff('wasted'),
    };
  }

  // ---------------------------------------------------------------------------
  // Stretch: search for the best discount steps per category
  // ---------------------------------------------------------------------------
  // Grid over monotone tiers d2 <= d1 <= d0 from `levels`. Objective = mean
  // margin − wastePenalty × mean wasted units, over `seeds`.
  function optimizeCategory(category, opts) {
    const o = Object.assign({ levels: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], seeds: range(1, 10), wastePenalty: 0, params: {} }, opts || {});
    const prods = PRODUCTS.filter(p => p.category === category);
    let best = null; const all = [];
    for (const d2 of o.levels) for (const d1 of o.levels) for (const d0 of o.levels) {
      if (!(d2 <= d1 && d1 <= d0)) continue;
      const pol = { name: 'grid', tiers: { d2, d1, d0 } };
      const r = multiSeed({ products: prods, policy: pol, params: o.params }, o.seeds);
      const score = r.margin.mean - o.wastePenalty * r.wasted.mean;
      const row = { tiers: { d2, d1, d0 }, score, margin: r.margin.mean, wasted: r.wasted.mean, revenue: r.revenue.mean };
      all.push(row);
      if (!best || score > best.score) best = row;
    }
    const fixed = multiSeed({ products: prods, policy: FIXED, params: o.params }, o.seeds);
    return { category, best, fixed: { margin: fixed.margin.mean, wasted: fixed.wasted.mean, revenue: fixed.revenue.mean }, evaluated: all.length, all };
  }

  function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

  return {
    WEEKDAY, WEEKDAY_NAMES, CATEGORIES, PRODUCTS, DEFAULT_PARAMS, ASSUMPTIONS,
    FIXED, DEFAULT_MARKDOWN, simulate, multiSeed, compare, optimizeCategory,
    discountFor, poisson, mulberry32, hashSeed, range,
  };
});
