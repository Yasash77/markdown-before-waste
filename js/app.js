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
    $('dealDay').addEventListener('input', () => { $('todoDay').value = $('dealDay').value; renderDeals(); renderTodo(); });
    $('todoDay').addEventListener('input', () => { $('dealDay').value = $('todoDay').value; renderDeals(); renderTodo(); });
    $('todoCopy').addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(todoText); e.target.textContent = 'Copied ✓'; } catch (err) { e.target.textContent = 'Copy failed'; }
      setTimeout(() => { e.target.textContent = 'Copy for WhatsApp'; }, 2500);
    });
    $('todoPrint').addEventListener('click', () => {
      document.body.classList.add('print-todo');
      window.print();
      setTimeout(() => document.body.classList.remove('print-todo'), 500);
    });
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
    renderTodo();
    renderShop();
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
    countUp($('kpis'));
    $('seedline').innerHTML = `30-day simulation · seed <b>${state.seed}</b> · big number = <b>${policy().name}</b>, “Fixed price” = baseline. ` +
      `Over 10 seeds: waste <b class="${c.wasteReductionPct >= 0 ? 'good' : 'bad'}">${sgn(-c.wasteReductionPct, (x) => x.toFixed(1) + '%')}</b>, ` +
      `margin <b class="${c.marginChange.mean >= 0 ? 'good' : 'bad'}">${sgn(c.marginChange.mean, inr)}</b> (${sgn(c.marginChangePct, (x) => x.toFixed(1) + '%')}, sd ${inr(c.marginChange.sd)}).`;
    const wDir = R.wasted <= F.wasted ? 'falls' : 'rises', mDir = R.margin >= F.margin ? 'rises' : 'falls';
    $('chartTakeaway').innerHTML = `<b>Takeaway (seed ${state.seed}):</b> waste ${wDir} from ${n(F.wasted)} to ${n(R.wasted)} units, and margin ${mDir} from ${inrK(F.margin)} to ${inrK(R.margin)}` +
      (wDir === 'falls' && mDir === 'falls' ? ', so this rule buys less waste with margin.' : wDir === 'falls' ? ', so this rule wins on both.' : '.');
  }

  // ---------- fun layer: count-up numbers and confetti (both respect reduced motion) ----------
  let lastVerdict = null;
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function countUp(root) {
    if (reduceMotion()) return;
    root.querySelectorAll('.big').forEach(el => {
      const m = el.textContent.match(/^([^0-9]*)([0-9][0-9,]*\.?[0-9]*)(.*)$/);
      if (!m) return;
      const [, pre, numStr, post] = m;
      const target = parseFloat(numStr.replace(/,/g, '')); if (!isFinite(target)) return;
      const dec = (numStr.split('.')[1] || '').length, grouped = numStr.includes(',');
      const t0 = performance.now(), dur = 650;
      const fmt = (v) => grouped ? v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec);
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        el.textContent = pre + fmt(target * e) + post;
        if (k < 1) requestAnimationFrame(step); else el.textContent = pre + numStr + post;
      };
      requestAnimationFrame(step);
    });
  }
  function confetti() {
    if (reduceMotion()) return;
    const cv = $('confetti'); if (!cv) return;
    const ctx = cv.getContext('2d'); const W = cv.width = innerWidth, H = cv.height = innerHeight;
    const cols = ['#1f8a5b', '#2fb37a', '#f5c75e', '#e6a23c', '#ffffff', '#ff8a65'];
    const ps = Array.from({ length: 140 }, () => ({ x: W / 2 + (Math.random() - .5) * W * .4, y: H * .35, vx: (Math.random() - .5) * 14, vy: -Math.random() * 14 - 4,
      s: 5 + Math.random() * 6, c: cols[Math.floor(Math.random() * cols.length)], r: Math.random() * 6, vr: (Math.random() - .5) * .3 }));
    const t0 = performance.now();
    const frame = (t) => {
      ctx.clearRect(0, 0, W, H);
      ps.forEach(p => { p.vy += .35; p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); });
      if (t - t0 < 1800) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
    };
    requestAnimationFrame(frame);
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
    if (cls === 'win' && lastVerdict !== 'win') { confetti(); el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 500); }
    lastVerdict = cls;
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
    $('deals').innerHTML = list.map(x => `<div class="deal">${(window.MBW_PHOTOS || {})[x.id] ? `<div class="dimg" style="background-image:url('${window.MBW_PHOTOS[x.id].url}')" role="img" aria-label="${x.name}"></div>` : ''}<span class="off">${pct(x.discount)} OFF</span>
      <div class="cat">${x.category}</div><div class="name">${x.name}</div>
      <div><span class="price">${inr(x.price)}</span><span class="was">${inr(x.basePrice)}</span></div>
      <div class="meta">${role === 'shopper' ? '' : x.units + ' on the shelf · '}${x.daysLeft === 0 ? 'best before today' : x.daysLeft === 1 ? 'best before tomorrow' : 'best before in ' + x.daysLeft + ' days'}</div></div>`).join('');
  }

  // ---------- roles (demo sign-in, no passwords: views are not a security boundary) ----------
  const ROLES = {
    manager: { label: 'Store manager', icon: '🧑‍💼', tabs: ['dash', 'assume', 'deals', 'product', 'optim', 'robust'], controls: true, apply: true, publish: true, print: true },
    analyst: { label: 'Analyst', icon: '📊', tabs: ['dash', 'product', 'optim', 'robust', 'assume'], controls: true, apply: false, publish: false, print: false },
    staff: { label: 'Shelf staff', icon: '🏷️', tabs: ['assume', 'deals'], controls: false, apply: false, publish: false, print: true },
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
    $('shop').hidden = r !== 'shopper';
    if (r === 'shopper') { $('shopDay').value = $('dealDay').value; window.scrollTo(0, 0); }
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

  // ---------- staff to-do list (plain-language daily checklist from the simulation) ----------
  let todoText = '';
  function renderTodo() {
    if (!last) return;
    const d = +$('todoDay').value, r = last.rule, D = r.daily.length;
    const wd = r.daily[d].weekday;
    const n = (x) => `${x} unit${x === 1 ? '' : 's'}`;
    const items = [];
    const add = (sec, id, title, detail, list, who) => items.push({ sec, id, title, detail, list: list || [], who });
    const byQty = (a, b) => b.q - a.q;

    // Morning
    const deliveries = r.products.map(p => ({ name: p.name, q: p.timeline[d].received })).filter(x => x.q > 0).sort(byQty);
    if (deliveries.length) add('morning', 'receive', `Receive today's deliveries (${deliveries.length} products)`,
      'Count each delivery against the list and put it in the cold room or on the shelf straight away.',
      deliveries.map(x => `${x.name}: ${n(x.q)}`), 'Receiving');
    add('morning', 'rotate', 'Put new stock at the back, older stock in front',
      'Most shoppers take the item at the front. This one habit stops older stock from expiring on the shelf.', [], 'Shelf staff');
    const deals = (r.deals[d] || []).slice().sort((a, b) => b.discount - a.discount);
    if (deals.length) add('morning', 'stickers', `Put reduced-price stickers on ${deals.length} item${deals.length > 1 ? 's' : ''}`,
      'Print the labels from the Today\'s deals tab. Stick them only on the older batch, not on fresh stock.',
      deals.map(x => `${x.name}: ${n(x.units)} → ${inr(x.price)} (${pct(x.discount)} off, ${x.daysLeft === 0 ? 'expires today' : x.daysLeft === 1 ? 'expires tomorrow' : 'expires in ' + x.daysLeft + ' days'})`), 'Shelf staff');
    else add('morning', 'stickers', 'No reduced-price stickers needed today', 'Nothing is close enough to its expiry date for a markdown under the current rule.', [], 'Shelf staff');

    // During the day
    const short = r.products.map(p => ({ name: p.name, q: p.timeline[d].lost })).filter(x => x.q > 0).sort(byQty);
    if (short.length) add('day', 'refill', 'Watch these shelves: they may run empty today',
      'Check at 1 pm and 5 pm. Refill from the back room; if there is none left, tell the manager so tomorrow\'s order can go up.',
      short.map(x => `${x.name}: about ${x.q} shopper${x.q > 1 ? 's' : ''} may find it empty`), 'Shelf staff');
    else add('day', 'refill', 'Quick shelf check at 1 pm and 5 pm', 'No shelf is expected to run empty today. Tidy the fronts and refill as usual.', [], 'Shelf staff');
    if (deals.length) add('day', 'dealshelf', 'Check the reduced items at 5 pm',
      'Make sure the stickers are still on and the reduced items sit at eye level, where evening shoppers will see them.', [], 'Shelf staff');

    // Closing
    const expiring = r.products.map(p => ({ name: p.name, q: p.timeline[d].wasted })).filter(x => x.q > 0).sort(byQty);
    if (expiring.length) add('close', 'remove', 'Remove items that expire today',
      'Take these off the shelf at closing. Do not leave expired food out for tomorrow.',
      expiring.map(x => `${x.name}: about ${n(x.q)} left over`), 'Closing staff');
    else add('close', 'remove', 'Check expiry dates at closing', 'Nothing is expected to be left over today, but still check every item that expires today.', [], 'Closing staff');
    add('close', 'log', 'Write down everything thrown away',
      'Item name and count in the waste log. The manager uses it to fix next week\'s orders.', [], 'Shift lead');

    // Tomorrow
    if (d + 1 < D) {
      const tom = r.products.map(p => ({ name: p.name, q: p.timeline[d + 1].received })).filter(x => x.q > 0).sort(byQty);
      if (tom.length) add('tomorrow', 'space', 'Make room for tomorrow\'s delivery',
        `${tom.length} products arrive tomorrow morning. Biggest ones:`, tom.slice(0, 5).map(x => `${x.name}: ${n(x.q)}`), 'Shift lead');
    }

    // checked state (per seed + day), kept in this browser
    const key = `mbw_todo_${state.seed}_${d}`;
    let done = {};
    try { done = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { done = {}; }
    const SECS = { morning: ['🌅 Before opening', '7–9 am'], day: ['☀️ During the day', 'opening to 6 pm'], close: ['🌙 At closing', 'last hour'], tomorrow: ['📦 Get ready for tomorrow', 'before you leave'] };
    let html = '', text = `Store to-do · Day ${d + 1} (${wd})\n`;
    for (const sec of Object.keys(SECS)) {
      const list = items.filter(i => i.sec === sec);
      if (!list.length) continue;
      html += `<div class="todo-sec">${SECS[sec][0]} <span class="when">${SECS[sec][1]}</span></div><ul class="todo-list">`;
      text += `\n${SECS[sec][0]} (${SECS[sec][1]})\n`;
      for (const it of list) {
        const ck = !!done[it.id];
        html += `<li class="todo-item ${ck ? 'done' : ''}"><input type="checkbox" data-id="${it.id}" ${ck ? 'checked' : ''} aria-label="${it.title}">
          <div><div class="tt">${it.title}<span class="who-tag">${it.who}</span></div><div class="td">${it.detail}</div>
          ${it.list.length ? '<ul>' + it.list.map(x => `<li>${x}</li>`).join('') + '</ul>' : ''}</div></li>`;
        text += `${ck ? '✅' : '☐'} ${it.title} [${it.who}]\n` + it.list.map(x => `   • ${x}\n`).join('');
      }
      html += '</ul>';
    }
    $('todo').innerHTML = html;
    todoText = text;
    const nDone = items.filter(i => done[i.id]).length;
    $('todoDayLabel').textContent = `· Day ${d + 1} (${wd})`;
    $('todoSummary').innerHTML = `${items.length} tasks · <b>${nDone} done</b> · based on the ${role === 'staff' ? 'saved store rule' : 'current rule'} (<b>${policy().name}</b>) and the simulated day. Tick tasks off as you go; ticks are kept in this browser.`;
    $('todo').querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
      done[cb.dataset.id] = cb.checked;
      try { localStorage.setItem(key, JSON.stringify(done)); } catch (e) { /* storage blocked: ticks last for this view only */ }
      renderTodo();
    }));
  }

  // ---------- shopper storefront: "Fresh Finds" ----------
  const EMOJI = { 'bread-white': '🍞', 'bread-brown': '🍞', pav: '🥯', croissant: '🥐', milk: '🥛', curd: '🥣', paneer: '🧀', yogurt: '🍦', cream: '🍶', batter: '🫓',
    banana: '🍌', tomato: '🍅', spinach: '🥬', strawberry: '🍓', lettuce: '🥗', coriander: '🌿', chicken: '🍗', fish: '🐟', sandwich: '🥪', salad: '🥙' };
  // Product ids that have a photo in img/products/<id>.jpg. Add an id here after adding its photo (keeps the console free of 404s).
  const PHOTOS = new Set([]);
  const WEB = window.MBW_PHOTOS || {};
  const photoUrl = (id) => PHOTOS.has(id) ? `img/products/${id}.jpg` : (WEB[id] && WEB[id].url) || '';
  const CATSLUG = { 'Bakery': 'bakery', 'Dairy': 'dairy', 'Produce': 'produce', 'Meat & Fish': 'meat', 'Ready meals': 'ready' };
  const shop = { cat: 'All', q: '', sort: 'value', basket: {}, items: [] };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function pimg(x, big) {
    // Real photo if img/products/<id>.jpg exists; otherwise a food emoji on a category tile.
    return `<div class="pimg cat-${CATSLUG[x.category]}" ${big ? '' : `role="button" tabindex="0" data-qv="${x.key}" aria-label="View details for ${esc(x.name)}"`}>
      ${photoUrl(x.id) ? `<img src="${photoUrl(x.id)}" alt="${esc(x.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><span class="shade"></span>` : ''}
      <span class="emo" aria-hidden="true">${EMOJI[x.id] || '🛒'}</span>
      ${big ? '' : `<span class="save-badge">SAVE ${Math.round(x.discount * 100)}%</span><span class="fresh-pill ${x.daysLeft === 0 ? 'today' : ''}">${freshText(x.daysLeft)}</span>`}
    </div>`;
  }
  const freshText = (d) => d === 0 ? '⏰ Best before today' : d === 1 ? 'Best before tomorrow' : `Best before in ${d} days`;
  function shopItems() {
    const d = +$('shopDay').value;
    return (last.rule.deals[d] || []).map(x => Object.assign({}, x, { key: `${x.id}_${x.daysLeft}`, saving: x.basePrice - x.price }));
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function renderShop() {
    if (!last || role !== 'shopper') return;
    const d = +$('shopDay').value;
    shop.items = shopItems();
    // drop basket lines that no longer exist on this day, cap at shelf stock
    for (const k of Object.keys(shop.basket)) { const it = shop.items.find(i => i.key === k); if (!it) delete shop.basket[k]; else shop.basket[k] = Math.min(shop.basket[k], it.units); }
    $('shopDayLabel').textContent = `${last.rule.daily[d].weekday.toUpperCase()}, DAY ${d + 1}`;
    // honest impact panel: today's real offer + this month's simulated effect of the store's rule
    const units = shop.items.reduce((a, x) => a + x.units, 0);
    const offer = shop.items.reduce((a, x) => a + x.units * x.saving, 0);
    const wasteDelta = last.fixed.totals.wasted - last.rule.totals.wasted;
    const wasteText = `${wasteDelta >= 0 ? 'fewer' : 'more'} items binned this month vs fixed prices*`;
    $('shopImpact').innerHTML = `<div class="big">${units}</div><div class="lbl">near-date items reduced today across ${shop.items.length} deal${shop.items.length === 1 ? '' : 's'}</div>
      <div class="row2"><div class="mini"><b>${inr(offer)}</b><span>off in total if they all find a home</span></div>
      <div class="mini"><b>${Math.abs(Math.round(wasteDelta)).toLocaleString('en-IN')}</b><span>${wasteText}</span></div></div>
      <div class="note">*Store simulation, synthetic data.</div>`;
    // category chips with counts
    const cats = ['All', ...Object.keys(S.CATEGORIES)];
    $('shopCats').innerHTML = cats.map(c => { const n = c === 'All' ? shop.items.length : shop.items.filter(i => i.category === c).length;
      return `<button class="cat-chip ${shop.cat === c ? 'on' : ''}" data-cat="${esc(c)}" aria-pressed="${shop.cat === c}">${c === 'All' ? 'All deals' : c}<span class="n">${n}</span></button>`; }).join('');
    $('shopCats').querySelectorAll('.cat-chip').forEach(b => b.addEventListener('click', () => { shop.cat = b.dataset.cat; renderShop(); }));
    // filter + sort
    const q = shop.q.trim().toLowerCase();
    let list = shop.items.filter(i => (shop.cat === 'All' || i.category === shop.cat) && (!q || i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)));
    const sorters = { value: (a, b) => b.discount - a.discount || b.saving - a.saving, saving: (a, b) => b.saving - a.saving, soon: (a, b) => a.daysLeft - b.daysLeft || b.discount - a.discount, price: (a, b) => a.price - b.price };
    list.sort(sorters[shop.sort]);
    $('shopCount').textContent = `${list.length} deal${list.length === 1 ? '' : 's'}${shop.cat !== 'All' ? ' in ' + shop.cat : ''}${q ? ` matching “${shop.q}”` : ''}`;
    if (!list.length) {
      $('shopGrid').innerHTML = `<div class="shop-empty"><div class="e">🧺</div><p><b>No deals here right now.</b></p><p>${q || shop.cat !== 'All' ? 'Try another search or category.' : 'Nothing is close to its date today. Check back tomorrow!'}</p>
        ${q || shop.cat !== 'All' ? '<button class="cat-chip" id="shopReset">Show all deals</button>' : ''}</div>`;
      const r = $('shopReset'); if (r) r.addEventListener('click', () => { shop.cat = 'All'; shop.q = ''; $('shopSearch').value = ''; renderShop(); });
    } else {
      $('shopGrid').innerHTML = list.map((x, i) => {
        const inB = shop.basket[x.key] || 0;
        return `<article class="pcard" style="animation-delay:${Math.min(i, 12) * 35}ms">
          ${pimg(x)}
          <div class="pbody">
            <span class="pcat">${x.category}</span>
            <button class="pn" data-qv="${x.key}">${esc(x.name)}</button>
            <div class="pprice"><span class="now">${inr(x.price)}</span><span class="was" aria-label="was ${inr(x.basePrice)}">${inr(x.basePrice)}</span></div>
            <span class="psave">You save ${inr(x.saving)} (${Math.round(x.discount * 100)}%)</span>
            <span class="pstock ${x.units <= 5 ? 'low' : ''}">${x.units <= 5 ? `Only ${x.units} left` : freshText(x.daysLeft)}</span>
            <div class="pactions">${inB ? `<div class="stepper"><button data-dec="${x.key}" aria-label="One less ${esc(x.name)}">−</button><span>${inB} in basket</span><button data-inc="${x.key}" aria-label="One more ${esc(x.name)}" ${inB >= x.units ? 'disabled' : ''}>+</button></div>`
              : `<button class="add-btn" data-inc="${x.key}">Add to basket</button>`}</div>
          </div></article>`;
      }).join('');
    }
    $('shopGrid').querySelectorAll('[data-inc]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.inc, 1)));
    $('shopGrid').querySelectorAll('[data-dec]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.dec, -1)));
    $('shopGrid').querySelectorAll('[data-qv]').forEach(b => {
      b.addEventListener('click', () => openQV(b.dataset.qv));
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQV(b.dataset.qv); } });
    });
    renderBasket();
  }
  function changeQty(key, delta) {
    const it = shop.items.find(i => i.key === key); if (!it) return;
    const q = Math.max(0, Math.min(it.units, (shop.basket[key] || 0) + delta));
    if (q) shop.basket[key] = q; else delete shop.basket[key];
    if (delta > 0) { toast(`Added ${it.name} 🧺`); const bc = $('basketCount'); bc.classList.remove('bump'); void bc.offsetWidth; bc.classList.add('bump'); }
    renderShop();
    if (!$('quickView').hidden) openQV(key);
  }
  function renderBasket() {
    const lines = Object.entries(shop.basket).map(([k, q]) => ({ it: shop.items.find(i => i.key === k), q })).filter(l => l.it);
    const count = lines.reduce((a, l) => a + l.q, 0);
    $('basketCount').textContent = count;
    if (!lines.length) { $('basketBody').innerHTML = '<div class="shop-empty" style="padding:30px"><div class="e">🧺</div><p>Your basket is empty.</p><p>Add a deal to start rescuing good food.</p></div>'; return; }
    const total = lines.reduce((a, l) => a + l.q * l.it.price, 0), saved = lines.reduce((a, l) => a + l.q * l.it.saving, 0);
    $('basketBody').innerHTML = lines.map(l => `<div class="bline"><div class="be cat-${CATSLUG[l.it.category]}">${EMOJI[l.it.id] || '🛒'}</div>
        <div><div class="bn">${esc(l.it.name)}</div><div class="bp">${l.q} × ${inr(l.it.price)} <s>${inr(l.it.basePrice)}</s></div></div>
        <div class="stepper" style="min-height:40px"><button data-bdec="${l.it.key}" aria-label="One less">−</button><span>${l.q}</span><button data-binc="${l.it.key}" aria-label="One more" ${l.q >= l.it.units ? 'disabled' : ''}>+</button></div></div>`).join('') +
      `<div class="btot"><div><span>Items</span><span>${count}</span></div><div class="saved"><span>You save</span><span>${inr(saved)}</span></div><div class="grand"><span>Total</span><span>${inr(total)}</span></div></div>
       <div class="rescued">🌱 You're giving ${count} near-date item${count === 1 ? '' : 's'} a home instead of the bin.</div>
       <button class="cat-chip" id="basketClear" style="margin-top:12px">Empty basket</button>
       <p class="demo-note2">Demo basket in this browser only: no checkout, orders or payments.</p>`;
    $('basketBody').querySelectorAll('[data-binc]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.binc, 1)));
    $('basketBody').querySelectorAll('[data-bdec]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.bdec, -1)));
    $('basketClear').addEventListener('click', () => { shop.basket = {}; renderShop(); });
  }
  function openQV(key) {
    const x = shop.items.find(i => i.key === key); if (!x) return;
    const inB = shop.basket[key] || 0;
    $('qvBody').innerHTML = `${pimg(x, true)}<div class="qvb"><button class="shop-icon close" id="qvClose" aria-label="Close">✕</button>
      <span class="pcat">${x.category}</span><h3>${esc(x.name)}</h3>
      <div class="pprice"><span class="now">${inr(x.price)}</span><span class="was">${inr(x.basePrice)}</span></div>
      <span class="psave">You save ${inr(x.saving)} (${Math.round(x.discount * 100)}% off)</span>
      <span class="pstock ${x.units <= 5 ? 'low' : ''}">${freshText(x.daysLeft)}${x.units <= 5 ? ` · only ${x.units} left` : ''}</span>
      <div class="why"><b>Why is it cheaper?</b> It's close to its best-before date but still good to eat. The store reduces it so it gets enjoyed instead of thrown away.</div>
      ${inB ? `<div class="stepper"><button data-qdec aria-label="One less">−</button><span>${inB} in basket</span><button data-qinc aria-label="One more" ${inB >= x.units ? 'disabled' : ''}>+</button></div>` : '<button class="add-btn" data-qinc>Add to basket</button>'}
    </div>`;
    $('quickView').hidden = false;
    $('qvClose').addEventListener('click', closeQV); $('qvClose').focus();
    const inc = $('qvBody').querySelector('[data-qinc]'), dec = $('qvBody').querySelector('[data-qdec]');
    if (inc) inc.addEventListener('click', () => changeQty(key, 1));
    if (dec) dec.addEventListener('click', () => changeQty(key, -1));
  }
  function closeQV() { $('quickView').hidden = true; }
  // ---------- light / dark mode ----------
  function effectiveTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeButtons() {
    const dark = effectiveTheme() === 'dark';
    ['themeBtn', 'shopTheme'].forEach(id => { const b = $(id); if (b) { b.textContent = dark ? '☀️' : '🌙'; b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode'); } });
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('mbw_theme', next); } catch (e) { /* storage blocked */ }
    syncThemeButtons();
    render(); // charts read their colours from CSS variables
  }
  function initTheme() {
    let t = null; try { t = localStorage.getItem('mbw_theme'); } catch (e) { t = null; }
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    syncThemeButtons();
    $('themeBtn').addEventListener('click', toggleTheme);
    $('shopTheme').addEventListener('click', toggleTheme);
    $('shopCredits').innerHTML = Object.entries(WEB).map(([id, p]) => { const pr = S.PRODUCTS.find(x => x.id === id);
      return `${esc(pr ? pr.name : id)}: <a href="${p.page}" target="_blank" rel="noopener">${esc(p.art)}</a>, ${esc(p.lic)}`; }).join(' · ') + ' (Wikimedia Commons).';
  }

  function bindShop() {
    $('shopSearch').addEventListener('input', (e) => { shop.q = e.target.value; renderShop(); });
    $('shopSort').addEventListener('change', (e) => { shop.sort = e.target.value; renderShop(); });
    $('shopDay').addEventListener('input', () => { $('dealDay').value = $('shopDay').value; $('todoDay').value = $('shopDay').value; renderDeals(); renderTodo(); renderShop(); });
    $('basketBtn').addEventListener('click', () => { $('basket').hidden = false; $('basketClose').focus(); });
    $('basketClose').addEventListener('click', () => { $('basket').hidden = true; });
    $('quickView').addEventListener('click', (e) => { if (e.target === $('quickView')) closeQV(); });
    $('shopSwitch').addEventListener('click', showLogin);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeQV(); $('basket').hidden = true; } });
  }

  // ---------- static tables ----------
  function renderStatic() {
    $('assumeTable').innerHTML = '<tr><th>Assumption</th><th style="text-align:left">Value and justification</th></tr>' +
      S.ASSUMPTIONS.map(([k, v]) => `<tr><td>${k}</td><td class="left">${v}</td></tr>`).join('');
    $('masterTable').innerHTML = '<tr><th>Product</th><th>Category</th><th>Shelf life (d)</th><th>Unit cost</th><th>Base price</th><th>Avg demand / day</th><th>Price sensitivity</th><th>Delivery every</th></tr>' +
      S.PRODUCTS.map(p => `<tr><td>${p.name}</td><td class="left">${p.category}</td><td>${p.shelfLife}</td><td>${inr(p.unitCost)}</td><td>${inr(p.basePrice)}</td><td>${p.demand}</td><td>${p.sens}</td><td>${S.CATEGORIES[p.category].cadence} d</td></tr>`).join('');
  }

  // ---------- boot ----------
  initTheme(); bindControls(); bindShop(); renderStatic();
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
