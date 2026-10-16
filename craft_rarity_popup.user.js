// ==UserScript==
// @name         Void Idle - Craft Rarity Popup
// @namespace    voididle-craft-rarity-popup
// @version      1.1
// @description  Pops up the rarity, quality and stats of each tool you craft, and records each craft with its context (level, bonuses, material choices) for later analysis. Read-only — watches requests/responses the game already makes and never sends requests of its own.
// @match        https://www.voididle.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @homepageURL  https://github.com/robot-theory-26/void_crafting_tools
// @downloadURL  https://raw.githubusercontent.com/robot-theory-26/void_crafting_tools/main/craft_rarity_popup.user.js
// @updateURL    https://raw.githubusercontent.com/robot-theory-26/void_crafting_tools/main/craft_rarity_popup.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // CONFIG
  // Tool slots come from the engineering recipes (result.type "trade_gear").
  // -----------------------------------------------------------------------
  const TOOL_TYPES = new Set([
    'gather_pickaxe', 'gather_sickle', 'gather_axe', 'gather_gloves', 'gather_pack',
    'craft_hammer', 'craft_flask', 'craft_tome',
  ]);

  const RARITY_COLORS = {
    common: '#B0B6C2',
    uncommon: '#4ADE80',
    rare: '#60A5FA',
    epic: '#A78BFA',
    legendary: '#FB923C',
    mythic: '#F43F5E',
  };

  const STAT_LABELS = {
    power: 'Power',
    gatherYield: 'Yield',
    gatherSpeed: 'Speed',
    gatherXp: 'XP',
    gatherDouble: 'Double',
    goldFind: 'Gold Find',
    soulEcho: 'Soul Echo',
    wandererEye: "Wanderer's Eye",
  };

  const SEEN_KEY = 'vcrp-seen';               // [itemId]
  const INIT_KEY = 'vcrp-initialized';        // {shop: true, inv: true}
  const HISTORY_KEY = 'vcrp-history';         // [craft record], see recordFor()
  const HISTORY_LIMIT = 20000;

  // Stored in Tampermonkey's storage rather than the game's localStorage, so a
  // large history can never crowd out the game's own data.
  function load(key, fallback) {
    try { return GM_getValue(key, fallback) ?? fallback; } catch (e) { return fallback; }
  }

  function save(key, value) {
    try { GM_setValue(key, value); } catch (e) { /* popup still works this session */ }
  }

  // v1.0 kept its data in the game's localStorage; move it over once.
  function migrateFromLocalStorage() {
    for (const key of [SEEN_KEY, INIT_KEY, HISTORY_KEY]) {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) continue;
        if (GM_getValue(key) === undefined) GM_setValue(key, JSON.parse(raw));
        localStorage.removeItem(key);
      } catch (e) { /* ignore */ }
    }
  }
  migrateFromLocalStorage();

  const seen = new Set(load(SEEN_KEY, []));
  const initialized = load(INIT_KEY, {});
  const history = load(HISTORY_KEY, []);

  // -----------------------------------------------------------------------
  // CRAFT CONTEXT
  // Latest known state, refreshed from traffic the game already produces and
  // attached to each craft when it's detected.
  // -----------------------------------------------------------------------
  const context = {
    engineeringLevel: null,
    engineeringXp: null,
    craftBonuses: null,     // scalar bonuses + engineering xp multiplier/party info
    communityBuffs: null,   // [{id, active, tier, bonusPct}]
    activeRecipeId: null,
  };
  const startsByRecipe = {};   // recipeId -> last /api/crafting/start body (+ time)
  const recipeIdByName = {};   // "Copper Pickaxe" -> "copper_pickaxe"

  function onCraftingState(json) {
    const eng = json?.professions?.engineering;
    if (eng) {
      context.engineeringLevel = eng.level;
      context.engineeringXp = eng.xp;
      (eng.recipes || []).forEach(r => { if (r.result?.type === 'trade_gear') recipeIdByName[r.name] = r.id; });
    }
    const b = json?.craftBonuses;
    if (b) {
      const engBonus = b.xpBonus?.engineering || {};
      context.craftBonuses = {
        craftGoldCostPct: b.craftGoldCostPct,
        craftSpeedPct: b.craftSpeedPct,
        craftXpPct: b.craftXpPct,
        doubleCraftXpPct: b.doubleCraftXpPct,
        matCostPct: b.matCostPct,
        engineeringXpMult: b.xpMult?.engineering,
        partySpeedPct: engBonus.partySpeedPct,
        partyLifeSkillers: engBonus.partyLifeSkillers,
      };
    }
    if (json?.craftingActive) context.activeRecipeId = json.craftingActive.recipeId;
  }

  function onCraftingTick(json) {
    if (json?.profession === 'engineering' && json.professionLevel != null) {
      context.engineeringLevel = json.professionLevel;
      context.engineeringXp = json.professionXp;
    }
  }

  function onCommunityBuffs(json) {
    if (!Array.isArray(json?.buffs)) return;
    // Only the buff state; the response also lists other players, which we don't keep.
    context.communityBuffs = json.buffs.map(b => ({ id: b.id, active: b.active, tier: b.tier, bonusPct: b.bonusPct }));
  }

  function onCraftStart(body) {
    if (!body?.recipeId) return;
    startsByRecipe[body.recipeId] = {
      count: body.count,
      useDaoCrystal: body.useDaoCrystal,
      inputRarities: body.inputRarities,
      inputForgeTiers: body.inputForgeTiers,
      matChoices: body.matChoices,
      startedAt: Date.now(),
    };
    context.activeRecipeId = body.recipeId;
  }

  // -----------------------------------------------------------------------
  // DETECTION
  // With "Craft for Shop" on, crafted tools land in /api/shop/mine -> shop.gear
  // (polled every few seconds). With it off they land in /api/inventory.
  // A tool id we haven't seen before = a new craft.
  // -----------------------------------------------------------------------
  function toolsFrom(source, json) {
    const list = source === 'shop' ? json?.shop?.gear : json;
    if (!Array.isArray(list)) return [];
    return list.filter(it => it && it.id && TOOL_TYPES.has(it.type));
  }

  function recordFor(it, source) {
    const stats = { ...(it.stats || {}) };
    const qualities = stats._qualities || {};
    delete stats._qualities;

    // Everything else the item carries (itemLevel, bonusTierMult, subTier, prefixes,
    // obtainedAt, ... — inventory items carry more than shop items), minus fields
    // already captured or that only reflect later upgrades.
    const extra = { ...it };
    ['id', 'name', 'rarity', 'stats', 'totalStats', 'baseTotalStats', 'type'].forEach(k => delete extra[k]);

    const recipeId = recipeIdByName[it.name] || null;
    return {
      id: it.id,
      name: it.name,
      type: it.type,
      tier: it.item_tier ?? it.itemTier,
      rarity: it.rarity,
      quality: qualities.power,
      qualities,
      stats,
      seenAt: Date.now(),
      source,
      item: extra,
      context: {
        recipeId,
        engineeringLevel: context.engineeringLevel,
        engineeringXp: context.engineeringXp,
        craftBonuses: context.craftBonuses,
        communityBuffs: context.communityBuffs,
        start: (recipeId && startsByRecipe[recipeId]) || null,
      },
    };
  }

  function handleItems(source, json) {
    const tools = toolsFrom(source, json);
    if (tools.length === 0) return;

    // First response ever from this source: remember what's already there, no popup.
    if (!initialized[source]) {
      tools.forEach(t => seen.add(t.id));
      initialized[source] = true;
      save(SEEN_KEY, [...seen]);
      save(INIT_KEY, initialized);
      return;
    }

    const fresh = tools.filter(t => !seen.has(t.id)).map(t => recordFor(t, source));
    if (fresh.length === 0) return;

    fresh.forEach(t => seen.add(t.id));
    history.push(...fresh);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    save(SEEN_KEY, [...seen]);
    save(HISTORY_KEY, history);

    showCrafts(fresh);
  }

  const ROUTES = [
    [/\/api\/shop\/mine(\?|$)/, j => handleItems('shop', j)],
    [/\/api\/inventory(\?|$)/, j => handleItems('inv', j)],
    [/\/api\/crafting(\?|$)/, onCraftingState],
    [/\/api\/crafting\/tick(\?|$)/, onCraftingTick],
    [/\/api\/community-buffs(\?|$)/, onCommunityBuffs],
  ];

  // Observe-only fetch hook: the game's request and response pass through untouched.
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const origFetch = page.fetch;
  page.fetch = async function (...args) {
    let url = '';
    try {
      url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (/\/api\/crafting\/start(\?|$)/.test(url) && typeof args[1]?.body === 'string') {
        onCraftStart(JSON.parse(args[1].body));
      }
    } catch (e) { /* never interfere with the game */ }

    const res = await origFetch.apply(this, args);
    try {
      const route = ROUTES.find(([re]) => re.test(url));
      if (route && res.ok) res.clone().json().then(route[1]).catch(() => {});
    } catch (e) { /* never interfere with the game */ }
    return res;
  };

  // -----------------------------------------------------------------------
  // EXPORT
  // -----------------------------------------------------------------------
  function exportHistory() {
    const data = { exportedAt: new Date().toISOString(), scriptVersion: '1.1', crafts: history };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `voididle-crafts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  GM_registerMenuCommand(`Export craft history (${history.length})`, exportHistory);

  // -----------------------------------------------------------------------
  // POPUP
  // One panel that grows as crafts come in; closing it clears the list and
  // the next craft opens a fresh one.
  // -----------------------------------------------------------------------
  let panel = null;
  let list = null;
  let title = null;
  let count = 0;

  function headerButton(text, tip, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = tip;
    b.style.cssText = `
      background: transparent; border: none; color: #8A93A6; cursor: pointer;
      font-size: 13px; padding: 0 2px; line-height: 1;
    `;
    b.onclick = onClick;
    return b;
  }

  function injectPanel() {
    panel = document.createElement('div');
    panel.id = 'vcrp-panel';
    panel.style.cssText = `
      position: fixed; z-index: 999999; top: 56px; right: 16px;
      background: #161C27; border: 1px solid #2A3240; border-radius: 10px;
      padding: 10px; display: flex; flex-direction: column; gap: 6px;
      font-family: -apple-system, sans-serif; font-size: 12.5px; color: #E8EAF0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4); width: 280px; max-height: 60vh;
    `;

    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:6px;';

    title = document.createElement('div');
    title.style.cssText = 'font-weight:600; color:#A78BFA; flex:1;';
    titleBar.appendChild(title);

    titleBar.appendChild(headerButton('⤓', 'Export craft history', exportHistory));
    titleBar.appendChild(headerButton('✕', 'Close', () => {
      panel.remove();
      panel = list = title = null;
      count = 0;
    }));
    panel.appendChild(titleBar);

    list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:4px; overflow-y:auto;';
    panel.appendChild(list);

    document.body.appendChild(panel);
  }

  function statLine(stats) {
    return Object.entries(stats)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${STAT_LABELS[k] || k} ${v}`)
      .join(' · ');
  }

  function showCrafts(tools) {
    if (!document.body) return;
    if (!panel) injectPanel();

    tools.forEach(t => {
      const color = RARITY_COLORS[t.rarity] || '#E8EAF0';

      const row = document.createElement('div');
      row.style.cssText = `border-left: 3px solid ${color}; background: #1E2530; border-radius: 6px; padding: 5px 8px;`;

      const top = document.createElement('div');
      top.style.cssText = 'display:flex; justify-content:space-between; gap:6px;';
      const name = document.createElement('span');
      name.textContent = t.tier ? `${t.name} (T${t.tier})` : t.name;
      const rarity = document.createElement('span');
      rarity.textContent = (t.rarity || '?').toUpperCase();
      rarity.style.cssText = `color:${color}; font-weight:700; font-size:11.5px;`;
      top.append(name, rarity);

      const detail = document.createElement('div');
      detail.textContent = [t.quality != null ? `Quality ${t.quality}` : null, statLine(t.stats)]
        .filter(Boolean).join(' · ');
      detail.style.cssText = 'color:#8A93A6; font-size:11.5px;';

      row.append(top, detail);
      list.prepend(row);
      count++;
    });

    title.textContent = `⚒ New Crafts (${count})`;
  }
})();
