// ==UserScript==
// @name         Void Idle - Shop Buy Order Helper
// @namespace    voididle-shop-buy-orders
// @version      2.0
// @description  Posts and cancels shop buy orders from a floating panel that works on any page — calls the game's own API directly instead of driving the Player Shop -> Stock UI, so you can stay on Market while managing orders.
// @match        https://www.voididle.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // API
  // The game's SPA stores its JWT in localStorage under "authToken" and
  // sends it as a Bearer header. Reading it here (rather than hardcoding a
  // token) means the script keeps working across logins/token refreshes.
  // -----------------------------------------------------------------------
  function authHeaders() {
    const token = localStorage.getItem('authToken');
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async function apiGet(path) {
    const res = await fetch(path, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `GET ${path} failed (${res.status})`);
    return data;
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `POST ${path} failed (${res.status})`);
    return data;
  }

  // { combatMaterials: [{id, name}], orders: [{id, name, quantity, unit, filledQty, expiresAt, funderId}] }
  function loadBuyOrderState() {
    return apiGet('/api/shop/buy-orders');
  }

  function postBuyOrder(materialId, unitPrice, quantity) {
    return apiPost('/api/shop/buy-order/create', { materialId, unitPrice, quantity });
  }

  function cancelBuyOrder(orderId) {
    return apiPost('/api/shop/buy-order/cancel', { orderId });
  }

  // -----------------------------------------------------------------------
  // FLOATING UI
  // -----------------------------------------------------------------------
  const POS_KEY = 'vsbo-panel-pos';       // {left, top} in px
  const COLLAPSED_KEY = 'vsbo-panel-collapsed'; // "1" | "0"

  function injectPanel() {
    if (document.getElementById('vsbo-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'vsbo-panel';
    panel.style.cssText = `
      position: fixed; z-index: 999999;
      background: #161C27; border: 1px solid #2A3240; border-radius: 10px;
      padding: 10px; display: flex; flex-direction: column; gap: 6px;
      font-family: -apple-system, sans-serif; font-size: 12.5px; color: #E8EAF0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4); width: 240px;
      max-height: 70vh; overflow-y: auto;
    `;

    // Restore a saved position, or default to bottom-left.
    let savedPos = null;
    try { savedPos = JSON.parse(localStorage.getItem(POS_KEY)); } catch (e) { /* ignore */ }
    if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
      panel.style.left = `${savedPos.left}px`;
      panel.style.top = `${savedPos.top}px`;
    } else {
      panel.style.left = '16px';
      panel.style.bottom = '16px';
    }

    // Title bar: drag handle + collapse toggle.
    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex; align-items:center; justify-content:space-between; cursor:move; user-select:none; margin-bottom:2px;';

    const title = document.createElement('div');
    title.textContent = 'Shop Buy Orders';
    title.style.cssText = 'font-weight:600; color:#A78BFA;';
    titleBar.appendChild(title);

    const collapseBtn = document.createElement('button');
    collapseBtn.style.cssText = `
      background: transparent; border: none; color: #8A93A6; cursor: pointer;
      font-size: 13px; padding: 0 2px; line-height: 1;
    `;
    titleBar.appendChild(collapseBtn);
    panel.appendChild(titleBar);

    const content = document.createElement('div');
    content.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    panel.appendChild(content);

    let collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
    function applyCollapsed() {
      content.style.display = collapsed ? 'none' : 'flex';
      collapseBtn.textContent = collapsed ? '▸' : '▾';
      collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    }
    applyCollapsed();
    collapseBtn.onclick = () => {
      collapsed = !collapsed;
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
      applyCollapsed();
    };

    // Drag from the title bar (but not the collapse button) to reposition.
    titleBar.addEventListener('mousedown', (e) => {
      if (e.target === collapseBtn) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      panel.style.bottom = '';
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;

      function onMove(ev) {
        const newLeft = rect.left + (ev.clientX - startX);
        const newTop = rect.top + (ev.clientY - startY);
        const maxLeft = window.innerWidth - panel.offsetWidth;
        const maxTop = window.innerHeight - panel.offsetHeight;
        panel.style.left = `${Math.min(Math.max(newLeft, 0), Math.max(maxLeft, 0))}px`;
        panel.style.top = `${Math.min(Math.max(newTop, 0), Math.max(maxTop, 0))}px`;
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem(POS_KEY, JSON.stringify({
          left: parseFloat(panel.style.left),
          top: parseFloat(panel.style.top),
        }));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const fieldStyle = `
      background: #1E2530; border: 1px solid #2A3240; color: #E8EAF0;
      border-radius: 6px; padding: 5px 6px; font-size: 12.5px; font-family: inherit;
      width: 100%; box-sizing: border-box;
    `;
    const btnStyle = `
      background: #1E2530; border: 1px solid #2A3240; color: #E8EAF0;
      border-radius: 6px; padding: 6px 8px; cursor: pointer; font-size: 12.5px;
      font-family: inherit;
    `;
    function styleBtn(b) {
      b.style.cssText = btnStyle;
      b.onmouseenter = () => b.style.borderColor = '#A78BFA';
      b.onmouseleave = () => b.style.borderColor = '#2A3240';
      return b;
    }

    const select = document.createElement('select');
    select.style.cssText = fieldStyle;
    content.appendChild(select);

    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.min = '1';
    priceInput.placeholder = 'Price / each';
    priceInput.style.cssText = fieldStyle;
    content.appendChild(priceInput);

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.placeholder = 'Qty';
    qtyInput.style.cssText = fieldStyle;
    content.appendChild(qtyInput);

    const status = document.createElement('div');
    status.style.cssText = 'color:#8A93A6; min-height:14px; font-size:11.5px;';
    content.appendChild(status);

    const postBtn = styleBtn(document.createElement('button'));
    postBtn.textContent = '📥 Post Buy Order';
    content.appendChild(postBtn);

    const refreshBtn = styleBtn(document.createElement('button'));
    refreshBtn.textContent = '↻ Refresh';
    content.appendChild(refreshBtn);

    const ordersTitle = document.createElement('div');
    ordersTitle.textContent = 'Open Orders';
    ordersTitle.style.cssText = 'font-weight:600; margin-top:6px; color:#A78BFA;';
    content.appendChild(ordersTitle);

    const ordersList = document.createElement('div');
    ordersList.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
    content.appendChild(ordersList);

    document.body.appendChild(panel);

    let materials = []; // [{id, name}]

    function renderOrders(orders) {
      ordersList.innerHTML = '';
      if (orders.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No open orders.';
        empty.style.cssText = 'color:#8A93A6;';
        ordersList.appendChild(empty);
        return;
      }
      orders.forEach(o => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:6px; border-bottom:1px solid #2A3240; padding-bottom:4px;';

        const info = document.createElement('div');
        info.style.cssText = 'flex:1; min-width:0;';
        info.innerHTML = `<div>${o.name}</div><div style="color:#8A93A6;">${o.filledQty.toLocaleString()} / ${o.quantity.toLocaleString()} @ ${o.unit}/ea</div>`;
        row.appendChild(info);

        const cancelBtn = styleBtn(document.createElement('button'));
        cancelBtn.textContent = '✕';
        cancelBtn.style.padding = '3px 7px';
        cancelBtn.onclick = async () => {
          cancelBtn.disabled = true;
          status.textContent = 'Cancelling…';
          try {
            await cancelBuyOrder(o.id);
            status.textContent = `Cancelled ${o.name} order.`;
            await refresh();
          } catch (e) {
            status.textContent = `Cancel failed: ${e.message}`;
            cancelBtn.disabled = false;
          }
        };
        row.appendChild(cancelBtn);

        ordersList.appendChild(row);
      });
    }

    async function refresh() {
      status.textContent = 'Loading…';
      try {
        const state = await loadBuyOrderState();
        materials = state.combatMaterials;
        const prevValue = select.value;
        select.innerHTML = '';
        materials.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          select.appendChild(opt);
        });
        if (materials.some(m => m.id === prevValue)) select.value = prevValue;
        renderOrders(state.orders);
        status.textContent = `${materials.length} materials, ${state.orders.length} open orders.`;
      } catch (e) {
        status.textContent = `Load failed: ${e.message}`;
      }
    }

    postBtn.onclick = async () => {
      const materialId = select.value;
      const unitPrice = parseFloat(priceInput.value);
      const quantity = parseFloat(qtyInput.value);
      if (!materialId || !(unitPrice > 0) || !(quantity > 0)) {
        status.textContent = 'Pick a material and enter a positive price and quantity.';
        return;
      }
      postBtn.disabled = true;
      status.textContent = 'Posting…';
      try {
        await postBuyOrder(materialId, unitPrice, quantity);
        status.textContent = 'Order posted.';
        priceInput.value = '';
        qtyInput.value = '';
        await refresh();
      } catch (e) {
        status.textContent = `Post failed: ${e.message}`;
      } finally {
        postBtn.disabled = false;
      }
    };

    refreshBtn.onclick = refresh;

    refresh();
  }

  const ready = setInterval(() => {
    if (document.body) {
      injectPanel();
      clearInterval(ready);
    }
  }, 500);
})();
