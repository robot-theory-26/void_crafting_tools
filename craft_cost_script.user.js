// ==UserScript==
// @name         Void Idle - Crafting Cost Calculator
// @namespace    voididle-cost-calc
// @version      1.1
// @description  Scans market prices + recipes on voididle.com and generates a crafting cost/profit report in a new tab.
// @match        https://www.voididle.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @run-at       document-idle
// @homepageURL  https://github.com/robot-theory-26/void_crafting_tools
// @downloadURL  https://raw.githubusercontent.com/robot-theory-26/void_crafting_tools/main/craft_cost_script.user.js
// @updateURL    https://raw.githubusercontent.com/robot-theory-26/void_crafting_tools/main/craft_cost_script.user.js
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
  // The Marketplace screen uses four different UI layouts depending on
  // category, so scanning dispatches to a different strategy per rail:
  //   - Materials / Scrolls: fixed-price card grid
  //   - Trade Gear: player-run single-price auction listings
  //   - Runes: player-run per-unit rows
  //   - Potions / Jade Packs / Spirit Shards: two-sided order book
  // Weapons / Armor / Jewelry are skipped entirely (out of scope).
  // Each scanner mutates the passed-in `prices` object; callers handle
  // load/save.
  // ---------------------------------------------------------------------
  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  const SKILL_NAMES = ['Mining', 'Herbalism', 'Woodcutting', 'Alchemy', 'Enchanting', 'Engineering'];

  // Clicks a left-nav-drawer item by its exact button text (e.g. "Market",
  // one of SKILL_NAMES). Returns true if found and clicked.
  function clickNavDrawerItem(label) {
    const btns = Array.from(document.querySelectorAll('.nav-drawer-item'));
    const target = btns.find(b => b.textContent.trim() === label);
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }

  // Clicks a sub-tab (.ws-tab) by exact text within the currently active
  // skill screen (e.g. "Recipes"). Returns true if found and clicked.
  function clickSkillSubTab(label) {
    const tabs = Array.from(document.querySelectorAll('.ws-tab'));
    const target = tabs.find(t => t.textContent.trim() === label);
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }

  const SKIP_RAILS = ['Weapons', 'Armor', 'Jewelry'];
  const LISTING_RAILS = ['Trade Gear'];
  const RUNE_RAILS = ['Runes'];
  const ORDER_BOOK_RAILS = ['Potions', 'Jade Packs', 'Spirit Shards'];

  // Fixed-price card grid (Materials, Scrolls). Materials and Scrolls
  // share the same `.mp-mat-card-meta` class but use different name
  // classes, so the name element is found generically within the card.
  function scanCardStyle(prices) {
    const metas = Array.from(document.querySelectorAll('.mp-mat-card-meta'));
    let count = 0;

    metas.forEach(meta => {
      // meta's own class (mp-mat-card-meta) contains "card", so .closest()
      // would match meta itself rather than climbing to the card container —
      // name/meta/counts are siblings under one parent, so go there directly.
      const card = meta.parentElement;
      const nameEl = card ? card.querySelector('[class*="name"]') : null;
      const name = nameEl ? nameEl.textContent.trim() : null;
      if (!name) return;

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

    return count;
  }

  // Player-run single-price auction listings (Trade Gear). Groups
  // listings by item name and takes the cheapest as `buy`. Tier badge
  // (e.g. "T2") is captured as a separate field alongside the price,
  // not folded into the name.
  function scanListingStyle(prices) {
    const rows = Array.from(document.querySelectorAll('.mp-listing'));
    const cheapest = {}; // name -> { price, tier }

    rows.forEach(row => {
      const nameEl = row.querySelector('.mp-item-name');
      if (!nameEl) return;
      const tierEl = nameEl.querySelector('.mp-tier-badge');
      const tier = tierEl ? tierEl.textContent.trim() : null;
      const name = nameEl.textContent.replace(tier || '', '').trim();
      if (!name) return;

      const priceEl = row.querySelector('[class*="price"]');
      const price = priceEl ? parseGold(priceEl.textContent) : null;
      if (price === null) return;

      if (!cheapest[name] || price < cheapest[name].price) {
        cheapest[name] = { price, tier };
      }
    });

    let count = 0;
    Object.entries(cheapest).forEach(([name, { price, tier }]) => {
      prices[name] = { buy: price, sell: null, tier };
      count++;
    });
    return count;
  }

  // Player-run per-unit rows (Runes). Groups rows by name and takes the
  // cheapest per-unit ("/ea") price as `buy`.
  function scanRuneRowStyle(prices) {
    const rows = Array.from(document.querySelectorAll('.mp-rune-row'));
    const cheapest = {}; // name -> price

    rows.forEach(row => {
      const nameEl = row.querySelector('.mp-rune-row-name');
      const subEl = row.querySelector('.mp-rune-row-sub');
      if (!nameEl || !subEl) return;
      const name = nameEl.textContent.trim();
      if (!name) return;

      const match = subEl.textContent.match(/([\d,.]+)\s*\/\s*ea/i);
      if (!match) return;
      const price = parseGold(match[1]);
      if (price === null) return;

      if (cheapest[name] === undefined || price < cheapest[name]) {
        cheapest[name] = price;
      }
    });

    let count = 0;
    Object.entries(cheapest).forEach(([name, price]) => {
      prices[name] = { buy: price, sell: null };
      count++;
    });
    return count;
  }

  // Two-sided order book (Potions, Jade Packs, Spirit Shards). One item
  // per page/sublist: cheapest sell-side listing is the effective buy
  // price for the shopper, highest buy-side listing is the effective
  // sell price.
  function scanOrderBookStyle(prices, itemName) {
    if (!itemName) return 0;

    const sellPrices = Array.from(document.querySelectorAll('.mp-ob-sell .mp-ob-row .mp-ob-price'))
      .map(el => parseGold(el.textContent))
      .filter(p => p !== null);
    const buyPrices = Array.from(document.querySelectorAll('.mp-ob-buy .mp-ob-row .mp-ob-price'))
      .map(el => parseGold(el.textContent))
      .filter(p => p !== null);

    const buy = sellPrices.length ? Math.min(...sellPrices) : null;
    const sell = buyPrices.length ? Math.max(...buyPrices) : null;

    if (buy === null && sell === null) return 0;
    prices[itemName] = { buy, sell };
    return 1;
  }

  function orderBookItemName(railTitle, subName) {
    if (subName) return subName;
    const titleEl = document.querySelector('.mp-main-title');
    if (!titleEl) return null;
    // Strip a leading emoji/icon prefix, e.g. "🧪 Health Potion" -> "Health Potion"
    return titleEl.textContent.replace(/^[^\w]+/, '').trim();
  }

  // Clicks through every top-level rail category, then every sublist
  // item within it (if any), scanning the rendered market with the
  // strategy appropriate to that category.
  async function scanAllMarkets(progressCb) {
    const prices = loadPrices();
    let totalFound = 0;

    if (!document.querySelector('.mp-rail-btn')) {
      clickNavDrawerItem('Market');
      await sleep(300);
    }

    const railBtns = Array.from(document.querySelectorAll('.mp-rail-btn'))
      .filter(b => !b.classList.contains('mp-rail-search-btn'));

    if (railBtns.length === 0) {
      return { found: 0, warning: 'No .mp-rail-btn elements found. Are you on the Market/Browse screen?' };
    }

    for (const railBtn of railBtns) {
      const railTitle = railBtn.getAttribute('title') || 'Unknown category';
      if (SKIP_RAILS.includes(railTitle)) continue;

      railBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(220);

      const scanPage = (subName) => {
        if (LISTING_RAILS.includes(railTitle)) return scanListingStyle(prices);
        if (RUNE_RAILS.includes(railTitle)) return scanRuneRowStyle(prices);
        if (ORDER_BOOK_RAILS.includes(railTitle)) return scanOrderBookStyle(prices, orderBookItemName(railTitle, subName));
        return scanCardStyle(prices);
      };

      const sublistBtns = Array.from(document.querySelectorAll('.mp-sublist-btn'));

      if (sublistBtns.length > 0) {
        for (const subBtn of sublistBtns) {
          const labelEl = subBtn.querySelector('.mp-sublist-label');
          const subName = labelEl ? labelEl.textContent.trim() : '';
          subBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await sleep(220);

          const found = scanPage(subName);
          totalFound += found;
          if (progressCb) progressCb(`${railTitle} / ${subName}`, totalFound);
        }
      } else {
        const found = scanPage(null);
        totalFound += found;
        if (progressCb) progressCb(railTitle, totalFound);
      }
    }

    savePrices(prices);
    return { found: totalFound, warning: null };
  }

  // ---------------------------------------------------------------------
  // RECIPE SCAN
  // Clicks each .cv-recipe-card, waits for the detail panel to update,
  // then reads .cv-detail-mats (fixed + tiered ingredients).
  // ---------------------------------------------------------------------
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

  // Scans every .cv-recipe-card currently rendered (i.e. whatever skill's
  // Recipes tab is active) into `recipes`. Returns { count, warning }.
  async function scanCurrentRecipePage(recipes, skillName, progressCb) {
    const cards = Array.from(document.querySelectorAll('.cv-recipe-card'));
    let count = 0;
    let lastWarning = null;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const nameEl = card.querySelector('.cv-recipe-card-name');
      const name = nameEl ? nameEl.textContent.trim() : null;
      if (!name) continue;

      if (card.classList.contains('locked')) {
        // Locked cards don't respond to clicks — the detail panel stays on
        // whatever was last selected, so reading it here would silently
        // attribute the wrong recipe's ingredients to this locked item.
        const lockEl = card.querySelector('.cv-recipe-card-lock');
        recipes[name] = {
          locked: true,
          level: lockEl ? parseGold(lockEl.textContent) : null,
          xp: null,
          time: null,
          ingredients: [],
        };
        count++;
        if (progressCb) progressCb(`${skillName} — ${name} (locked)`, i + 1, cards.length);
        continue;
      }

      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(150); // let the detail panel re-render

      const lvlEl = card.querySelector('.cv-recipe-card-lvl');
      const xpEl = card.querySelector('.cv-recipe-card-xp');
      const timeEl = card.querySelector('.cv-recipe-card-time');

      const { ingredients, warning } = readCurrentDetail(name);
      if (warning) lastWarning = `[${name}] ${warning}`;

      recipes[name] = {
        locked: false,
        level: lvlEl ? parseGold(lvlEl.textContent) : null,
        xp: xpEl ? parseGold(xpEl.textContent) : null,
        time: timeEl ? parseGold(timeEl.textContent) : null,
        ingredients,
      };
      count++;
      if (progressCb) progressCb(`${skillName} — ${name}`, i + 1, cards.length);
    }

    return { count, warning: lastWarning };
  }

  // Clicks through every Skill (Mining, Herbalism, Woodcutting, Alchemy,
  // Enchanting, Engineering) — each has its own independent Recipes tab —
  // and scans all recipe cards found there into a single merged store.
  async function scanRecipes(progressCb) {
    const recipes = loadRecipes();
    let count = 0;
    let lastWarning = null;
    let anySkillFound = false;

    for (const skillName of SKILL_NAMES) {
      if (!clickNavDrawerItem(skillName)) continue;
      await sleep(250);
      clickSkillSubTab('Recipes');
      await sleep(250);

      const cards = document.querySelectorAll('.cv-recipe-card');
      if (cards.length === 0) continue;
      anySkillFound = true;

      const { count: found, warning } = await scanCurrentRecipePage(recipes, skillName, progressCb);
      count += found;
      if (warning) lastWarning = warning;
    }

    if (!anySkillFound) {
      return { found: 0, warning: 'No .cv-recipe-card elements found on any Skill screen. Is the nav drawer visible?' };
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
    <label><input type="checkbox" id="hideLocked" checked> Hide not-yet-unlocked recipes</label>
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
let hideLocked = true;
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
  const entries = Object.entries(DATA.recipes).filter(([, r]) => !hideLocked || !r.locked);
  const rows = entries.map(([name, r]) => computeRow(name, r));
  document.getElementById('subtitle').textContent =
    \`\${entries.length} of \${Object.keys(DATA.recipes).length} recipes · \${Object.keys(DATA.prices).length} market prices known\`;

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
document.getElementById('hideLocked').addEventListener('change', e => {
  hideLocked = e.target.checked;
  render();
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

    makeBtn('📦 Scan Market', async () => {
      status.textContent = 'Scanning market... do not click anything.';
      const res = await scanAllMarkets((where, total) => {
        status.textContent = `Scanning ${where}... (${total} items so far)`;
      });
      status.textContent = res.warning ? res.warning : `Scanned ${res.found} market items across all categories.`;
    });

    makeBtn('🧪 Scan Recipes', async () => {
      status.textContent = 'Scanning... do not click anything.';
      const res = await scanRecipes((where, i, total) => {
        status.textContent = `Scanning ${where} (${i}/${total})`;
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
