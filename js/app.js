/* Markdown Before Waste — dashboard (vanilla JS + Chart.js). Simulation lives in sim.js. */
(function () {
  'use strict';
  const S = window.MBW;
  const $ = (id) => document.getElementById(id);
  const SEEDS = S.range(1, 10);          // evaluation seeds (also used by the optimiser)
  const OOS_SEEDS = S.range(101, 130);   // unseen seeds for the out-of-sample check
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const state = {
    tiers: { d2: 0.2, d1: 0.4, d0: 0.5 },
    byCategory: null,         // set when the optimised preset is active
    seed: 42, resp: 1, over: 1.2, floor: false, penalty: 0,
    opt: null,                // optimiser output
    selProduct: 'milk',
    frontierKey: null, frontier: null,
  };
  const charts = {};

  // ---------- formatting ----------
  const inr = (x) => '₹' + Math.round(x).toLocaleString('en-IN');
  const inrK = (x) => (Math.abs(x) >= 1e5 ? '₹' + (x / 1e5).toFixed(2) + ' L' : inr(x));
  const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
  const sgn = (x, f) => (x > 0 ? '+' : x < 0 ? '−' : '±') + f(Math.abs(x));
  const tierStr = (t) => `${Math.round(t.d2 * 100)} / ${Math.round(t.d1 * 100)} / ${Math.round(t.d0 * 100)} %`;

  // ---------- current policy & params ----------
  function policy() {
    if (state.byCategory) return { name: 'Recommended category rules', tiers: state.tiers, byCategory: state.byCategory };
    return { name: 'Markdown rule ' + tierStr(state.tiers), tiers: state.tiers };
  }
  function params(over) {
    return Object.assign({ responseMult: state.resp, overstock: state.over, costFloor: state.floor }, over || {});
  }

  // ---------- controls ----------
  function syncControls() {
    for (const k of ['d2', 'd1', 'd0']) { $(k).value = Math.round(state.tiers[k] * 100); $('o_' + k).textContent = Math.round(state.tiers[k] * 100) + '%'; }
    $('o_resp').textContent = state.resp.toFixed(2) + '×';
    $('o_over').textContent = state.over.toFixed(2) + '×';
    $('o_pen').textContent = '₹' + state.penalty;
    $('presetOpt').classList.toggle('on', !!state.byCategory);
    for (const k of ['d2', 'd1', 'd0']) $(k).closest('label').style.opacity = state.byCategory ? 0.45 : 1;
    $('ruleNote').innerHTML = state.byCategory
      ? 'Recommended rule per category (2 days / 1 day / last day): ' + Object.entries(state.byCategory).map(([c, t]) => `<b>${c}</b> ${tierStr(t)}`).join(' · ') + '. Moving a discount slider switches back to one rule for the whole store.'
      : `Current rule: <b>${Math.round(state.tiers.d2 * 100)}%</b> off with 2 days left, <b>${Math.round(state.tiers.d1 * 100)}%</b> with 1 day left, <b>${Math.round(state.tiers.d0 * 100)}%</b> on the last day. Fresh deliveries are never discounted.`;
  }
  function bindControls() {
    for (const k of ['d2', 'd1', 'd0']) $(k).addEventListener('input', (e) => {
      state.tiers = Object.assign({}, state.tiers, { [k]: +e.target.value / 100 });
      state.byCategory = null; clearPresets(); schedule();
    });
    $('seed').addEventListener('change', (e) => { state.seed = Math.max(1, +e.target.value || 1); schedule(); });
    $('resp').addEventListener('input', (e) => { state.resp = +e.target.value; schedule(); });
    $('over').addEventListener('input', (e) => { state.over = +e.target.value; schedule(); });
    $('floor').addEventListener('change', (e) => { state.floor = e.target.checked; schedule(); });
    $('pen').addEventListener('input', (e) => { state.penalty = +e.target.value; syncControls(); });
    $('dealDay').addEventListener('input', renderDeals);
    $('runOpt').addEventListener('click', () => runOptimiser());
    $('csvBtn').addEventListener('click', downloadCSV);
    document.querySelectorAll('.role').forEach(b => b.addEventListener('click', () => signIn(b.dataset.role)));
    $('switchRole').addEventListener('click', showLogin);
    $('publishBtn').addEventListener('click', publishRule);
    $('copyPlan').addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(planText); e.target.textContent = 'Copied ✓'; }
      catch (err) { e.target.textContent = 'Copy failed'; }
      setTimeout(() => { e.target.textContent = 'Copy action plan'; }, 2500);
    });
    $('dealDay').addEventListener('change', schedulePlan);
    $('printBtn').addEventListener('click', () => window.print());
    $('copyLink').addEventListener('click', async () => {
      writeHash();
      try { await navigator.clipboard.writeText(location.href); $('copyMsg').textContent = 'Link copied.'; }
      catch (e) { $('copyMsg').textContent = location.href; }
      setTimeout(() => { $('copyMsg').textContent = ''; }, 4000);
    });
    document.querySelectorAll('.chip[data-preset]').forEach(b => b.addEventListener('click', () => {
      const p = b.dataset.preset;
      clearPresets();
      if (p === 'naive') { state.tiers = { d2: 0.2, d1: 0.4, d0: 0.5 }; state.byCategory = null; b.classList.add('on'); }
      if (p === 'gentle') { state.tiers = { d2: 0, d1: 0.2, d0: 0.4 }; state.byCategory = null; b.classList.add('on'); }
      if (p === 'optimised') {
        if (!state.opt) { runOptimiser(true); return; }
        applyOptimised();
      }
      schedule();
    }));
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + t.dataset.tab));
      Object.values(charts).forEach(c => c.resize());
    }));
  }
  function clearPresets() { document.querySelectorAll('.chip[data-preset]').forEach(b => b.classList.remove('on')); }

  let timer = null;
  function schedule() { syncControls(); clearTimeout(timer); timer = setTimeout(render, 60); }

  // ---------- main render ----------
  let last = null;
  function render() {
    const opts = { params: params() };
    const fixed = S.simulate(Object.assign({}, opts, { policy: S.FIXED, seed: state.seed }));
    const rule = S.simulate(Object.assign({}, opts, { policy: policy(), seed: state.seed }));
    const cmp = S.compare(policy(), opts, SEEDS);
    last = { fixed, rule, cmp };
    renderInsight(fixed, rule, cmp);
    renderKPIs(fixed, rule, cmp);
    writeHash();
    renderDailyCharts(fixed, rule);
    renderFrontier();
    renderHeat(rule, fixed);
    renderProductTable(fixed, rule);
    renderProduct();
    renderSensitivity();
    renderSeeds(cmp);
    renderDeals();
    schedulePlan();
  }

  // goal: 'lower' (less is better), 'higher' (more is better) or 'neutral' (direction alone is not good or bad)
  function kpi(label, from, to, fmt, goal, avgText) {
    const d = to - from;
    const rel = from ? d / Math.abs(from) : 0;
    const flat = Math.abs(rel) < 0.005;
    const good = goal === 'lower' ? d < 0 : d > 0;
    const cls = flat || goal === 'neutral' ? 'neutral' : good ? 'good' : 'bad';
    const arrow = flat ? '→' : d > 0 ? '▲' : '▼';
    const word = flat ? 'no change' : goal === 'neutral' ? (d > 0 ? 'higher' : 'lower') : good ? 'better' : 'worse';
    return `<div class="kpi"><div class="label">${label}</div>
      <div class="big">${fmt(to)}</div>
      <div><span class="delta ${cls}">${arrow} ${sgn(rel * 100, (x) => x.toFixed(1) + '%')} · ${word}</span></div>
      <div class="base">Fixed price: <b>${fmt(from)}</b></div>
      <div class="avg">${avgText}</div></div>`;
  }
  function renderKPIs(f, r, c) {
    const F = f.totals, R = r.totals;
    const avg = (k, fmt) => `10-seed mean: ${fmt(c.fixed[k].mean)} → ${fmt(c.policy[k].mean)}`;
    const n = (x) => Math.round(x).toLocaleString('en-IN');
    $('kpis').innerHTML = [
      kpi('Units wasted', F.wasted, R.wasted, n, 'lower', avg('wasted', (x) => Math.round(x))),
      kpi('₹ thrown away (at cost)', F.wasteCost, R.wasteCost, inrK, 'lower', avg('wasteCost', inrK) + ` · waste rate ${pct(c.fixed.wastePct.mean, 1)} → ${pct(c.policy.wastePct.mean, 1)}`),
      kpi('Gross margin', F.margin, R.margin, inrK, 'higher', avg('margin', inrK)),
      kpi('Revenue', F.revenue, R.revenue, inrK, 'neutral', avg('revenue', inrK) + ' · judge with margin'),
      kpi('Lost sales (empty shelf)', F.lostSales, R.lostSales, n, 'lower', avg('lostSales', (x) => Math.round(x))),
    ].join('');
    $('seedline').innerHTML = `30-day simulation · seed <b>${state.seed}</b> · big number = <b>${policy().name}</b>, “Fixed price” = baseline. ` +
      `Over 10 seeds: waste <b class="${c.wasteReductionPct >= 0 ? 'good' : 'bad'}">${sgn(-c.wasteReductionPct, (x) => x.toFixed(1) + '%')}</b>, ` +
      `margin <b class="${c.marginChange.mean >= 0 ? 'good' : 'bad'}">${sgn(c.marginChange.mean, inr)}</b> (${sgn(c.marginChangePct, (x) => x.toFixed(1) + '%')}, sd ${inr(c.marginChange.sd)}).`;
    const wDir = R.wasted <= F.wasted ? 'falls' : 'rises', mDir = R.margin >= F.margin ? 'rises' : 'falls';
    $('chartTakeaway').innerHTML = `<b>Takeaway (seed ${state.seed}):</b> waste ${wDir} from ${n(F.wasted)} to ${n(R.wasted)} units, and margin ${mDir} from ${inrK(F.margin)} to ${inrK(R.margin)}` +
      (wDir === 'falls' && mDir === 'falls' ? ', so this rule buys less waste with margin.' : wDir === 'falls' ? ', so this rule wins on both.' : '.');
  }

  // ---------- plain-English verdict ----------
  function renderInsight(f, r, c) {
    const wr = c.wasteReductionPct, dm = c.marginChange.mean, dmp = c.marginChangePct;
    const unitsSaved = c.fixed.wasted.mean - c.policy.wasted.mean;
    const el = $('insight');
    // per-product margin change on the current seed
    const diffs = r.products.map((p, i) => ({ name: p.name, dm: p.margin - f.products[i].margin, dw: f.products[i].wasted - p.wasted }));
    const top = diffs.filter(d => d.dm > 0).sort((a, b) => b.dm - a.dm).slice(0, 3);
    const worst = diffs.slice().sort((a, b) => a.dm - b.dm)[0];
    const name = policy().name;
    let cls, verdict, body;
    if (Math.abs(wr) < 0.5 && Math.abs(dmp) < 0.5) {
      cls = ''; verdict = 'No change: this rule never marks anything down.';
      body = 'Move a slider or pick a preset to test a markdown rule against fixed price.';
    } else if (wr > 0 && dm >= 0) {
      cls = 'win'; verdict = `✅ Win–win: waste ${sgn(-wr, (x) => x.toFixed(0) + '%')}, margin ${sgn(dmp, (x) => x.toFixed(1) + '%')} (${sgn(dm, inr)} a month).`;
      body = `${name} saves about ${Math.round(unitsSaved)} units a month from the bin and earns more doing it, averaged over 10 seeds.` +
        (top.length ? ` Biggest gains this run: ${top.map(t => `${t.name} (${sgn(t.dm, inr)})`).join(', ')}.` : '');
    } else if (wr > 0 && dm < 0) {
      const perUnit = unitsSaved > 0 ? -dm / unitsSaved : 0;
      cls = 'trade'; verdict = `⚖️ Trade-off: waste ${sgn(-wr, (x) => x.toFixed(0) + '%')}, but margin ${sgn(dmp, (x) => x.toFixed(1) + '%')} (${sgn(dm, inr)} a month).`;
      body = `You are paying about <b>${inr(perUnit)} of margin for every unit kept out of the bin</b>, mostly because full-price shoppers grab the discounted units.` +
        (worst && worst.dm < 0 ? ` Hardest hit this run: ${worst.name} (${sgn(worst.dm, inr)}).` : '') + ' Try smaller, later discounts, or press <b>★ Recommended category rules</b>.';
    } else {
      cls = 'lose'; verdict = `❌ Worse than fixed price: waste ${sgn(-wr, (x) => x.toFixed(0) + '%')}, margin ${sgn(dmp, (x) => x.toFixed(1) + '%')}.`;
      body = 'This rule does not reduce waste. Check the per-product view to see why.';
    }
    el.className = 'insight ' + cls;
    el.innerHTML = `<div class="verdict">${verdict}</div><p>${body}</p>`;
  }

  // ---------- shareable URL state ----------
  function writeHash() {
    const t = state.tiers;
    const q = new URLSearchParams({ d2: Math.round(t.d2 * 100), d1: Math.round(t.d1 * 100), d0: Math.round(t.d0 * 100),
      seed: state.seed, resp: state.resp, over: state.over, floor: state.floor ? 1 : 0, opt: state.byCategory ? 1 : 0 });
    if (state.byCategory) q.set('cats', JSON.stringify(state.byCategory));
    if (role) q.set('role', role);
    try { history.replaceState(null, '', '#' + q.toString()); } catch (e) { /* file:// or sandbox */ }
  }
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (!q.has('seed')) return false;
    const num = (k, d, lo, hi) => { const v = parseFloat(q.get(k)); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    state.tiers = { d2: num('d2', 20, 0, 70) / 100, d1: num('d1', 40, 0, 70) / 100, d0: num('d0', 50, 0, 70) / 100 };
    state.seed = Math.round(num('seed', 42, 1, 99999)); state.resp = num('resp', 1, 0.25, 2); state.over = num('over', 1.2, 1, 1.5);
    state.floor = q.get('floor') === '1';
    $('seed').value = state.seed; $('resp').value = state.resp; $('over').value = state.over; $('floor').checked = state.floor;
    if (q.has('cats')) {
      try {
        const categories = JSON.parse(q.get('cats'));
        const names = Object.keys(S.CATEGORIES);
        if (categories && names.every(name => {
          const t = categories[name];
          return t && ['d2', 'd1', 'd0'].every(k => Number.isFinite(t[k]) && t[k] >= 0 && t[k] <= 0.7) &&
            t.d2 <= t.d1 && t.d1 <= t.d0;
        })) {
          state.byCategory = {};
          names.forEach(name => { state.byCategory[name] = categories[name]; });
          return true;
        }
      } catch (e) {
        // Invalid shared category rules are ignored; the app still loads the base policy.
      }
    }
    return q.get('opt') === '1' ? 'opt' : true;
  }

  // ---------- CSV export ----------
  function downloadCSV() {
    if (!last) return;
    const rows = [['product', 'category', 'policy', 'seed', 'received', 'sold', 'sold_reduced', 'wasted', 'waste_rate', 'revenue_inr', 'purchase_cost_inr', 'waste_cost_inr', 'ending_stock', 'margin_inr', 'lost_sales']];
    for (const [label, res] of [['fixed price', last.fixed], [policy().name, last.rule]]) {
      for (const p of res.products) rows.push([p.name, p.category, label, state.seed, p.received, p.sold, p.markdownUnits, p.wasted,
        p.wastePct.toFixed(4), p.revenue.toFixed(2), p.purchaseCost.toFixed(2), p.wasteCost.toFixed(2), p.endingStock, p.margin.toFixed(2), p.lostSales]);
    }
    const csv = rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `markdown-before-waste_seed${state.seed}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- charts ----------
  function baseOpts(extra) {
    const ink = css('--muted'), line = css('--line');
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: ink, boxWidth: 12 } } },
      scales: { x: { ticks: { color: ink }, grid: { color: line } }, y: { ticks: { color: ink }, grid: { color: line }, beginAtZero: true } },
    }, extra || {});
  }
  function upsert(id, cfg) {
    if (charts[id]) { charts[id].data = cfg.data; charts[id].options = cfg.options; charts[id].update(); return; }
    charts[id] = new Chart($(id), cfg);
  }
  const dayLabels = (r) => r.daily.map(d => `${d.day + 1} ${d.weekday}`);

  function renderDailyCharts(f, r) {
    upsert('cWaste', { type: 'bar', data: { labels: dayLabels(f), datasets: [
      { label: 'Fixed price', data: f.daily.map(d => d.wastedUnits), backgroundColor: css('--fixed') },
      { label: 'Your rule', data: r.daily.map(d => d.wastedUnits), backgroundColor: css('--rule') },
    ] }, options: baseOpts() });
    // cumulative margin: revenue − cost of purchases, ending stock added on final day
    const cum = (res) => {
      const purch = new Array(res.daily.length).fill(0);
      res.products.forEach(p => {
        const prod = S.PRODUCTS.find(x => x.id === p.id);
        p.timeline.forEach(t => { purch[t.day] += t.received * prod.unitCost; });
      });
      let acc = 0; const endVal = res.products.reduce((s, p) => s + p.endingStock * S.PRODUCTS.find(x => x.id === p.id).unitCost, 0);
      return res.daily.map((d, i) => { acc += d.revenue - purch[i]; return Math.round(acc + (i === res.daily.length - 1 ? endVal : 0)); });
    };
    upsert('cMargin', { type: 'line', data: { labels: dayLabels(f), datasets: [
      { label: 'Fixed price', data: cum(f), borderColor: css('--fixed'), pointRadius: 0, tension: .2 },
      { label: 'Your rule', data: cum(r), borderColor: css('--rule'), pointRadius: 0, tension: .2, borderWidth: 2.5 },
    ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--line') } }, y: { ticks: { color: css('--muted'), callback: (v) => inrK(v) }, grid: { color: css('--line') } } } }) });
  }

  function computeFrontier() {
    const key = [state.resp, state.over, state.floor].join('|');
    if (state.frontierKey === key) return state.frontier;
    const levels = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]; const pts = []; const seeds = [1, 2, 3];
    for (const d2 of levels) for (const d1 of levels) for (const d0 of levels) {
      if (!(d2 <= d1 && d1 <= d0)) continue;
      const m = S.multiSeed({ policy: { name: 'g', tiers: { d2, d1, d0 } }, params: params() }, seeds);
      pts.push({ x: m.wasted.mean, y: m.margin.mean, t: { d2, d1, d0 } });
    }
    state.frontierKey = key; state.frontier = pts; return pts;
  }
  function renderFrontier() {
    const pts = computeFrontier();
    const seeds = [1, 2, 3];
    const cur = S.multiSeed({ policy: policy(), params: params() }, seeds);
    const fx = pts.find(p => p.t.d0 === 0);
    const datasets = [
      { label: 'Single-rule options', data: pts, backgroundColor: css('--line'), borderColor: css('--muted'), borderWidth: .5, pointRadius: 4 },
      { label: 'Fixed price', data: [fx], backgroundColor: css('--fixed'), pointRadius: 8, pointStyle: 'rectRot' },
      { label: 'Your rule', data: [{ x: cur.wasted.mean, y: cur.margin.mean }], backgroundColor: css('--rule'), pointRadius: 9, pointStyle: 'star', borderColor: css('--rule'), borderWidth: 2 },
    ];
    const o = baseOpts({
      interaction: { mode: 'nearest', intersect: true },
      plugins: { legend: { labels: { color: css('--muted') } }, tooltip: { callbacks: { label: (ctx) => {
        const p = ctx.raw; const t = p.t ? ` · rule ${tierStr(p.t)}` : '';
        return `${ctx.dataset.label}${t}: ${Math.round(p.x)} units wasted, margin ${inr(p.y)}`;
      } } } },
      scales: {
        x: { title: { display: true, text: 'Units wasted in 30 days (lower is better)', color: css('--muted') }, ticks: { color: css('--muted') }, grid: { color: css('--line') }, beginAtZero: true },
        y: { title: { display: true, text: 'Margin, ₹ (higher is better)', color: css('--muted') }, ticks: { color: css('--muted'), callback: (v) => inrK(v) }, grid: { color: css('--line') } },
      },
    });
    upsert('cFrontier', { type: 'scatter', data: { datasets }, options: o });
  }

  // ---------- per-product ----------
  function discColor(x) {
    if (x <= 0) return css('--chip');
    const a = Math.min(1, 0.25 + x * 1.1);
    return `rgba(230,162,60,${a.toFixed(2)})`;
  }
  function renderHeat(r) {
    const D = r.daily.length;
    let h = '<tr><th></th>' + r.daily.map(d => `<th title="${d.weekday}">${d.day + 1}</th>`).join('') + '</tr>';
    for (const p of r.products) {
      h += `<tr data-id="${p.id}" class="${p.id === state.selProduct ? 'sel' : ''}"><th class="pname">${p.name}</th>`;
      for (let d = 0; d < D; d++) {
        const t = p.timeline[d];
        const md = t.discounts.reduce((m, x) => Math.max(m, x.discount), 0);
        const tip = `${p.name}, day ${d + 1}: ${md ? 'up to ' + pct(md) + ' off, ' : ''}${t.markdownSold} sold reduced, ${t.sold} sold total, ${t.wasted} wasted`;
        h += `<td style="background:${discColor(md)}" title="${tip}">${t.markdownSold || ''}${t.wasted ? '<span class="w"></span>' : ''}</td>`;
      }
      h += '</tr>';
    }
    $('heat').innerHTML = h;
    $('heat').querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { state.selProduct = tr.dataset.id; renderHeat(last.rule); renderProduct(); }));
    $('heatLegend').innerHTML = [0, 0.2, 0.4, 0.6].map(x => `<span><i style="background:${discColor(x)}"></i>${x ? pct(x) + ' off' : 'full price'}</span>`).join('') +
      `<span><i style="background:var(--waste);border-radius:50%;width:8px;height:8px"></i>units wasted at close</span>`;
  }
  function renderProduct() {
    if (!last) return;
    const p = last.rule.products.find(x => x.id === state.selProduct);
    const f = last.fixed.products.find(x => x.id === state.selProduct);
    const prod = S.PRODUCTS.find(x => x.id === state.selProduct);
    $('prodTitle').innerHTML = `${prod.name} <span class="muted">· ${prod.category} · shelf life ${prod.shelfLife} d · cost ${inr(prod.unitCost)} · price ${inr(prod.basePrice)} · sensitivity ${prod.sens}</span>`;
    upsert('cProduct', { type: 'bar', data: { labels: dayLabels(last.rule), datasets: [
      { label: 'Sold at full price', data: p.timeline.map(t => t.sold - t.markdownSold), backgroundColor: css('--rule'), stack: 'r' },
      { label: 'Sold reduced', data: p.timeline.map(t => t.markdownSold), backgroundColor: css('--amber'), stack: 'r' },
      { label: 'Wasted (your rule)', data: p.timeline.map(t => t.wasted), backgroundColor: css('--waste'), stack: 'r' },
      { label: 'Wasted (fixed price)', data: f.timeline.map(t => t.wasted), type: 'line', borderColor: css('--fixed'), borderDash: [4, 4], pointRadius: 2 },
    ] }, options: baseOpts({ scales: { x: { stacked: true, ticks: { color: css('--muted') }, grid: { color: css('--line') } }, y: { stacked: true, ticks: { color: css('--muted') }, grid: { color: css('--line') } } } }) });
  }
  function renderProductTable(f, r) {
    let h = '<tr><th>Product</th><th>Category</th><th>Received</th><th>Sold reduced</th><th>Wasted: fixed → rule</th><th>Waste rate</th><th>Margin: fixed → rule</th><th>Δ margin</th></tr>';
    r.products.forEach((p, i) => {
      const q = f.products[i]; const dm = p.margin - q.margin;
      h += `<tr><td>${p.name}</td><td class="left">${p.category}</td><td>${p.received}</td><td>${p.markdownUnits}</td>
        <td>${q.wasted} → <b>${p.wasted}</b></td><td>${pct(q.wastePct, 1)} → ${pct(p.wastePct, 1)}</td>
        <td>${inr(q.margin)} → ${inr(p.margin)}</td><td class="${dm >= 0 ? 'good' : 'bad'}">${sgn(dm, inr)}</td></tr>`;
    });
    $('prodTable').innerHTML = h;
  }

  // ---------- robustness ----------
  function renderSensitivity() {
    const resps = [0.5, 1, 1.5], overs = [1.1, 1.2, 1.3];
    let h = '<tr><th>Shopper response ↓ / Overstock →</th>' + overs.map(o => `<th>${o.toFixed(1)}×</th>`).join('') + '</tr>';
    let wins = 0, cells = 0;
    for (const rr of resps) {
      h += `<tr><td>${rr}× ${rr === 0.5 ? '(shoppers respond half as strongly)' : rr === 1 ? '(base case)' : '(stronger response)'}</td>`;
      for (const o of overs) {
        const c = S.compare(policy(), { params: params({ responseMult: rr, overstock: o }) }, SEEDS);
        const isCur = Math.abs(rr - state.resp) < 1e-9 && Math.abs(o - state.over) < 1e-9;
        cells++; if (c.marginChange.mean >= 0 && c.wasteReductionPct > 0) wins++;
        h += `<td class="${isCur ? 'cur' : ''}"><span class="${c.wasteReductionPct >= 0 ? 'good' : 'bad'}">${sgn(-c.wasteReductionPct, (x) => x.toFixed(0) + '%')} waste</span><br>
          <span class="${c.marginChange.mean >= 0 ? 'good' : 'bad'}">${sgn(c.marginChangePct, (x) => x.toFixed(1) + '%')} margin</span></td>`;
      }
      h += '</tr>';
    }
    $('sensTable').innerHTML = h;
    $('sensNote').innerHTML = `Your rule cuts waste <b>and</b> keeps or grows margin in <b>${wins} of ${cells}</b> scenarios.`;
  }
  function renderSeeds(c) {
    upsert('cSeeds', { type: 'bar', data: { labels: SEEDS.map(s => 'seed ' + s), datasets: [
      { label: 'Margin, fixed price', data: c.fixed.runs.map(r => Math.round(r.margin)), backgroundColor: css('--fixed') },
      { label: 'Margin, your rule', data: c.policy.runs.map(r => Math.round(r.margin)), backgroundColor: css('--rule') },
    ] }, options: baseOpts({ scales: { x: { ticks: { color: css('--muted') }, grid: { color: css('--line') } }, y: { ticks: { color: css('--muted'), callback: (v) => inrK(v) }, grid: { color: css('--line') } } } }) });
  }

  // ---------- recommended next steps (action planner) ----------
  // Every suggestion is checked in the simulator (10 seeds) against the current setup before it is shown.
  let planTimer = null, planText = '';
  const planCache = { key: null, opt: null };
  function schedulePlan() {
    clearTimeout(planTimer);
    $('actions').innerHTML = '<li class="muted">Updating suggestions…</li>';
    planTimer = setTimeout(renderPlan, 350);
  }
  function optimisedTiers() {
    const key = [state.resp, state.over, state.floor, state.penalty].join('|');
    if (planCache.key !== key) {
      const o = {};
      for (const c of Object.keys(S.CATEGORIES)) o[c] = S.optimizeCategory(c, { seeds: SEEDS, wastePenalty: state.penalty, params: params() }).best.tiers;
      planCache.key = key; planCache.opt = o;
    }
    return planCache.opt;
  }
  function renderPlan() {
    if (!last || !roleCfg().tabs.includes('dash')) return;
    const pol = policy(), P = params(), cmp = last.cmp;
    const money = [], other = [];
    const perMonth = (x) => sgn(x, inr) + '/mo';

    // 1) A better pricing rule for the whole store
    let opt = null;
    if (!state.byCategory) {
      opt = optimisedTiers();
      const m = S.multiSeed({ policy: { name: 'opt', tiers: { d2: 0, d1: 0, d0: 0 }, byCategory: opt }, params: P }, SEEDS);
      const gain = m.margin.mean - cmp.policy.margin.mean;
      const dw = m.wasted.mean - cmp.policy.wasted.mean;
      if (gain > 200) money.push({ icon: '🎯', pri: 'high', impact: gain,
        title: 'Switch to the recommended category rules',
        detail: `${Object.entries(opt).map(([c, t]) => `${c} ${tierStr(t)}`).join(' · ')}. Units wasted ${dw <= 0 ? 'fall' : 'rise'} by ${Math.abs(Math.round(dw))} a month compared with your current rule.`,
        btn: { label: 'Apply', fn: () => { state.byCategory = Object.assign({}, opt); clearPresets(); schedule(); } } });
    }

    // 2) Categories where the current rule earns less than fixed price
    for (const c of Object.keys(S.CATEGORIES)) {
      const prods = S.PRODUCTS.filter(p => p.category === c);
      const a = S.multiSeed({ products: prods, policy: pol, params: P }, SEEDS);
      const f = S.multiSeed({ products: prods, policy: S.FIXED, params: P }, SEEDS);
      const d = a.margin.mean - f.margin.mean;
      if (d < -300) {
        const act = { icon: '✋', pri: 'warn', impact: -d, impLabel: perMonth(-d) + ' at stake',
          title: `Soften markdowns on ${c}`,
          detail: `Your rule earns ${inr(-d)} a month less than fixed price here, while saving ${Math.max(0, Math.round(f.wasted.mean - a.wasted.mean))} units from the bin. Shoppers who would pay full price are taking the discount.` };
        if (opt) act.btn = { label: `Optimise ${c}`, fn: () => {
          const by = {}; for (const k of Object.keys(S.CATEGORIES)) by[k] = (state.byCategory && state.byCategory[k]) || state.tiers;
          by[c] = opt[c]; state.byCategory = by; clearPresets(); schedule(); } };
        money.push(act);
      }
    }

    // 3) Ordering: try stocking each product up to 1.0×–1.4× expected demand (other products unchanged)
    const levels = [1.0, 1.1, 1.2, 1.3, 1.4], orderActs = [];
    for (const prod of S.PRODUCTS) {
      const run = (o) => S.multiSeed({ products: [Object.assign({}, prod, { overstock: o })], policy: pol, params: P }, SEEDS);
      const cur = run(state.over);
      let best = null;
      for (const o of levels) {
        if (Math.abs(o - state.over) < 1e-9) continue;
        const r = run(o);
        // Service-level guardrail: never trade margin for noticeably emptier shelves.
        if (r.lostSales.mean > Math.max(cur.lostSales.mean * 1.5, cur.lostSales.mean + 10)) continue;
        if (!best || r.margin.mean > best.r.margin.mean) best = { o, r };
      }
      const gain = best ? best.r.margin.mean - cur.margin.mean : 0;
      if (gain > 250) {
        const less = best.o < state.over;
        orderActs.push({ icon: less ? '📦' : '🛒', pri: 'mid', impact: gain,
          title: `${less ? 'Order less' : 'Order more'} ${prod.name}: stock up to ${best.o.toFixed(1)}× expected demand instead of ${state.over.toFixed(1)}×`,
          detail: less
            ? `Units wasted ${Math.round(cur.wasted.mean)} → ${Math.round(best.r.wasted.mean)} a month; empty-shelf lost sales ${Math.round(cur.lostSales.mean)} → ${Math.round(best.r.lostSales.mean)}.`
            : `Empty-shelf lost sales ${Math.round(cur.lostSales.mean)} → ${Math.round(best.r.lostSales.mean)} a month; units wasted ${Math.round(cur.wasted.mean)} → ${Math.round(best.r.wasted.mean)}.` });
      }
    }
    orderActs.sort((a, b) => b.impact - a.impact);
    money.push(...orderActs.slice(0, 3));
    money.sort((a, b) => b.impact - a.impact);

    // 4) Is the result fragile? Re-test with shoppers responding half as strongly
    const isMarkdown = pol.byCategory || pol.tiers.d0 > 0 || pol.tiers.d1 > 0 || pol.tiers.d2 > 0;
    if (isMarkdown) {
      const low = S.compare(pol, { params: params({ responseMult: 0.5 }) }, SEEDS);
      if (low.marginChange.mean < 0) other.push({ icon: '🧪', pri: 'warn',
        title: 'Pilot before rolling out to every category',
        detail: `If shoppers respond only half as strongly to discounts, this rule changes margin by ${sgn(low.marginChangePct, (x) => x.toFixed(1) + '%')} against fixed price. Trial it on 1–2 categories for two weeks and compare waste and margin with the rest.` });
      else other.push({ icon: '🛡️', pri: 'mid',
        title: 'Holds up if shoppers react less than assumed',
        detail: `Even at half the shopper response, this rule still cuts waste ${low.wasteReductionPct.toFixed(0)}% and changes margin by ${sgn(low.marginChangePct, (x) => x.toFixed(1) + '%')}. Safe to pilot store-wide.` });
    }

    // 5) Today's shop-floor task
    const day = +$('dealDay').value, deals = last.rule.deals[day] || [];
    if (deals.length) other.push({ icon: '🏷️', pri: 'mid',
      title: `Today (day ${day + 1}, ${last.rule.daily[day].weekday}): mark down ${deals.length} batch${deals.length > 1 ? 'es' : ''}`,
      detail: deals.slice().sort((a, b) => b.discount - a.discount).slice(0, 4).map(x => `${x.name} ${pct(x.discount)} off (${x.units} unit${x.units === 1 ? '' : 's'})`).join(', ') + (deals.length > 4 ? `, +${deals.length - 4} more` : '') + '.',
      btn: { label: 'Shelf labels', fn: () => document.querySelector('.tab[data-tab="deals"]').click() } });

    const acts = money.slice(0, 5).concat(other);
    if (!money.length) acts.unshift({ icon: '✅', pri: 'high',
      title: 'Your current setup is already the best the planner found',
      detail: 'No pricing or ordering change it tested adds more than ₹250 a month. Keep this rule and review it monthly.' });

    const ol = $('actions'); ol.innerHTML = '';
    planText = `Markdown Before Waste: action plan (seed ${state.seed}, ${policy().name}; simulator estimates, 10-seed means, synthetic data)\n`;
    acts.forEach((a, i) => {
      const li = document.createElement('li');
      li.className = 'act p-' + a.pri;
      const imp = a.impact ? `<span class="imp">${a.impLabel || perMonth(a.impact)}</span>` : '';
      li.innerHTML = `<div class="ic">${a.icon}</div><div><div class="t">${a.title}</div><div class="d">${a.detail}</div></div><div class="side">${imp}</div>`;
      if (a.btn && !roleCfg().apply && a.btn.label !== 'Shelf labels') a.btn = null;
      if (a.btn && a.btn.label === 'Shelf labels' && !roleCfg().tabs.includes('deals')) a.btn = null;
      if (a.btn) {
        const b = document.createElement('button'); b.className = 'chip'; b.textContent = a.btn.label;
        b.addEventListener('click', a.btn.fn); li.querySelector('.side').appendChild(b);
      }
      ol.appendChild(li);
      planText += `${i + 1}. ${a.title}${a.impact ? ` [${a.impLabel || perMonth(a.impact)}]` : ''}: ${a.detail}\n`;
    });
  }

  // ---------- optimiser ----------
  function runOptimiser(applyAfter) {
    const btn = $('runOpt'); btn.disabled = true;
    const cats = Object.keys(S.CATEGORIES); const out = {}; let i = 0;
    const step = () => {
      if (i < cats.length) {
        $('optStatus').textContent = `Searching ${cats[i]}… (${i + 1}/${cats.length})`;
        setTimeout(() => {
          out[cats[i]] = S.optimizeCategory(cats[i], { seeds: SEEDS, wastePenalty: state.penalty, params: params() });
          i++; step();
        }, 20);
        return;
      }
      state.opt = out; btn.disabled = false;
      $('optStatus').textContent = `Done: ${cats.length * out[cats[0]].evaluated} rules × 10 seeds evaluated.`;
      renderOptTable();
      if (applyAfter) { clearPresets(); applyOptimised(); schedule(); }
    };
    step();
  }
  function applyOptimised() {
    state.byCategory = {}; for (const c in state.opt) state.byCategory[c] = state.opt[c].best.tiers;
  }
  function renderOptTable() {
    const o = state.opt;
    let h = '<tr><th>Category</th><th>Best rule (2 d / 1 d / last day)</th><th>Margin: fixed → best</th><th>Δ margin</th><th>Wasted: fixed → best</th></tr>';
    for (const c in o) {
      const r = o[c]; const dm = r.best.margin - r.fixed.margin;
      h += `<tr><td>${c}</td><td><b>${tierStr(r.best.tiers)}</b></td><td>${inr(r.fixed.margin)} → ${inr(r.best.margin)}</td>
        <td class="${dm >= 0 ? 'good' : 'bad'}">${sgn(dm, inr)}</td><td>${Math.round(r.fixed.wasted)} → ${Math.round(r.best.wasted)}</td></tr>`;
    }
    $('optTable').innerHTML = h;
    // out-of-sample check on seeds never used by the search
    const by = {}; for (const c in o) by[c] = o[c].best.tiers;
    const oos = S.compare({ name: 'opt', tiers: { d2: 0, d1: 0, d0: 0 }, byCategory: by }, { params: params() }, OOS_SEEDS);
    const naive = S.compare(S.DEFAULT_MARKDOWN, { params: params() }, OOS_SEEDS);
    const el = $('optOOS'); el.hidden = false;
    el.innerHTML = `<b>Out-of-sample check</b> on 30 seeds the search never saw (101–130): the optimised rules cut waste by <b>${naive.wasteReductionPct >= 0 ? '' : '−'}${oos.wasteReductionPct.toFixed(1)}%</b> and change margin by <b>${sgn(oos.marginChangePct, (x) => x.toFixed(1) + '%')}</b> vs fixed price. ` +
      `For comparison, the naïve 20/40/50 % rule cuts waste ${naive.wasteReductionPct.toFixed(1)}% but changes margin ${sgn(naive.marginChangePct, (x) => x.toFixed(1) + '%')}. ` +
      `<button class="chip" id="applyOpt">Apply optimised rules</button>`;
    $('applyOpt').addEventListener('click', () => { clearPresets(); applyOptimised(); schedule(); });
  }

  // ---------- deals ----------
  function renderDeals() {
    if (!last) return;
    const d = +$('dealDay').value; const r = last.rule;
    $('o_day').textContent = `Day ${d + 1} (${r.daily[d].weekday})`;
    const list = r.deals[d].slice().sort((a, b) => b.discount - a.discount);
    if (!list.length) { $('deals').innerHTML = '<div class="empty">No reduced items today with this rule.</div>'; return; }
    $('deals').innerHTML = list.map(x => `<div class="deal"><span class="off">${pct(x.discount)} OFF</span>
      <div class="cat">${x.category}</div><div class="name">${x.name}</div>
      <div><span class="price">${inr(x.price)}</span><span class="was">${inr(x.basePrice)}</span></div>
      <div class="meta">${role === 'shopper' ? '' : x.units + ' on the shelf · '}${x.daysLeft === 0 ? 'best before today' : x.daysLeft === 1 ? 'best before tomorrow' : 'best before in ' + x.daysLeft + ' days'}</div></div>`).join('');
  }

  // ---------- roles (demo sign-in, no passwords: views are not a security boundary) ----------
  const ROLES = {
    manager: { label: 'Store manager', icon: '🧑‍💼', tabs: ['dash', 'product', 'optim', 'robust', 'deals', 'assume'], controls: true, apply: true, publish: true, print: true },
    analyst: { label: 'Analyst', icon: '📊', tabs: ['dash', 'product', 'optim', 'robust', 'assume'], controls: true, apply: false, publish: false, print: false },
    staff: { label: 'Shelf staff', icon: '🏷️', tabs: ['deals'], controls: false, apply: false, publish: false, print: true },
    shopper: { label: 'Shopper', icon: '🛒', tabs: ['deals'], controls: false, apply: false, publish: false, print: false },
  };
  let role = null;
  function roleCfg() { return ROLES[role] || ROLES.manager; }
  const PUB_KEY = 'mbw_published_rule';
  function readPublished() { try { return JSON.parse(localStorage.getItem(PUB_KEY)); } catch (e) { return null; } }
  function publishRule() {
    const rec = { name: policy().name, tiers: state.tiers, byCategory: state.byCategory, seed: state.seed, at: new Date().toISOString() };
    try { localStorage.setItem(PUB_KEY, JSON.stringify(rec)); $('copyMsg').textContent = 'Saved as the store rule (demo: this browser only). Shelf staff and shoppers here now see it.'; }
    catch (e) { $('copyMsg').textContent = 'Could not save (browser storage blocked).'; }
    setTimeout(() => { $('copyMsg').textContent = ''; }, 5000);
  }
  function useStoreRule() {
    // Staff and shoppers always see the rule the manager published (or the optimised default).
    const pub = readPublished();
    if (pub && pub.tiers) {
      state.tiers = pub.tiers; state.byCategory = pub.byCategory || null; state.seed = pub.seed || state.seed;
      $('storeRule').textContent = `Store rule: ${pub.name}, saved by the store manager (demo, this browser) ${new Date(pub.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.`;
      schedule();
    } else {
      $('storeRule').textContent = 'Loading the store rule…';
      setTimeout(() => {
        state.byCategory = Object.assign({}, optimisedTiers());
        $('storeRule').textContent = 'Store rule: recommended category rules (default: no rule saved yet).';
        schedule();
      }, 30);
    }
  }
  function signIn(r) {
    if (!ROLES[r]) return;
    role = r; const cfg = ROLES[r];
    try { sessionStorage.setItem('mbw_role', r); } catch (e) { /* storage blocked */ }
    document.body.dataset.role = r;
    if (r === 'shopper') renderDeals();
    $('login').hidden = true;
    $('who').hidden = false; $('whoLabel').textContent = `${cfg.icon} ${cfg.label}`;
    document.querySelectorAll('.tab').forEach(t => { t.hidden = !cfg.tabs.includes(t.dataset.tab); });
    const active = document.querySelector('.tab.active');
    if (!active || active.hidden) document.querySelector(`.tab[data-tab="${cfg.tabs[0]}"]`).click();
    $('controls').hidden = !cfg.controls;
    $('publishBtn').hidden = !cfg.publish;
    $('printBtn').hidden = !cfg.print;
    if (cfg.controls) $('storeRule').textContent = '';
    if (!cfg.controls) useStoreRule(); else schedule();
  }
  function showLogin() { $('login').hidden = false; const b = document.querySelector('.role'); if (b) b.focus(); }

  // ---------- static tables ----------
  function renderStatic() {
    $('assumeTable').innerHTML = '<tr><th>Assumption</th><th style="text-align:left">Value and justification</th></tr>' +
      S.ASSUMPTIONS.map(([k, v]) => `<tr><td>${k}</td><td class="left">${v}</td></tr>`).join('');
    $('masterTable').innerHTML = '<tr><th>Product</th><th>Category</th><th>Shelf life (d)</th><th>Unit cost</th><th>Base price</th><th>Avg demand / day</th><th>Price sensitivity</th><th>Delivery every</th></tr>' +
      S.PRODUCTS.map(p => `<tr><td>${p.name}</td><td class="left">${p.category}</td><td>${p.shelfLife}</td><td>${inr(p.unitCost)}</td><td>${inr(p.basePrice)}</td><td>${p.demand}</td><td>${p.sens}</td><td>${S.CATEGORIES[p.category].cadence} d</td></tr>`).join('');
  }

  // ---------- boot ----------
  bindControls(); renderStatic();
  const linkRole = new URLSearchParams(location.hash.slice(1)).get('role'); // read before render() rewrites the hash
  const fromLink = readHash();
  syncControls();
  const t0 = state.tiers;
  if (t0.d2 === 0.2 && t0.d1 === 0.4 && t0.d0 === 0.5) document.querySelector('.chip[data-preset="naive"]').classList.add('on');
  render();
  if (fromLink === 'opt') runOptimiser(true);
  let startRole = linkRole;
  if (!ROLES[startRole]) { try { startRole = sessionStorage.getItem('mbw_role'); } catch (e) { startRole = null; } }
  if (ROLES[startRole]) signIn(startRole); else showLogin();
  window.__MBW_STATE = state; // for debugging in the console
})();
