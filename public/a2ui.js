/* ============================================================
   GRIMORE A2UI ENGINE — a2ui.js
   Agentic Adaptive User Interface Schema & Component Renderer
   ============================================================ */

'use strict';

(function() {
  const A2UI = {
    version: '1.0.0',

    // Main Renderer: Converts a declarative A2UI payload into DOM elements
    render(payload, container) {
      if (!container) return null;
      if (typeof container === 'string') {
        container = document.getElementById(container);
      }
      if (!container) return null;

      if (!payload) return null;

      // Handle array of widgets
      if (Array.isArray(payload)) {
        container.innerHTML = '';
        payload.forEach(item => this.render(item, container));
        return container;
      }

      if (payload.type !== 'a2ui_widget') {
        return null;
      }

      const widgetEl = this.createWidget(payload.component, payload.props || {});
      if (widgetEl) {
        // Entry animation class
        widgetEl.classList.add('a2ui-widget-enter');
        container.appendChild(widgetEl);
        setTimeout(() => widgetEl.classList.remove('a2ui-widget-enter'), 300);
      }
      return widgetEl;
    },

    // Factory method for creating A2UI components
    createWidget(component, props) {
      switch (component) {
        case 'A2UICard':
          return this.buildCard(props);
        case 'A2UIGauge':
          return this.buildGauge(props);
        case 'A2UIActionPills':
          return this.buildActionPills(props);
        case 'A2UIRuleBanner':
          return this.buildRuleBanner(props);
        default:
          console.warn(`[A2UI] Unknown component type: ${component}`);
          return null;
      }
    },

    // 1. A2UICard: Interactive Card Tile Component
    buildCard(props) {
      const el = document.createElement('div');
      el.className = 'a2ui-card-tile';
      el.style.cssText = `
        background: rgba(14, 18, 26, 0.85);
        border: 1px solid var(--border-medium, rgba(168,85,247,0.3));
        border-radius: var(--radius-md, 12px);
        padding: 0.75rem;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        box-shadow: 0 4px 14px rgba(0,0,0,0.3);
        transition: transform 0.18s ease, border-color 0.18s ease;
      `;

      const scryfallId = props.scryfallId || props.scryfall_id || '';
      const imgUrl = (scryfallId && scryfallId.length > 5)
        ? `https://cards.scryfall.io/small/front/${scryfallId.charAt(0)}/${scryfallId.charAt(1)}/${scryfallId}.jpg`
        : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(props.name || 'Card')}&format=image&version=small`;

      const priceStr = props.price ? `$${parseFloat(props.price).toFixed(2)}` : '';

      el.innerHTML = `
        <img src="${imgUrl}" alt="${this.escapeHtml(props.name || 'Card')}" style="width: 48px; height: 68px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" onerror="this.style.display='none'">
        <div style="flex-grow: 1; min-width: 0;">
          <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-pure, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${this.escapeHtml(props.name || 'Card')}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted, #94a3b8); margin-top: 2px;">${this.escapeHtml(props.type || props.typeLine || 'MTG Card')}</div>
          ${priceStr ? `<div style="font-size: 0.75rem; font-weight: 700; color: var(--color-gold, #f59e0b); margin-top: 4px;">${priceStr}</div>` : ''}
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;">
          ${props.onAdd ? `<button type="button" class="btn btn-secondary btn-sm a2ui-btn-add" style="font-size: 0.68rem; padding: 2px 8px; font-weight: 700;">Add</button>` : ''}
          <button type="button" class="btn btn-secondary btn-sm a2ui-btn-buy" style="font-size: 0.68rem; padding: 2px 8px; font-weight: 700; color: #f59e0b; border-color: rgba(245,158,11,0.3);">Buy</button>
        </div>
      `;

      // Event handlers
      const buyBtn = el.querySelector('.a2ui-btn-buy');
      if (buyBtn) {
        buyBtn.onclick = (e) => {
          e.stopPropagation();
          const cardName = props.name || 'Card';
          const massUrl = `https://www.tcgplayer.com/massentry?productline=Magic&c=1%20${encodeURIComponent(cardName)}`;
          const affUrl = `https://partner.tcgplayer.com/xJoE0d?u=${encodeURIComponent(massUrl)}`;
          window.open(affUrl, '_blank', 'noopener,noreferrer');
        };
      }

      const addBtn = el.querySelector('.a2ui-btn-add');
      if (addBtn && typeof props.onAdd === 'function') {
        addBtn.onclick = (e) => {
          e.stopPropagation();
          props.onAdd(props);
        };
      }

      return el;
    },

    // 2. A2UIGauge: Percentage / Power Level Progress Gauge
    buildGauge(props) {
      const el = document.createElement('div');
      el.className = 'a2ui-gauge-widget';
      el.style.cssText = `
        background: rgba(12, 13, 20, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--radius-sm, 8px);
        padding: 0.65rem 0.85rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      `;

      const pct = Math.max(0, Math.min(100, props.value || 0));
      const label = props.label || 'Progress';
      const sub = props.subtitle || `${pct}%`;
      const color = props.color || 'var(--color-primary, #a855f7)';

      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.72rem; font-weight: 700; color: var(--text-muted, #94a3b8); text-transform: uppercase; letter-spacing: 0.04em;">${this.escapeHtml(label)}</span>
          <span style="font-size: 0.78rem; font-weight: 800; color: ${color}; font-family: var(--font-tech, Rajdhani, sans-serif);">${this.escapeHtml(sub)}</span>
        </div>
        <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden;">
          <div style="width: ${pct}%; height: 100%; background: ${color}; border-radius: 3px; transition: width 0.4s ease;"></div>
        </div>
      `;

      return el;
    },

    // 3. A2UIActionPills: Dynamic Prompt Choices & Action Pills
    buildActionPills(props) {
      const el = document.createElement('div');
      el.className = 'a2ui-action-pills-row';
      el.style.cssText = `
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        padding: 0.4rem 0;
      `;

      const actions = props.actions || [];
      actions.forEach(act => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-secondary btn-sm a2ui-pill-btn ${act.active ? 'active' : ''}`;
        btn.style.cssText = `
          font-size: 0.72rem;
          padding: 3px 10px;
          height: 26px;
          font-weight: 600;
          border-color: ${act.color || 'rgba(168,85,247,0.3)'};
          color: ${act.textColor || 'var(--text-high, #f8fafc)'};
        `;
        btn.textContent = act.label || 'Action';
        btn.onclick = () => {
          if (typeof act.onClick === 'function') act.onClick(act);
          else if (typeof props.onActionSelect === 'function') props.onActionSelect(act);
        };
        el.appendChild(btn);
      });

      return el;
    },

    // 4. A2UIRuleBanner: Official MTG Rule Citation Banner
    buildRuleBanner(props) {
      const el = document.createElement('div');
      el.className = 'a2ui-rule-banner';
      el.style.cssText = `
        background: rgba(168, 85, 247, 0.08);
        border: 1px solid rgba(168, 85, 247, 0.35);
        border-radius: var(--radius-sm, 8px);
        padding: 0.65rem 0.85rem;
        margin: 0.35rem 0;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      `;

      const ruleId = props.ruleId || props.rule_id || 'CR 100';
      const text = props.text || 'Official MTG Comprehensive Rule Citation.';

      el.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span class="hud-badge" style="background: rgba(168,85,247,0.2); color: #c084fc; font-weight: 800; font-size: 0.68rem; padding: 1px 7px; border-radius: 99px;">${this.escapeHtml(ruleId)}</span>
          <span style="font-size: 0.65rem; color: var(--text-muted, #94a3b8); font-weight: 600;">Magic Comprehensive Rules</span>
        </div>
        <div style="font-size: 0.78rem; color: var(--text-high, #f8fafc); font-weight: 500; line-height: 1.35; margin-top: 2px;">
          ${this.escapeHtml(text)}
        </div>
      `;

      return el;
    },

    // HTML Escape Helper
    escapeHtml(str) {
      if (typeof str !== 'string') return str || '';
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }
  };

  // Expose to window
  window.A2UI = A2UI;
})();
