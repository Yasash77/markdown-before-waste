// Run: node tests/sim.test.js   (no dependencies)
const assert = require('assert');
const S = require('../js/sim.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

test('20 products with all required fields', () => {
  assert.strictEqual(S.PRODUCTS.length, 20);
  for (const p of S.PRODUCTS) {
    for (const k of ['category', 'shelfLife', 'unitCost', 'basePrice', 'demand', 'sens']) assert.ok(p[k] !== undefined, p.id + ' missing ' + k);
    assert.ok(p.basePrice > p.unitCost, p.id + ' sells below cost at full price');
    assert.ok(S.CATEGORIES[p.category], p.id + ' unknown category');
  }
});

test('same seed reproduces identical results', () => {
  const a = S.simulate({ policy: S.DEFAULT_MARKDOWN, seed: 7 }).totals;
  const b = S.simulate({ policy: S.DEFAULT_MARKDOWN, seed: 7 }).totals;
  assert.deepStrictEqual(a, b);
});

test('stock is conserved: received = sold + wasted + ending stock', () => {
  for (const pol of [S.FIXED, S.DEFAULT_MARKDOWN]) {
    const r = S.simulate({ policy: pol, seed: 3 });
    for (const p of r.products) assert.strictEqual(p.received, p.sold + p.wasted + p.endingStock, p.id);
  }
});

test('fixed price never sells a marked-down unit', () => {
  const r = S.simulate({ policy: S.FIXED, seed: 1 });
  assert.strictEqual(r.totals.markdownUnits, 0);
  assert.ok(r.deals.every(d => d.length === 0));
});

test('regular demand is identical across policies (common random numbers)', () => {
  // With no stock-outs, total regular shoppers are the same; check via first-day sales under no discounts
  const f = S.simulate({ policy: S.FIXED, seed: 11 });
  const m = S.simulate({ policy: S.DEFAULT_MARKDOWN, seed: 11 });
  // Day 0 has only fresh stock, so no discounts exist yet: sales must match exactly.
  assert.strictEqual(f.daily[0].unitsSold, m.daily[0].unitsSold);
});

test('discount tiers map days-left correctly', () => {
  const t = { d2: 0.2, d1: 0.4, d0: 0.5 };
  assert.strictEqual(S.discountFor(5, t), 0);
  assert.strictEqual(S.discountFor(2, t), 0.2);
  assert.strictEqual(S.discountFor(1, t), 0.4);
  assert.strictEqual(S.discountFor(0, t), 0.5);
});

test('cost floor keeps every price at or above unit cost', () => {
  const r = S.simulate({ policy: { name: 'deep', tiers: { d2: 0.7, d1: 0.7, d0: 0.7 } }, params: { costFloor: true }, seed: 2 });
  for (const day of r.deals) for (const d of day) {
    const p = S.PRODUCTS.find(x => x.id === d.id);
    assert.ok(d.price >= p.unitCost - 1e-9, d.id);
  }
});

test('poisson sampler mean is close to lambda', () => {
  const r = S.mulberry32(99); let s = 0; const n = 20000;
  for (let i = 0; i < n; i++) s += S.poisson(12, r);
  assert.ok(Math.abs(s / n - 12) < 0.2, 'mean ' + s / n);
});

console.log(`\n${passed} tests passed`);
