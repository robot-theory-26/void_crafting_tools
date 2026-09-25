// ==UserScript==
// @name         Void Idle - Crafting Cost Calculator
// @namespace    voididle-cost-calc
// @version      2.0
// @description  Scans market prices + recipes on voididle.com and publishes a crafting cost/profit and material buy/sell report to a Google Sheet via SteinHQ.
// @match        https://www.voididle.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.steinhq.com
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
  const STEIN_CONFIG_KEY = 'vic_stein_config_v1'; // { storageId, username, password }

  function loadPrices() { return GM_getValue(PRICES_KEY, {}); }
  function savePrices(p) { GM_setValue(PRICES_KEY, p); }
  function loadRecipes() { return GM_getValue(RECIPES_KEY, {}); }
  function saveRecipes(r) { GM_setValue(RECIPES_KEY, r); }

  function loadSteinConfig() { return GM_getValue(STEIN_CONFIG_KEY, null); }
  function saveSteinConfig(cfg) { GM_setValue(STEIN_CONFIG_KEY, cfg); }

  // Prompts for Stein storage ID + Basic Auth credentials and saves them
  // via GM_setValue. Never hardcode these into the script source — this
  // script is auto-published to a public GitHub repo, and anyone reading
  // it would otherwise be able to write to the connected sheet.
  function promptForSteinConfig() {
    const existing = loadSteinConfig();
    const storageId = prompt(
      'Stein storage ID (from your Stein API dashboard URL, e.g. the\n' +
      'part after /storages/ in https://api.steinhq.com/v1/storages/<id>):',
      existing ? existing.storageId : ''
    );
    if (!storageId) return null;
    const username = prompt('Stein Basic Auth username:', existing ? existing.username : '');
    if (!username) return null;
    const password = prompt('Stein Basic Auth password:', existing ? existing.password : '');
    if (!password) return null;

    const cfg = { storageId: storageId.trim(), username: username.trim(), password: password.trim() };
    saveSteinConfig(cfg);
    return cfg;
  }

  function steinRequest(cfg, sheetName, method, body) {
    return new Promise((resolve, reject) => {
      const url = `https://api.steinhq.com/v1/storages/${cfg.storageId}/${encodeURIComponent(sheetName)}`;
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + btoa(`${cfg.username}:${cfg.password}`),
        },
        data: body !== undefined ? JSON.stringify(body) : undefined,
        onload: res => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText || '{}')); }
            catch (e) { resolve({}); }
          } else {
            reject(new Error(`Stein ${method} "${sheetName}" failed: ${res.status} ${res.responseText}`));
          }
        },
        onerror: () => reject(new Error(`Stein ${method} "${sheetName}" network error`)),
      });
    });
  }

  // Full clear-then-write: DELETE with an empty condition removes every
  // existing data row (verified live: {"condition": {}} clears the whole
  // sheet and leaves the header row untouched), then POST writes the
  // fresh dataset. No incremental diffing — matches the old report's
  // "regenerate from scratch" semantics.
  async function replaceSheet(cfg, sheetName, rows) {
    await steinRequest(cfg, sheetName, 'DELETE', { condition: {} });
    if (rows.length) await steinRequest(cfg, sheetName, 'POST', rows);
  }

  async function publishToSheet(status) {
    let cfg = loadSteinConfig();
    if (!cfg) {
      status.textContent = 'No Sheet Settings saved yet — opening setup...';
      cfg = promptForSteinConfig();
      if (!cfg) {
        status.textContent = 'Publish cancelled — Sheet Settings required.';
        return;
      }
    }

    const prices = loadPrices();
    const recipes = loadRecipes();
    const recipeRows = buildRecipeCostRows(recipes, prices);
    const buyRows = buildBuyOrderRows(prices);
    const sellRows = buildSellListingRows(prices);

    try {
      status.textContent = 'Publishing Recipe Costs...';
      await replaceSheet(cfg, 'Recipe Costs', recipeRows);
      status.textContent = 'Publishing Raw Material Buy Orders...';
      await replaceSheet(cfg, 'Raw Material Buy Orders', buyRows);
      status.textContent = 'Publishing Raw Material Sell Listings...';
      await replaceSheet(cfg, 'Raw Material Sell Listings', sellRows);
      status.textContent =
        `Published ${recipeRows.length} recipes, ${buyRows.length} buy orders, ${sellRows.length} sell listings.`;
    } catch (e) {
      status.textContent = 'Publish failed: ' + e.message;
    }
  }

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
  function waitForRender(root = document.body, { timeout = 1500, quietMs = 60 } = {}) {
    return new Promise(resolve => {
      let settled = false;
      let quietTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        obs.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        resolve();
      };
      const obs = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      obs.observe(root, { childList: true, subtree: true, characterData: true });
      const hardTimer = setTimeout(finish, timeout);
    });
  }

  const SKILL_NAMES = ['Mining', 'Herbalism', 'Woodcutting', 'Alchemy', 'Enchanting', 'Engineering', 'Runeworking'];

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
  // Fixed-price summary card grid (Materials, Scrolls), now followed by a
  // per-item drill-in into that item's order book to capture buyer/seller
  // identity — the summary card alone only has a representative price, no
  // name (verified live: clicking a card opens `.mp-orderbook` with
  // `.mp-ob-sell`/`.mp-ob-buy` columns of named listings). `backBtn` is the
  // sublist button (or rail button, if the rail has no sublists) already
  // in scope in the caller — re-clicking it is the only reliable way back
  // to the card grid: the `.mp-mobile-back` button in the detail view is
  // mobile-only and isn't visible/clickable in a normal desktop viewport.
  async function scanCardStyle(prices, backBtn) {
    const metas = Array.from(document.querySelectorAll('.mp-mat-card-meta'));
    const names = [];
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
        names.push(name);
        count++;
      }
    });

    for (const name of names) {
      const cardBtn = Array.from(document.querySelectorAll('.mp-mat-card')).find(
        c => c.querySelector('[class*="name"]')?.textContent.trim() === name
      );
      if (!cardBtn) continue;

      cardBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitForRender();

      const orderbook = document.querySelector('.mp-orderbook');
      if (orderbook) {
        const parseRow = row => {
          const priceEl = row.querySelector('.mp-ob-price');
          const metaEl = row.querySelector('.mp-ob-meta');
          const price = priceEl ? parseGold(priceEl.textContent) : null;
          const metaMatch = metaEl ? metaEl.textContent.match(/([\d,.]+)\s*×\s*·\s*(.+)/) : null;
          const qty = metaMatch ? parseGold(metaMatch[1]) : null;
          const who = metaMatch ? metaMatch[2].trim() : null;
          return { price, qty, name: who };
        };

        const sellEntries = Array.from(orderbook.querySelectorAll('.mp-ob-sell .mp-ob-row'))
          .map(parseRow).filter(e => e.price !== null);
        const buyEntries = Array.from(orderbook.querySelectorAll('.mp-ob-buy .mp-ob-row'))
          .map(parseRow).filter(e => e.price !== null);

        if (sellEntries.length) {
          prices[name].lowestSell = sellEntries.reduce((a, b) => (b.price < a.price ? b : a));
        }
        if (buyEntries.length) {
          prices[name].highestBuy = buyEntries.reduce((a, b) => (b.price > a.price ? b : a));
        }
      }
      // else: drill-in view didn't open for this item — keep the summary-only
      // sell/buy price already stored above and move on.

      if (backBtn) {
        backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitForRender();
      }
    }

    return count;
  }

  // Player-run single-price auction listings (Trade Gear). Groups
  // listings by item name and takes the cheapest as `buy`. Tier badge
  // (e.g. "T2") is captured as a separate field alongside the price,
  // not folded into the name.
  function scanListingStyle(prices) {
    const rows = Array.from(document.querySelectorAll('.mp-listing'));
    const cheapest = {}; // name -> { price, tier, seller }

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

      const sellerEl = row.querySelector('.mp-seller');
      const seller = sellerEl ? sellerEl.textContent.trim() : null;

      if (!cheapest[name] || price < cheapest[name].price) {
        cheapest[name] = { price, tier, seller };
      }
    });

    let count = 0;
    Object.entries(cheapest).forEach(([name, { price, tier, seller }]) => {
      prices[name] = {
        buy: price,
        sell: null,
        tier,
        lowestSell: { price, qty: 1, name: seller },
      };
      count++;
    });
    return count;
  }

  // Player-run per-unit rows (Runes). Groups rows by name and takes the
  // cheapest per-unit ("/ea") price as `buy`.
  function scanRuneRowStyle(prices) {
    const rows = Array.from(document.querySelectorAll('.mp-rune-row'));
    const cheapest = {}; // name -> { price, qty, seller }

    rows.forEach(row => {
      const nameEl = row.querySelector('.mp-rune-row-name');
      const subEl = row.querySelector('.mp-rune-row-sub');
      if (!nameEl || !subEl) return;
      const name = nameEl.textContent.trim();
      if (!name) return;

      // Format: "<seller> · <qty> avail · <price>/ea"
      const match = subEl.textContent.match(/(.+?)\s*·\s*([\d,.]+)\s*avail\s*·\s*([\d,.]+)\s*\/\s*ea/i);
      if (!match) return;
      const seller = match[1].trim();
      const qty = parseGold(match[2]);
      const price = parseGold(match[3]);
      if (price === null) return;

      if (cheapest[name] === undefined || price < cheapest[name].price) {
        cheapest[name] = { price, qty, seller };
      }
    });

    let count = 0;
    Object.entries(cheapest).forEach(([name, { price, qty, seller }]) => {
      prices[name] = { buy: price, sell: null, lowestSell: { price, qty, name: seller } };
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
      await waitForRender();
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
      await waitForRender();

      const scanPage = (subName, backBtn) => {
        if (LISTING_RAILS.includes(railTitle)) return scanListingStyle(prices);
        if (RUNE_RAILS.includes(railTitle)) return scanRuneRowStyle(prices);
        if (ORDER_BOOK_RAILS.includes(railTitle)) return scanOrderBookStyle(prices, orderBookItemName(railTitle, subName));
        return scanCardStyle(prices, backBtn);
      };

      const sublistBtns = Array.from(document.querySelectorAll('.mp-sublist-btn'));

      if (sublistBtns.length > 0) {
        for (const subBtn of sublistBtns) {
          const labelEl = subBtn.querySelector('.mp-sublist-label');
          const subName = labelEl ? labelEl.textContent.trim() : '';
          subBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await waitForRender();

          const found = await scanPage(subName, subBtn);
          totalFound += found;
          if (progressCb) progressCb(`${railTitle} / ${subName}`, totalFound);
        }
      } else {
        const found = await scanPage(null, railBtn);
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
      await waitForRender();

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
      await waitForRender();
      clickSkillSubTab('Recipes');
      await waitForRender();

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
  // ROW BUILDERS (turn stored prices/recipes into the exact row shapes
  // each Google Sheet tab needs)
  // ---------------------------------------------------------------------

  // Always prices ingredients (and the recipe's own market value) at
  // `.buy` — the original report's default "Cost ingredients at Buy
  // price" mode, preserved as the only mode since there's no interactive
  // toggle here. A tiered slot defaults to its first non-disabled option;
  // an ingredient with unknown quantity counts as missing (no UI to
  // supply an override in a non-interactive publish).
  function computeRecipeRow(recipeName, recipe, prices) {
    let cost = 0;
    const missing = [];
    const ingredientParts = [];

    recipe.ingredients.forEach(ing => {
      if (ing.tiered) {
        // Only a non-disabled option is usable — if every option is
        // disabled (player hasn't unlocked any substitute), this slot is
        // missing regardless of whether the disabled option happens to
        // have a known market price.
        const opt = ing.options.find(o => !o.disabled);
        const label = opt ? opt.label : (ing.options[0] ? ing.options[0].label : ing.label);
        const qty = ing.qty;
        const unitPrice = opt && prices[opt.label] ? prices[opt.label].buy : null;
        if (!opt || unitPrice == null || qty == null) missing.push(label);
        else cost += unitPrice * qty;
        ingredientParts.push(`${qty ?? '?'}x ${label}`);
      } else {
        const unitPrice = prices[ing.name] ? prices[ing.name].buy : null;
        if (unitPrice == null || ing.qty == null) missing.push(ing.name);
        else cost += unitPrice * ing.qty;
        ingredientParts.push(`${ing.qty ?? '?'}x ${ing.name}`);
      }
    });

    const sell = prices[recipeName] ? prices[recipeName].buy : null;
    const hasMissing = missing.length > 0;
    const finalCost = hasMissing ? null : cost;
    const profit = (!hasMissing && sell != null) ? sell - finalCost : null;
    const pps = (profit != null && recipe.time) ? profit / recipe.time : null;

    return {
      name: recipeName,
      ingredientsText: ingredientParts.join(', '),
      cost: finalCost,
      sell,
      profit,
      time: recipe.time,
      pps,
    };
  }

  function buildRecipeCostRows(recipes, prices) {
    return Object.entries(recipes)
      .filter(([, r]) => !r.locked)
      .map(([name, r]) => computeRecipeRow(name, r, prices))
      .map(row => ({
        'Item': row.name,
        'Ingredients': row.ingredientsText,
        'Cost': row.cost ?? '',
        'Sells For': row.sell ?? '',
        'Profit (est.)': row.profit ?? '',
        'Craft Time': row.time ?? '',
        'Profit/sec': row.pps ?? '',
        'Price Acquired': '',
        'Profit': '',
      }));
  }

  function buildBuyOrderRows(prices) {
    return Object.entries(prices)
      .filter(([, p]) => p.highestBuy && p.highestBuy.price != null)
      .map(([name, p]) => ({
        'Material': name,
        'Highest Buy Order': p.highestBuy.price,
        'Buyer': p.highestBuy.name || '',
        'Qty Available': p.highestBuy.qty ?? '',
      }))
      .sort((a, b) => b['Highest Buy Order'] - a['Highest Buy Order']);
  }

  function buildSellListingRows(prices) {
    return Object.entries(prices)
      .filter(([, p]) => p.lowestSell && p.lowestSell.price != null)
      .map(([name, p]) => ({
        'Material': name,
        'Lowest Sell Price': p.lowestSell.price,
        'Seller': p.lowestSell.name || '',
        'Qty Available': p.lowestSell.qty ?? '',
      }))
      .sort((a, b) => a['Lowest Sell Price'] - b['Lowest Sell Price']);
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

    makeBtn('⚙️ Sheet Settings', () => {
      const cfg = promptForSteinConfig();
      status.textContent = cfg ? 'Sheet Settings saved.' : 'Sheet Settings unchanged.';
    });

    makeBtn('📤 Publish to Sheet', () => publishToSheet(status));

    document.body.appendChild(panel);
  }

  const ready = setInterval(() => {
    if (document.body) {
      injectPanel();
      clearInterval(ready);
    }
  }, 500);
})();
