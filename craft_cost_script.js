// ==UserScript==
// @name         Void Idle - Crafting Cost Calculator
// @namespace    voididle-cost-calc
// @version      1.0
// @description  Scans market prices + recipes on voididle.com and generates a crafting cost/profit report in a new tab.
// @match        https://www.voididle.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // STORAGE
  // ---------------------------------------------------------------------
  const PRICES_KEY = 'vic_prices_v1';   // { "Item Name": { buy: number, sell: number } }
  const RECIPES_KEY = 'vic_recipes_v1'; // { "Item Name": { level, xp, time, ingredients: [...] } }

  function loadPrices() { return GM_getValue(PRICES_KEY, {}); }
  function savePrices(p) { GM_setValue(PRICES_KEY, p); }
  function loadRecipes() { return GM_getValue(RECIPES_KEY, {}); }
  function saveRecipes(r) { GM_setValue(RECIPES_KEY, r); }

  function parseGold(text) {
    if (!text) return null;
    const m = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  // ---------------------------------------------------------------------
  // MARKET SCAN
  // Pairs .mp-mat-card-name with .mp-mat-card-meta by index (they render
  // as a flat list of sibling pairs per card in the market grid).
  // ---------------------------------------------------------------------
  function scanMarket() {
    const names = Array.from(document.querySelectorAll('.mp-mat-card-name'));
    const metas = Array.from(document.querySelectorAll('.mp-mat-card-meta'));

    if (names.length === 0) {
      return { found: 0, warning: 'No .mp-mat-card-name elements found on this page. Are you on the Market screen?' };
    }
    if (names.length !== metas.length) {
      console.warn('[VoidIdle Cost Calc] name/meta count mismatch', names.length, metas.length);
    }

    const prices = loadPrices();
    let count = 0;

    names.forEach((nameEl, i) => {
      const name = nameEl.textContent.trim();
      const meta = metas[i];
      if (!name || !meta) return;

      let sell = null, buy = null;
      meta.querySelectorAll('span').forEach(span => {
        const txt = span.textContent;
        if (/sell/i.test(txt)) sell = parseGold(txt);
        if (/buy/i.test(txt)) buy = parseGold(txt);
      });

      if (sell !== null || buy !== null) {
        prices[name] = { sell, buy };
        count++;
      }
    });

    savePrices(prices);
    return { found: count, warning: null };
  }

  // ---------------------------------------------------------------------
  // RECIPE SCAN
  // Clicks each .cv-recipe-card, waits for the detail panel to update,
  // then reads .cv-detail-mats (fixed + tiered ingredients).
  // ---------------------------------------------------------------------
  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  function readCurrentDetail(name) {
    const container = document.querySelector('.cv-detail-mats');
    const ingredients = [];
    let warning = null;

    if (!container) {
      return { ingredients, warning: 'No .cv-detail-mats found after selecting this recipe.' };
    }

    Array.from(container.children).forEach(child => {
      const select = child.querySelector('select.cv-mat-select');
      const nameEl = child.querySelector('.cv-detail-mat-name');
      const qtyEl = child.querySelector('.cv-detail-mat-qty');

      if (select) {
        // Tiered / substitutable ingredient
        const label = nameEl ? nameEl.textContent.trim() : 'Unknown tier slot';
        const options = Array.from(select.querySelectorAll('option'))
          .filter(o => o.value) // skip the "Auto" placeholder
          .map(o => {
            const txt = o.textContent;
            const haveMatch = txt.match(/have\s+(\d+)/i);
            return {
              value: o.value,
              label: txt.replace(/\s*\(.*?\)\s*$/, '').trim(),
              have: haveMatch ? parseInt(haveMatch[1], 10) : 0,
              disabled: o.disabled,
            };
          });
        let qty = qtyEl ? parseGold(qtyEl.textContent.split('/').pop()) : null;
        if (qty === null) warning = 'Could not auto-detect quantity needed for tiered slot "' + label + '" — set it manually in the report.';
        ingredients.push({ tiered: true, label, qty, options });
      } else if (nameEl) {
        // Fixed ingredient — qty text format is usually "have / needed"
        const iname = nameEl.textContent.trim();
        let qty = null;
        if (qtyEl) {
          const parts = qtyEl.textContent.split('/');
          qty = parts.length > 1 ? parseGold(parts[1]) : parseGold(parts[0]);
        }
        if (qty === null) warning = 'Could not parse quantity for ingredient "' + iname + '".';
        ingredients.push({ tiered: false, name: iname, qty });
      }
    });

    return { ingredients, warning };
  }

  async function scanRecipes(progressCb) {
    const cards = Array.from(document.querySelectorAll('.cv-recipe-card'));
    if (cards.length === 0) {
      return { found: 0, warning: 'No .cv-recipe-card elements found. Are you on the Crafting screen?' };
    }

    const recipes = loadRecipes();
    let count = 0;
    let lastWarning = null;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const nameEl = card.querySelector('.cv-recipe-card-name');
      const name = nameEl ? nameEl.textContent.trim() : null;
      if (!name) continue;

      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(150); // let the detail panel re-render

      const lvlEl = card.querySelector('.cv-recipe-card-lvl');
      const xpEl = card.querySelector('.cv-recipe-card-xp');
      const timeEl = card.querySelector('.cv-recipe-card-time');

      const { ingredients, warning } = readCurrentDetail(name);
      if (warning) lastWarning = `[${name}] ${warning}`;

      recipes[name] = {
        level: lvlEl ? parseGold(lvlEl.textContent) : null,
        xp: xpEl ? parseGold(xpEl.textContent) : null,
        time: timeEl ? parseGold(timeEl.textContent) : null,
        ingredients,
      };
      count++;
      if (progressCb) progressCb(i + 1, cards.length, name);
    }

    saveRecipes(recipes);
    return { found: count, warning: lastWarning };
  }

  // ---------------------------------------------------------------------
  // REPORT (opens in a new tab as a self-contained HTML page)
  // ---------------------------------------------------------------------
  function buildReportHtml(prices, recipes) {
    const data = { prices, recipes };
    const json = JSON.stringify(data).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Void Idle — Crafting Cost Report</title>
<style>
  :root {
    --bg: #0D1219;
    --panel: #161C27;
    --panel2: #1E2530;
    --border: #2A3240;
    --text: #E8EAF0;
    --muted: #8A93A6;
    --accent: #A78BFA;
    --accent2: #4FD1C5;
    --profit: #4FD1C5;
    --loss: #F27C7C;
    --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 32px 24px 80px;
  }
  h1 {
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.01em;
    margin: 0 0 4px;
  }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .controls {
    display: flex;
    gap: 16px;
    align-items: center;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .controls label { font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
  select, input[type=text] {
    background: var(--panel2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 13px;
    font-family: inherit;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 550;
    font-size: 12px;
    text-transform: none;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  th:hover { color: var(--text); }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  tr:hover td { background: var(--panel); }
  .num { font-family: var(--mono); text-align: right; white-space: nowrap; }
  .item-name { font-weight: 600; }
  .ingredients { color: var(--muted); font-size: 12.5px; line-height: 1.6; }
  .ingredients .missing { color: var(--loss); }
  .profit-pos { color: var(--profit); font-weight: 600; }
  .profit-neg { color: var(--loss); font-weight: 600; }
  .tier-select {
    background: var(--panel2);
    border: 1px solid var(--border);
    color: var(--accent2);
    border-radius: 4px;
    font-size: 12px;
    padding: 1px 4px;
    margin-left: 4px;
  }
  .qty-fix {
    width: 44px;
    background: var(--panel2);
    border: 1px solid var(--loss);
    color: var(--text);
    border-radius: 4px;
    font-size: 12px;
    padding: 1px 4px;
    margin-left: 4px;
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--panel2);
    color: var(--muted);
    margin-left: 6px;
  }
  .empty { color: var(--muted); padding: 40px 0; text-align: center; }
</style>
</head>
<body>
  <h1>Crafting Cost Report</h1>
  <div class="sub" id="subtitle"></div>

  <div class="controls">
    <label><input type="radio" name="pricemode" value="buy" checked> Cost ingredients at Buy price</label>
    <label><input type="radio" name="pricemode" value="sell"> Cost ingredients at Sell price (opportunity cost)</label>
  </div>

  <table id="report">
    <thead>
      <tr>
        <th data-key="name">Item</th>
        <th>Ingredients</th>
        <th data-key="cost" class="num">Cost</th>
        <th data-key="sell" class="num">Sells For</th>
        <th data-key="profit" class="num">Profit</th>
        <th data-key="time" class="num">Craft Time</th>
        <th data-key="pps" class="num">Profit / sec</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="emptyMsg" style="display:none">No recipe data yet. Go back to the game, use "Scan Recipes", then reopen this report.</div>

<script>
const DATA = ${json};
let priceMode = 'buy';
let sortKey = 'profit';
let sortDir = -1;
const tierChoice = {}; // recipeName -> { slotIndex: optionValue }
const qtyOverride = {}; // recipeName -> { slotIndex: number }

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function priceFor(name) {
  const p = DATA.prices[name];
  if (!p) return null;
  return priceMode === 'buy' ? p.buy : p.sell;
}

function computeRow(recipeName, recipe) {
  let cost = 0;
  let missing = [];
  const ingredientBits = [];

  recipe.ingredients.forEach((ing, idx) => {
    if (ing.tiered) {
      const chosenVal = (tierChoice[recipeName] && tierChoice[recipeName][idx]) ||
        (ing.options.find(o => !o.disabled) || ing.options[0] || {}).value;
      const opt = ing.options.find(o => o.value === chosenVal) || ing.options[0];
      const qty = (qtyOverride[recipeName] && qtyOverride[recipeName][idx] != null)
        ? qtyOverride[recipeName][idx] : ing.qty;
      const unitPrice = opt ? priceFor(opt.label) : null;
      if (unitPrice == null || qty == null) missing.push(opt ? opt.label : ing.label);
      else cost += unitPrice * qty;

      const optsHtml = ing.options.map(o =>
        \`<option value="\${o.value}" \${o.disabled ? 'disabled' : ''} \${o.value===chosenVal?'selected':''}>\${o.label}</option>\`
      ).join('');
      const qtyHtml = ing.qty == null
        ? \`<input class="qty-fix" type="text" placeholder="qty?" data-recipe="\${recipeName}" data-idx="\${idx}" data-kind="qty">\`
        : '';
      ingredientBits.push(
        \`<span>\${qty ?? '?'}× <select class="tier-select" data-recipe="\${recipeName}" data-idx="\${idx}" data-kind="tier">\${optsHtml}</select>\${qtyHtml}</span>\`
      );
    } else {
      const unitPrice = priceFor(ing.name);
      if (unitPrice == null || ing.qty == null) missing.push(ing.name);
      else cost += unitPrice * ing.qty;
      ingredientBits.push(\`<span>\${ing.qty ?? '?'}× \${ing.name}\${unitPrice==null?' <span class="missing">(no price)</span>':''}</span>\`);
    }
  });

  const sell = priceFor(recipeName);
  const hasMissing = missing.length > 0;
  const profit = (!hasMissing && sell != null) ? sell - cost : null;
  const pps = (profit != null && recipe.time) ? profit / recipe.time : null;

  return {
    name: recipeName,
    ingredientsHtml: ingredientBits.join(', '),
    cost: hasMissing ? null : cost,
    sell,
    profit,
    time: recipe.time,
    pps,
  };
}

function render() {
  const rows = Object.entries(DATA.recipes).map(([name, r]) => computeRow(name, r));
  document.getElementById('subtitle').textContent =
    \`\${Object.keys(DATA.recipes).length} recipes · \${Object.keys(DATA.prices).length} market prices known\`;

  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  const tbody = document.getElementById('rows');
  const emptyMsg = document.getElementById('emptyMsg');
  if (rows.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  tbody.innerHTML = rows.map(r => \`
    <tr>
      <td class="item-name">\${r.name}</td>
      <td class="ingredients">\${r.ingredientsHtml}</td>
      <td class="num">\${fmt(r.cost)}</td>
      <td class="num">\${fmt(r.sell)}</td>
      <td class="num \${r.profit>0?'profit-pos':(r.profit<0?'profit-neg':'')}">\${fmt(r.profit)}</td>
      <td class="num">\${fmt(r.time)}\${r.time?'s':''}</td>
      <td class="num \${r.pps>0?'profit-pos':(r.pps<0?'profit-neg':'')}">\${fmt(r.pps)}</td>
    </tr>
  \`).join('');

  tbody.querySelectorAll('[data-kind="tier"]').forEach(sel => {
    sel.addEventListener('change', e => {
      const { recipe, idx } = e.target.dataset;
      tierChoice[recipe] = tierChoice[recipe] || {};
      tierChoice[recipe][idx] = e.target.value;
      render();
    });
  });
  tbody.querySelectorAll('[data-kind="qty"]').forEach(inp => {
    inp.addEventListener('change', e => {
      const { recipe, idx } = e.target.dataset;
      qtyOverride[recipe] = qtyOverride[recipe] || {};
      qtyOverride[recipe][idx] = parseFloat(e.target.value) || 0;
      render();
    });
  });
}

document.querySelectorAll('input[name=pricemode]').forEach(r => {
  r.addEventListener('change', e => { priceMode = e.target.value; render(); });
});
document.querySelectorAll('th[data-key]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = -1; }
    render();
  });
});

render();
</script>
</body>
</html>`;
  }

  function openReport() {
    const html = buildReportHtml(loadPrices(), loadRecipes());
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    GM_openInTab(url, { active: true });
  }

  // ---------------------------------------------------------------------
  // FLOATING UI
  // ---------------------------------------------------------------------
  function injectPanel() {
    if (document.getElementById('vic-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'vic-panel';
    panel.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      background: #161C27; border: 1px solid #2A3240; border-radius: 10px;
      padding: 10px; display: flex; flex-direction: column; gap: 6px;
      font-family: -apple-system, sans-serif; font-size: 12.5px; color: #E8EAF0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4); min-width: 190px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Cost Calculator';
    title.style.cssText = 'font-weight:600; margin-bottom:2px; color:#A78BFA;';
    panel.appendChild(title);

    const status = document.createElement('div');
    status.id = 'vic-status';
    status.style.cssText = 'color:#8A93A6; min-height:14px; font-size:11.5px;';
    panel.appendChild(status);

    function makeBtn(label, onClick) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `
        background: #1E2530; border: 1px solid #2A3240; color: #E8EAF0;
        border-radius: 6px; padding: 6px 8px; cursor: pointer; font-size: 12.5px;
        font-family: inherit;
      `;
      b.onmouseenter = () => b.style.borderColor = '#A78BFA';
      b.onmouseleave = () => b.style.borderColor = '#2A3240';
      b.onclick = onClick;
      panel.appendChild(b);
      return b;
    }

    makeBtn('📦 Scan Market', () => {
      const res = scanMarket();
      status.textContent = res.warning ? res.warning : `Scanned ${res.found} market items.`;
    });

    makeBtn('🧪 Scan Recipes', async () => {
      status.textContent = 'Scanning... do not click anything.';
      const res = await scanRecipes((i, total, name) => {
        status.textContent = `Scanning ${i}/${total}: ${name}`;
      });
      status.textContent = res.warning ? `Done, but: ${res.warning}` : `Scanned ${res.found} recipes.`;
    });

    makeBtn('📊 View Cost Report', () => openReport());

    document.body.appendChild(panel);
  }

  const ready = setInterval(() => {
    if (document.body) {
      injectPanel();
      clearInterval(ready);
    }
  }, 500);
})();