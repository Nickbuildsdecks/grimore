(function() {
  // State variables
  let currentUser = null;
  let collections = [];
  let activeCollectionId = null; // null if "wishlist", "recovery" is selected
  let collectionCards = []; // active collection cards
  let wishlistCards = [];
  let deletedItems = [];
  
  let activeEditCard = null;
  let activeTheme = 'purple';
  let activeFilters = {
    search: '',
    function: '',
    colors: [],
    tradeOnly: false,
    sort: 'name',
    view: 'grid'
  };

  // Autocomplete variables
  let autocompleteTimeout = null;
  const searchInput = document.getElementById('card-search-input');
  const suggestionsDiv = document.getElementById('autocomplete-suggestions');

  document.addEventListener('DOMContentLoaded', async () => {
    const authed = await checkAuthStatus();
    if (!authed) {
      alert("Please log in first.");
      window.location.href = 'index.html';
      return;
    }

    // Apply UI theme
    if (localStorage.getItem('theme-mode') === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }

    setupEventListeners();
    await loadCollections();
  });

  // Check login status
  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.loggedIn) {
        currentUser = data.user || data.player;
        return true;
      }
    } catch (e) {
      console.error("Auth status error:", e);
    }
    return false;
  }

  // Load collections from server
  async function loadCollections() {
    try {
      const res = await fetch('/api/collections');
      const data = await res.json();
      if (data.success) {
        collections = data.collections || [];
        
        renderCollectionsSidebar();

        if (collections.length === 0) {
          activeCollectionId = null;
          renderEmptyCollectionsState();
          updateSummaryBadge();
          return;
        }

        // Set active collection (preserve selection if possible, otherwise default to first)
        if (!activeCollectionId) {
          activeCollectionId = collections[0].id;
        }

        if (activeCollectionId === 'wishlist') {
          await loadWishlist();
        } else if (activeCollectionId === 'recovery') {
          await loadRecycleBin();
        } else {
          // Verify active collection still exists
          const exists = collections.some(c => c.id === activeCollectionId);
          if (!exists && collections.length > 0) {
            activeCollectionId = collections[0].id;
          }
          await loadCollectionCards(activeCollectionId);
        }
      }
    } catch (e) {
      console.error("Failed to load collections:", e);
    }
  }

  // Fetch cards for active collection
  async function loadCollectionCards(collectionId) {
    try {
      const res = await fetch(`/api/collections/${collectionId}/cards`);
      const data = await res.json();
      if (data.success) {
        collectionCards = data.cards || [];
        
        // Show standard headers and search bars
        document.getElementById('active-collection-header-row').style.display = 'flex';
        document.getElementById('collection-search-header-bar').style.display = 'block';

        // Get collection settings to apply default view/sort
        const coll = collections.find(c => c.id === collectionId);
        if (coll) {
          let settings = {};
          try { settings = JSON.parse(coll.settings || '{}'); } catch(e){}
          
          activeFilters.view = settings.view || 'grid';
          activeFilters.sort = settings.sort || 'name';
          applyCollectionTheme(settings.theme || 'purple');

          document.getElementById('filter-sort-select').value = activeFilters.sort;
        }

        document.getElementById('active-collection-title').textContent = coll ? coll.name : "Collection";
        document.getElementById('btn-collection-settings').style.display = 'inline-block';
        document.getElementById('btn-delete-collection').style.display = 'inline-block';

        applyFilters();
        updateSummaryBadge();
      }
    } catch (e) {
      console.error("Failed to load cards:", e);
    }
  }

  // Fetch wishlist cards
  async function loadWishlist() {
    try {
      const res = await fetch('/api/wishlist');
      const data = await res.json();
      if (data.success) {
        wishlistCards = data.wishlist || [];
        
        // Show standard headers and search bars
        document.getElementById('active-collection-header-row').style.display = 'flex';
        document.getElementById('collection-search-header-bar').style.display = 'block';

        document.getElementById('active-collection-title').textContent = "💖 Wants / Wishlist";
        document.getElementById('active-collection-value-badge').textContent = `${wishlistCards.length} Cards`;
        document.getElementById('btn-collection-settings').style.display = 'none';
        document.getElementById('btn-delete-collection').style.display = 'none';
        
        applyCollectionTheme('purple');
        renderWishlist();
        updateSummaryBadge();
      }
    } catch (e) {
      console.error("Failed to load wishlist:", e);
    }
  }

  // Fetch deleted recovery items
  async function loadRecycleBin() {
    try {
      const res = await fetch('/api/recovery/deleted-items');
      const data = await res.json();
      if (data.success) {
        deletedItems = data.items || [];

        // Show header, hide search input
        document.getElementById('active-collection-header-row').style.display = 'flex';
        document.getElementById('collection-search-header-bar').style.display = 'none';

        document.getElementById('active-collection-title').textContent = "♻️ Recycle Bin";
        document.getElementById('active-collection-value-badge').textContent = `${deletedItems.length} Items`;
        document.getElementById('btn-collection-settings').style.display = 'none';
        document.getElementById('btn-delete-collection').style.display = 'none';

        applyCollectionTheme('purple');
        renderRecycleBinList();
        updateSummaryBadge();
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Render Recycle Bin list items
  function renderRecycleBinList() {
    const container = document.getElementById('collection-cards-view');
    if (!container) return;
    container.innerHTML = '';
    container.className = 'collection-card-list';

    if (deletedItems.length === 0) {
      container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 4rem 1rem; font-size: 0.85rem;">Recycle Bin is empty. No deleted collections or decks to recover.</div>`;
      return;
    }

    deletedItems.forEach(item => {
      const rowEl = document.createElement('div');
      rowEl.className = 'search-card-list-item';
      rowEl.style.padding = '0.5rem 1rem';
      rowEl.style.display = 'flex';
      rowEl.style.alignItems = 'center';
      rowEl.style.gap = '1rem';
      rowEl.style.background = 'var(--bg-card)';
      rowEl.style.border = '1px solid var(--border-light)';
      rowEl.style.borderRadius = 'var(--radius-sm)';

      const typeLabel = item.item_type === 'deck' ? '📁 DECK' : '📚 COLLECTION';
      const typeColor = item.item_type === 'deck' ? 'var(--color-primary)' : 'var(--color-secondary)';

      rowEl.innerHTML = `
        <div style="font-weight: 800; color: ${typeColor}; font-size: 0.72rem; min-width: 90px; text-transform: uppercase;">${typeLabel}</div>
        <div style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0;">
          <div style="font-weight: 700; color: var(--text-pure);">${escapeHtml(item.name)}</div>
          <div style="font-size: 0.68rem; color: var(--text-muted);">Deleted on ${new Date(item.deleted_at).toLocaleString()}</div>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-gold btn-sm" onclick="restoreDeletedItem('${item.id}')" style="height: 22px; padding: 0 8px; margin: 0; font-size: 0.65rem; font-weight: 700;">Restore</button>
        </div>
      `;
      container.appendChild(rowEl);
    });
  }

  // Restore deleted item trigger
  window.restoreDeletedItem = async function(id) {
    try {
      const res = await fetch(`/api/recovery/restore/${id}`, {
        method: 'POST'
      });
      const data = await res.json();
      if (data.success) {
        alert("Item fully restored!");
        await loadCollections();
      }
    } catch(e) {
      console.error(e);
    }
  };

  // Render Promotional view when collections list is empty
  function renderEmptyCollectionsState() {
    // Hide standard headers and search bars
    document.getElementById('active-collection-header-row').style.display = 'none';
    document.getElementById('collection-search-header-bar').style.display = 'none';

    const container = document.getElementById('collection-cards-view');
    if (!container) return;
    container.innerHTML = '';
    container.className = 'collection-card-list';

    const emptyBox = document.createElement('div');
    emptyBox.className = 'deck-empty-experience';
    emptyBox.style.margin = 'auto';
    emptyBox.style.maxWidth = '900px';
    emptyBox.style.padding = '3rem 1.5rem';

    emptyBox.innerHTML = `
      <div class="deck-empty-copy">
        <span class="deck-empty-kicker">Your MTG binder, digitized</span>
        <h3>Manage your collections like a Pro.</h3>
        <p>Track card values, catalog your trades, and map owned cards directly into the Grimore Deck Builder. Beautiful, visual, and entirely free.</p>
        <div class="deck-empty-actions">
          <button type="button" class="btn btn-gold btn-lg" onclick="openNewCollectionModal()">
            <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 18px; height: 18px; margin-right: 0.25rem;"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            Create your first collection
          </button>
        </div>
      </div>
      <div class="deck-empty-art" aria-hidden="true">
        <div class="deck-art-card deck-art-card-left" style="--deck-art: url('https://api.scryfall.com/cards/named?exact=Black%20Lotus&format=image&version=art_crop')"></div>
        <div class="deck-art-card deck-art-card-center" style="--deck-art: url('https://api.scryfall.com/cards/named?exact=Mox%20Diamond&format=image&version=art_crop')"></div>
        <div class="deck-art-card deck-art-card-right" style="--deck-art: url('https://api.scryfall.com/cards/named?exact=Mana%20Crypt&format=image&version=art_crop')"></div>
        <div class="deck-art-orbit"></div>
      </div>
    `;
    container.appendChild(emptyBox);
  }

  // Apply visual accent theme HSL values to collection workspace
  function applyCollectionTheme(theme) {
    activeTheme = theme;
    const colors = {
      purple: { primary: '#a855f7', border: 'rgba(168, 85, 247, 0.3)' },
      gold: { primary: '#d9a94e', border: 'rgba(217, 169, 78, 0.3)' },
      green: { primary: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },
      blue: { primary: '#2563eb', border: 'rgba(37, 99, 235, 0.3)' }
    };
    const c = colors[theme] || colors.purple;
    
    document.documentElement.style.setProperty('--color-primary', c.primary);
    document.documentElement.style.setProperty('--border-medium', c.border);
  }

  // Render Left Binders Sidebar
  function renderCollectionsSidebar() {
    const listDiv = document.getElementById('collections-tabs-list');
    if (!listDiv) return;
    listDiv.innerHTML = '';

    collections.forEach(c => {
      let settings = {};
      try { settings = JSON.parse(c.settings || '{}'); } catch(e){}
      
      const themeColors = { purple: '#c084fc', gold: '#fbbf24', green: '#34d399', blue: '#60a5fa' };
      const dotColor = themeColors[settings.theme || 'purple'] || '#c084fc';

      const tab = document.createElement('div');
      tab.className = `collection-item-tab ${c.id === activeCollectionId ? 'active' : ''}`;
      tab.onclick = () => {
        activeCollectionId = c.id;
        loadCollectionCards(c.id);
        
        // Update selection states in UI sidebar
        document.querySelectorAll('.collection-item-tab').forEach(el => el.classList.remove('active'));
        tab.classList.add('active');
      };

      tab.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${dotColor};"></span>
          <span class="collection-item-title">${escapeHtml(c.name)}</span>
        </div>
        <div class="collection-item-stats">
          <span>${c.total_cards || 0} cards</span>
          <span style="font-weight: 700; color: var(--color-secondary); font-size: 0.68rem;">$${(c.total_value || 0).toFixed(2)}</span>
        </div>
      `;
      listDiv.appendChild(tab);
    });

    // Wants/Wishlist Tab
    const wishlistTab = document.createElement('div');
    wishlistTab.className = `collection-item-tab ${activeCollectionId === 'wishlist' ? 'active' : ''}`;
    wishlistTab.onclick = () => {
      activeCollectionId = 'wishlist';
      loadWishlist();
      document.querySelectorAll('.collection-item-tab').forEach(el => el.classList.remove('active'));
      wishlistTab.classList.add('active');
    };
    wishlistTab.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span>💖</span>
        <span class="collection-item-title">Wants / Wishlist</span>
      </div>
      <div class="collection-item-stats">
        <span>Tracker</span>
        <span style="font-weight: 700; color: var(--color-primary); font-size: 0.68rem;">Wishlist</span>
      </div>
    `;
    listDiv.appendChild(wishlistTab);

    // Recycle Bin Tab
    const binTab = document.createElement('div');
    binTab.className = `collection-item-tab ${activeCollectionId === 'recovery' ? 'active' : ''}`;
    binTab.onclick = () => {
      activeCollectionId = 'recovery';
      loadRecycleBin();
      document.querySelectorAll('.collection-item-tab').forEach(el => el.classList.remove('active'));
      binTab.classList.add('active');
    };
    binTab.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span>♻️</span>
        <span class="collection-item-title">Recycle Bin</span>
      </div>
      <div class="collection-item-stats">
        <span>Recovery</span>
        <span style="font-weight: 700; color: #ef4444; font-size: 0.68rem;">Archived</span>
      </div>
    `;
    listDiv.appendChild(binTab);
  }

  // Calculate and update top summary valuation card
  function updateSummaryBadge() {
    let total = 0;
    collections.forEach(c => total += (c.total_value || 0));
    document.getElementById('summary-total-value').textContent = `$${total.toFixed(2)}`;
    
    if (activeCollectionId && activeCollectionId !== 'wishlist' && activeCollectionId !== 'recovery') {
      const coll = collections.find(c => c.id === activeCollectionId);
      if (coll) {
        document.getElementById('active-collection-value-badge').textContent = `$${(coll.total_value || 0).toFixed(2)}`;
      }
    }
  }

  // Client-Side Card Categorization based on type and oracle text
  function getCardFunctionCategory(typeLine, oracleText) {
    const type = (typeLine || '').toLowerCase();
    const oracle = (oracleText || '').toLowerCase();

    // Check combos
    if (oracle.includes('infinite') || oracle.includes('win the game')) {
      return 'Infinite Combos';
    }
    // Tutors
    if (oracle.includes('search your library') && (oracle.includes('card') || oracle.includes('land'))) {
      return 'Tutors';
    }
    // Stax
    if (oracle.includes('cant cast') || oracle.includes('spells cost') || oracle.includes('whenever a player casts') || oracle.includes('enters the battlefield tapped')) {
      return 'Stax';
    }
    // Mass Removal
    if ((oracle.includes('destroy all') || oracle.includes('exile all')) && (oracle.includes('creatures') || oracle.includes('nonland permanents') || oracle.includes('artifacts'))) {
      return 'Mass Removal';
    }
    // Single Target Removal
    if (oracle.includes('destroy target') || oracle.includes('exile target') || oracle.includes('counter target spell') || oracle.includes('return target')) {
      return 'Single Target Removal';
    }
    // Protection
    if (oracle.includes('hexproof') || oracle.includes('indestructible') || oracle.includes('shroud') || oracle.includes('protection from')) {
      return 'Protection';
    }
    // Ramp
    if (oracle.includes('add ') || oracle.includes('search your library for a basic land card') || type.includes('mana dork') || oracle.includes('taps for')) {
      return 'Ramp';
    }
    // Card Advantage
    if (oracle.includes('draw a card') || oracle.includes('draw cards') || oracle.includes('look at the top')) {
      return 'Card Advantage';
    }

    return 'Other';
  }

  // Filter and sort active collection cards
  function applyFilters() {
    if (activeCollectionId === 'wishlist' || activeCollectionId === 'recovery' || !activeCollectionId) return;

    const functionVal = document.getElementById('filter-function-select').value;
    const sortVal = document.getElementById('filter-sort-select').value;
    const tradeOnly = document.getElementById('filter-trade-toggle').checked;
    const searchVal = document.getElementById('card-search-input').value.toLowerCase().trim();

    let filtered = [...collectionCards];

    // Text Search
    if (searchVal) {
      filtered = filtered.filter(c => c.card_name.toLowerCase().includes(searchVal));
    }

    // Function Filter
    if (functionVal) {
      filtered = filtered.filter(c => {
        const cat = getCardFunctionCategory(c.type_line, c.oracle_text);
        return cat === functionVal;
      });
    }

    // Color Filters
    if (activeFilters.colors.length > 0) {
      filtered = filtered.filter(c => {
        let colors = [];
        try { colors = JSON.parse(c.colors || '[]'); } catch(e){}
        // Match if card colors include ANY of the filter colors
        return activeFilters.colors.some(col => colors.includes(col)) || (activeFilters.colors.includes('C') && colors.length === 0);
      });
    }

    // Trade Only
    if (tradeOnly) {
      filtered = filtered.filter(c => c.is_for_trade === 1);
    }

    // Sorting
    filtered.sort((a, b) => {
      if (sortVal === 'price-desc') return b.price - a.price;
      if (sortVal === 'price-asc') return a.price - b.price;
      if (sortVal === 'cmc') return b.cmc - a.cmc;
      if (sortVal === 'rarity') {
        const rarities = { mythic: 4, rare: 3, uncommon: 2, common: 1 };
        // fallback logic
        const getRarityVal = (r) => rarities[(r || 'common').toLowerCase()] || 0;
        return getRarityVal(b.rarity) - getRarityVal(a.rarity);
      }
      return a.card_name.localeCompare(b.card_name);
    });

    renderCollectionCards(filtered);
  }

  // Render Cards Grid / List
  function renderCollectionCards(cards) {
    const container = document.getElementById('collection-cards-view');
    if (!container) return;
    container.innerHTML = '';

    if (activeFilters.view === 'grid') {
      container.className = 'collection-card-grid';
      if (cards.length === 0) {
        container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 4rem 1rem; font-size: 0.85rem;">No cards found matching filters.</div>`;
        return;
      }

      cards.forEach(c => {
        const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.card_name)}&format=image&version=normal`;
        const imgUrl = c.scryfall_id ? `https://api.scryfall.com/cards/${c.scryfall_id}?format=image&version=normal` : fallbackUrl;
        
        const cardEl = document.createElement('div');
        cardEl.className = 'search-card-item';
        cardEl.style.position = 'relative';
        cardEl.style.cursor = 'pointer';
        cardEl.style.display = 'flex';
        cardEl.style.flexDirection = 'column';
        cardEl.style.background = 'var(--bg-card)';
        cardEl.style.borderRadius = 'var(--radius-md)';
        cardEl.style.overflow = 'hidden';
        cardEl.style.border = '1px solid var(--border-light)';
        cardEl.style.transition = 'all 0.25s ease';
        cardEl.style.alignSelf = 'start'; // Prevents stretching within grid row

        // Open Inspector drawer on card visual click
        cardEl.onclick = function() {
          if (window.openCardInspectorDrawer) {
            window.openCardInspectorDrawer({ name: c.card_name, scryfallId: c.scryfall_id || '' });
          }
        };

        cardEl.onmouseover = function() {
          this.style.borderColor = 'var(--color-primary)';
          this.style.boxShadow = '0 8px 24px rgba(217, 169, 78, 0.18)';
        };
        cardEl.onmouseout = function() {
          this.style.borderColor = 'var(--border-light)';
          this.style.boxShadow = 'none';
        };

        // Quantity badge
        const qtyBadge = `<div style="position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,0.85); color: var(--color-primary); font-size: 0.72rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; z-index: 10; border: 1px solid var(--border-medium);">x${c.quantity}</div>`;
        
        // Foil badge
        const foilBadge = c.is_foil === 1 ? `<div style="position: absolute; top: 6px; right: 6px; background: linear-gradient(135deg, #d9a94e, #ec4899); color: white; font-size: 0.65rem; font-weight: 800; padding: 1px 5px; border-radius: 4px; z-index: 10; box-shadow: 0 2px 6px rgba(0,0,0,0.5);">FOIL</div>` : '';

        // For Trade badge
        const tradeBadge = c.is_for_trade === 1 ? `<div style="position: absolute; bottom: 38px; left: 6px; background: rgba(16, 185, 129, 0.9); color: black; font-size: 0.65rem; font-weight: 800; padding: 1px 5px; border-radius: 4px; z-index: 10; display: flex; align-items: center; gap: 2px;">♻️ Trade</div>` : '';

        cardEl.innerHTML = `
          ${qtyBadge}
          ${foilBadge}
          ${tradeBadge}
          <div class="search-card-image-wrap" style="width: 100%; aspect-ratio: 2.5/3.5; overflow: hidden; background: #141210; position: relative;" data-card-name="${c.card_name}">
            <img src="${imgUrl}" alt="${c.card_name}" loading="lazy" style="width: 100%; height: 100%; object-fit: contain; transition: transform 0.2s ease;"
                 onmouseover="this.style.transform='scale(1.03)'"
                 onmouseout="this.style.transform='none'"
                 onerror="this.src='logo.svg'">
          </div>
          
          <div style="padding: 0.6rem; display: flex; flex-direction: column; gap: 2px; flex-grow: 1; justify-content: space-between;">
            <div style="font-weight: 700; font-size: 0.78rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-pure);" title="${c.card_name}">${escapeHtml(c.card_name)}</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
              <span style="font-size: 0.75rem; font-weight: 700; color: var(--color-secondary);">$${(c.price || 0.15).toFixed(2)}</span>
              <div style="display: flex; gap: 4px;" onclick="event.stopPropagation();">
                <button class="btn btn-secondary btn-sm" onclick="updateCardQty('${c.card_name}', '${c.scryfall_id || ''}', ${c.is_foil}, '${c.condition}', '${c.language}', ${c.quantity - 1})" style="width: 22px; height: 22px; padding:0; margin:0; font-size:0.8rem; font-weight:900; display:flex; align-items:center; justify-content:center;">-</button>
                <button class="btn btn-secondary btn-sm" onclick="updateCardQty('${c.card_name}', '${c.scryfall_id || ''}', ${c.is_foil}, '${c.condition}', '${c.language}', ${c.quantity + 1})" style="width: 22px; height: 22px; padding:0; margin:0; font-size:0.8rem; font-weight:900; display:flex; align-items:center; justify-content:center;">+</button>
                <button class="btn btn-gold btn-sm" onclick="openCardDetailsModal(${JSON.stringify(c).replace(/"/g, '&quot;')})" style="height: 22px; padding: 0 5px; margin: 0; font-size: 0.65rem; font-weight: 700;">Edit</button>
              </div>
            </div>
          </div>
        `;
        container.appendChild(cardEl);
      });
    } else {
      // List View rendering
      container.className = 'collection-card-list';
      if (cards.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 4rem 1rem; font-size: 0.85rem;">No cards found matching filters.</div>`;
        return;
      }

      cards.forEach(c => {
        const rowEl = document.createElement('div');
        rowEl.className = 'search-card-list-item';
        rowEl.style.padding = '0.5rem 1rem';
        rowEl.style.display = 'flex';
        rowEl.style.alignItems = 'center';
        rowEl.style.gap = '1rem';
        rowEl.style.background = 'var(--bg-card)';
        rowEl.style.border = '1px solid var(--border-light)';
        rowEl.style.borderRadius = 'var(--radius-sm)';

        const foilSpan = c.is_foil === 1 ? `<span style="background: linear-gradient(135deg, #d9a94e, #ec4899); color: white; font-size: 0.6rem; padding: 1px 4px; border-radius: 3px; font-weight: 800;">FOIL</span>` : '';
        const tradeSpan = c.is_for_trade === 1 ? `<span style="background: rgba(16,185,129,0.2); border: 1px solid #10b981; color: #10b981; font-size: 0.6rem; padding: 1px 4px; border-radius: 3px; font-weight: 800;">♻️ TRADE</span>` : '';

        rowEl.innerHTML = `
          <div style="font-weight: 800; color: var(--color-primary); font-size: 0.85rem; min-width: 24px;">x${c.quantity}</div>
          <div style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0; cursor: pointer;" onclick="if(window.openCardInspectorDrawer) window.openCardInspectorDrawer({ name: '${escapeSingleQuote(c.card_name)}', scryfallId: '${c.scryfall_id || ''}' })">
            <div style="font-weight: 700; color: var(--text-pure); display: flex; align-items: center; gap: 0.5rem;" data-card-name="${c.card_name}">
              <span class="card-item-name">${escapeHtml(c.card_name)}</span>
              ${foilSpan}
              ${tradeSpan}
            </div>
            <div style="font-size: 0.68rem; color: var(--text-muted);">${escapeHtml(c.type_line)}</div>
          </div>
          <div style="font-size: 0.72rem; color: var(--text-medium); min-width: 60px;">${escapeHtml(c.condition)} | ${escapeHtml(c.language)}</div>
          <div style="font-size: 0.8rem; font-weight: 700; color: var(--color-secondary); min-width: 60px; text-align: right;">$${(c.price || 0.15).toFixed(2)}</div>
          <div style="display: flex; gap: 4px;" onclick="event.stopPropagation();">
            <button class="btn btn-secondary btn-sm" onclick="updateCardQty('${c.card_name}', '${c.scryfall_id || ''}', ${c.is_foil}, '${c.condition}', '${c.language}', ${c.quantity - 1})" style="width: 22px; height: 22px; padding:0; margin:0; font-weight:900;">-</button>
            <button class="btn btn-secondary btn-sm" onclick="updateCardQty('${c.card_name}', '${c.scryfall_id || ''}', ${c.is_foil}, '${c.condition}', '${c.language}', ${c.quantity + 1})" style="width: 22px; height: 22px; padding:0; margin:0; font-weight:900;">+</button>
            <button class="btn btn-gold btn-sm" onclick="openCardDetailsModal(${JSON.stringify(c).replace(/"/g, '&quot;')})" style="height: 22px; padding: 0 5px; margin: 0; font-size: 0.65rem; font-weight: 700;">Edit</button>
          </div>
        `;
        container.appendChild(rowEl);
      });
    }
  }

  // Render Wants/Wishlist tab items
  function renderWishlist() {
    const container = document.getElementById('collection-cards-view');
    if (!container) return;
    container.innerHTML = '';
    container.className = 'collection-card-list';

    if (wishlistCards.length === 0) {
      container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 4rem 1rem; font-size: 0.85rem;">Your wishlist is empty! Add cards to hunt for them.</div>`;
      return;
    }

    wishlistCards.forEach(c => {
      const rowEl = document.createElement('div');
      rowEl.className = 'search-card-list-item';
      rowEl.style.padding = '0.5rem 1rem';
      rowEl.style.display = 'flex';
      rowEl.style.alignItems = 'center';
      rowEl.style.gap = '1rem';
      rowEl.style.background = 'var(--bg-card)';
      rowEl.style.border = '1px solid var(--border-light)';
      rowEl.style.borderRadius = 'var(--radius-sm)';

      rowEl.innerHTML = `
        <div style="font-weight: 800; color: var(--color-primary); font-size: 0.85rem; min-width: 24px;">x${c.quantity}</div>
        <div style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0; cursor: pointer;" onclick="if(window.openCardInspectorDrawer) window.openCardInspectorDrawer({ name: '${escapeSingleQuote(c.card_name)}', scryfallId: '${c.scryfall_id || ''}' })">
          <div style="font-weight: 700; color: var(--text-pure);" data-card-name="${c.card_name}">
            <span class="card-item-name">${escapeHtml(c.card_name)}</span>
          </div>
          <div style="font-size: 0.68rem; color: var(--text-muted);">${escapeHtml(c.type_line)}</div>
        </div>
        <div style="font-size: 0.8rem; font-weight: 700; color: var(--color-secondary); min-width: 60px; text-align: right;">$${(c.price || 0.15).toFixed(2)}</div>
        <div style="display: flex; gap: 4px;" onclick="event.stopPropagation();">
          <button class="btn btn-secondary btn-sm" onclick="addWishlistCardToCollection('${c.card_name}', '${c.scryfall_id || ''}')" style="height: 22px; padding: 0 8px; margin: 0; font-size: 0.65rem; font-weight: 700; border-color: #10b981; color: #10b981;" title="Mark as acquired and add to active collection">Acquired</button>
          <button class="btn btn-secondary btn-sm" onclick="deleteFromWishlist('${c.card_name}')" style="width: 22px; height: 22px; padding:0; margin:0; border-color: rgba(239, 68, 68, 0.4); color: #ef4444;" title="Delete from wishlist">🗑️</button>
        </div>
      `;
      container.appendChild(rowEl);
    });
  }

  // Quick increment/decrement qty handler
  window.updateCardQty = async function(cardName, scryfallId, isFoil, condition, language, newQty) {
    if (newQty <= 0) {
      // Expose stylish delete confirmation
      window.askStylishDeleteConfirmation(`Are you sure you want to remove Sol Ring from your binder?`, "DELETE", async () => {
        await deleteCollectionCard(cardName, scryfallId, isFoil, condition, language);
      });
      return;
    }

    try {
      const res = await fetch(`/api/collections/${activeCollectionId}/cards`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardName, scryfallId, isFoil, condition, language,
          newQuantity: newQty, newIsFoil: isFoil, newCondition: condition, newLanguage: language
        })
      });
      const data = await res.json();
      if (data.success) {
        await loadCollectionCards(activeCollectionId);
        await loadCollections(); // reload side values
      }
    } catch(e) {
      console.error(e);
    }
  };

  // Delete card from collection
  async function deleteCollectionCard(cardName, scryfallId, isFoil, condition, language) {
    try {
      const res = await fetch(`/api/collections/${activeCollectionId}/cards`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardName, scryfallId, isFoil, condition, language })
      });
      const data = await res.json();
      if (data.success) {
        await loadCollectionCards(activeCollectionId);
        await loadCollections();
      }
    } catch(e) {
      console.error(e);
    }
  }

  // Mark wishlist card as acquired and import to active collection
  window.addWishlistCardToCollection = async function(cardName, scryfallId) {
    if (activeCollectionId === 'wishlist') {
      // Find first physical collection binder to put it in
      const physicalColl = collections.find(c => c.id !== 'wishlist');
      if (!physicalColl) {
        alert("Please create a collection first.");
        return;
      }
      // Add card to collection binder (automatically decrements/deletes from wishlist)
      try {
        const res = await fetch(`/api/collections/${physicalColl.id}/cards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardName, scryfallId, quantity: 1 })
        });
        const data = await res.json();
        if (data.success) {
          await loadWishlist();
          await loadCollections();
        }
      } catch(e) {
        console.error(e);
      }
    }
  };

  // Delete card from wishlist
  window.deleteFromWishlist = async function(cardName) {
    try {
      const res = await fetch(`/api/wishlist/${encodeURIComponent(cardName)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        await loadWishlist();
      }
    } catch(e) {
      console.error(e);
    }
  };

  // Add Card Search Input Form handler
  window.addCardToActiveCollection = async function() {
    const cardName = searchInput.value.trim();
    if (!cardName) return;

    if (activeCollectionId === 'wishlist') {
      // Add to Wishlist
      try {
        const res = await fetch('/api/wishlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardName, quantity: 1 })
        });
        const data = await res.json();
        if (data.success) {
          searchInput.value = '';
          await loadWishlist();
        }
      } catch(e) {
        console.error(e);
      }
    } else {
      // Add to active Collection
      try {
        const res = await fetch(`/api/collections/${activeCollectionId}/cards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardName, quantity: 1 })
        });
        const data = await res.json();
        if (data.success) {
          searchInput.value = '';
          await loadCollectionCards(activeCollectionId);
          await loadCollections();
        }
      } catch(e) {
        console.error(e);
      }
    }
  };

  // Setup Event Listeners (Filter tags, modals, settings dropdowns, autocompletes)
  function setupEventListeners() {
    // Autocomplete events
    searchInput.addEventListener('input', () => {
      clearTimeout(autocompleteTimeout);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        suggestionsDiv.style.display = 'none';
        return;
      }

      autocompleteTimeout = setTimeout(async () => {
        try {
          const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(query)}`);
          const data = await res.json();
          const items = data.data || [];
          if (items.length > 0) {
            suggestionsDiv.innerHTML = '';
            items.forEach(item => {
              const div = document.createElement('div');
              div.style.padding = '0.5rem 1rem';
              div.style.cursor = 'pointer';
              div.style.fontSize = '0.78rem';
              div.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
              div.style.color = 'var(--text-pure)';
              
              div.onmouseover = function() { this.style.background = 'rgba(217, 169, 78, 0.15)'; };
              div.onmouseout = function() { this.style.background = 'transparent'; };
              
              div.textContent = item;
              div.onclick = () => {
                searchInput.value = item;
                suggestionsDiv.style.display = 'none';
                window.addCardToActiveCollection();
              };
              suggestionsDiv.appendChild(div);
            });
            suggestionsDiv.style.display = 'block';
          } else {
            suggestionsDiv.style.display = 'none';
          }
        } catch (e) {
          console.error("Autocomplete fetch failed:", e);
        }
      }, 180);
    });

    // Close autocomplete when clicking outside
    document.addEventListener('click', (e) => {
      if (e.target !== searchInput && e.target !== suggestionsDiv) {
        suggestionsDiv.style.display = 'none';
      }
    });

    // Enter key triggers add
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        window.addCardToActiveCollection();
      }
    });
  }

  // Toggle Color Filter Badge
  window.toggleColorFilter = function(color) {
    const idx = activeFilters.colors.indexOf(color);
    const btn = document.querySelector(`.color-badge[data-color="${color}"]`);
    if (idx === -1) {
      activeFilters.colors.push(color);
      if (btn) btn.style.opacity = '1';
    } else {
      activeFilters.colors.splice(idx, 1);
      if (btn) btn.style.opacity = '0.5';
    }
    applyFilters();
  };

  // Change Grid/List view mode layout
  window.changeViewMode = function(mode) {
    activeFilters.view = mode;
    
    const gridBtn = document.getElementById('btn-view-grid');
    const listBtn = document.getElementById('btn-view-list');
    
    if (mode === 'grid') {
      gridBtn.style.borderColor = 'var(--color-primary)';
      listBtn.style.borderColor = 'rgba(255,255,255,0.1)';
    } else {
      listBtn.style.borderColor = 'var(--color-primary)';
      gridBtn.style.borderColor = 'rgba(255,255,255,0.1)';
    }

    applyFilters();

    // Persist layout to active collection settings on server
    if (activeCollectionId && activeCollectionId !== 'wishlist' && activeCollectionId !== 'recovery') {
      const coll = collections.find(c => c.id === activeCollectionId);
      if (coll) {
        let settings = {};
        try { settings = JSON.parse(coll.settings || '{}'); } catch(e){}
        settings.view = mode;
        saveCollectionSettingsOnServer(activeCollectionId, settings);
      }
    }
  };

  // Helper: Save updated settings directly to DB
  async function saveCollectionSettingsOnServer(id, settings) {
    try {
      await fetch(`/api/collections/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings })
      });
    } catch(e){ console.error(e); }
  }

  // MODAL CONTROLS: New Collection Modal
  window.openNewCollectionModal = function() {
    const modal = document.getElementById('new-collection-modal');
    modal.classList.add('active');
    modal.style.display = 'flex';
    document.getElementById('new-coll-name').value = '';
    selectThemeOption('purple');
  };

  window.closeNewCollectionModal = function() {
    const modal = document.getElementById('new-collection-modal');
    modal.classList.remove('active');
    modal.style.display = 'none';
  };

  let newCollTheme = 'purple';
  window.selectThemeOption = function(theme, isEdit = false) {
    const parentId = isEdit ? 'edit-theme-picker' : 'new-collection-modal';
    const parent = document.getElementById(parentId);
    parent.querySelectorAll('.theme-picker-option').forEach(btn => {
      btn.classList.remove('active');
      if (btn.dataset.theme === theme) btn.classList.add('active');
    });
    
    if (isEdit) {
      editCollTheme = theme;
    } else {
      newCollTheme = theme;
    }
  };

  window.submitNewCollection = async function() {
    const name = document.getElementById('new-coll-name').value.trim();
    if (!name) {
      alert("Please enter a collection name.");
      return;
    }
    const sort = document.getElementById('new-coll-sort').value;
    const view = document.getElementById('new-coll-view').value;
    const isPublic = document.getElementById('new-coll-public').checked;
    const suggestions = document.getElementById('new-coll-suggestions').checked;

    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          settings: { theme: newCollTheme, sort, view, public: isPublic, suggestions }
        })
      });
      const data = await res.json();
      if (data.success) {
        closeNewCollectionModal();
        activeCollectionId = data.collectionId;
        await loadCollections();
      }
    } catch(e) {
      console.error(e);
    }
  };

  // MODAL CONTROLS: Collection Settings Modal
  window.openCollectionSettingsModal = function() {
    if (!activeCollectionId || activeCollectionId === 'wishlist' || activeCollectionId === 'recovery') return;
    const coll = collections.find(c => c.id === activeCollectionId);
    if (!coll) return;

    let settings = {};
    try { settings = JSON.parse(coll.settings || '{}'); } catch(e){}

    const modal = document.getElementById('collection-settings-modal');
    modal.classList.add('active');
    modal.style.display = 'flex';

    document.getElementById('edit-coll-name').value = coll.name;
    document.getElementById('edit-coll-sort').value = settings.sort || 'name';
    document.getElementById('edit-coll-view').value = settings.view || 'grid';
    document.getElementById('edit-coll-public').checked = settings.public !== false;
    document.getElementById('edit-coll-suggestions').checked = settings.suggestions !== false;

    selectThemeOption(settings.theme || 'purple', true);
  };

  window.closeCollectionSettingsModal = function() {
    const modal = document.getElementById('collection-settings-modal');
    modal.classList.remove('active');
    modal.style.display = 'none';
  };

  let editCollTheme = 'purple';
  window.submitCollectionSettings = async function() {
    const name = document.getElementById('edit-coll-name').value.trim();
    if (!name) {
      alert("Please enter a name.");
      return;
    }
    const sort = document.getElementById('edit-coll-sort').value;
    const view = document.getElementById('edit-coll-view').value;
    const isPublic = document.getElementById('edit-coll-public').checked;
    const suggestions = document.getElementById('edit-coll-suggestions').checked;

    try {
      const res = await fetch(`/api/collections/${activeCollectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          settings: { theme: editCollTheme, sort, view, public: isPublic, suggestions }
        })
      });
      const data = await res.json();
      if (data.success) {
        closeCollectionSettingsModal();
        await loadCollections();
      }
    } catch(e) {
      console.error(e);
    }
  };

  // DELETE Active Collection (with custom DELETE confirmation modal)
  window.deleteActiveCollection = async function() {
    if (!activeCollectionId || activeCollectionId === 'wishlist' || activeCollectionId === 'recovery') return;
    const coll = collections.find(c => c.id === activeCollectionId);
    if (!coll) return;

    window.askStylishDeleteConfirmation(
      `Are you sure you want to delete the collection "${coll.name}"? This will delete all cards inside it.`,
      "DELETE",
      async () => {
        try {
          const res = await fetch(`/api/collections/${activeCollectionId}`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (data.success) {
            activeCollectionId = null;
            await loadCollections();
          }
        } catch(e) {
          console.error(e);
        }
      }
    );
  };

  // MODAL CONTROLS: Edit Card Details Modal
  window.openCardDetailsModal = function(card) {
    activeEditCard = card;
    const modal = document.getElementById('card-details-modal');
    modal.classList.add('active');
    modal.style.display = 'flex';

    document.getElementById('details-card-name-title').textContent = card.card_name;
    document.getElementById('edit-card-quantity').value = card.quantity;
    document.getElementById('edit-card-condition').value = card.condition || 'NM';
    document.getElementById('edit-card-language').value = card.language || 'EN';
    document.getElementById('edit-card-price').value = card.purchase_price !== null ? card.purchase_price : '';
    document.getElementById('edit-card-foil').checked = card.is_foil === 1;
    document.getElementById('edit-card-trade').checked = card.is_for_trade === 1;
  };

  window.closeCardDetailsModal = function() {
    const modal = document.getElementById('card-details-modal');
    modal.classList.remove('active');
    modal.style.display = 'none';
    activeEditCard = null;
  };

  window.submitCardDetailsUpdate = async function() {
    if (!activeEditCard) return;

    const qty = parseInt(document.getElementById('edit-card-quantity').value, 10);
    if (isNaN(qty) || qty <= 0) {
      alert("Quantity must be greater than 0.");
      return;
    }
    const cond = document.getElementById('edit-card-condition').value;
    const lang = document.getElementById('edit-card-language').value;
    const priceInput = document.getElementById('edit-card-price').value;
    const price = priceInput !== '' ? parseFloat(priceInput) : null;
    const foil = document.getElementById('edit-card-foil').checked;
    const trade = document.getElementById('edit-card-trade').checked;

    try {
      const res = await fetch(`/api/collections/${activeCollectionId}/cards`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardName: activeEditCard.card_name,
          scryfallId: activeEditCard.scryfall_id || '',
          isFoil: activeEditCard.is_foil,
          condition: activeEditCard.condition,
          language: activeEditCard.language,
          newQuantity: qty,
          newIsFoil: foil,
          newIsForTrade: trade,
          newCondition: cond,
          newLanguage: lang,
          newPurchasePrice: price
        })
      });
      const data = await res.json();
      if (data.success) {
        closeCardDetailsModal();
        await loadCollectionCards(activeCollectionId);
        await loadCollections();
      }
    } catch(e) {
      console.error(e);
    }
  };

  // STYLISH DELETE CONFIRMATION MODAL LOGIC
  let deleteCallback = null;
  window.askStylishDeleteConfirmation = function(messageText, matchWord, onConfirm) {
    const modal = document.getElementById('delete-confirm-modal');
    const textEl = document.getElementById('delete-confirm-text');
    const inputEl = document.getElementById('delete-confirm-input');
    const submitBtn = document.getElementById('btn-delete-confirm-submit');

    textEl.innerHTML = `${messageText}<br><br>To confirm, type <strong style="color: var(--text-pure); font-weight:800;">${matchWord}</strong> in the field below.`;
    inputEl.value = '';
    submitBtn.disabled = true;
    deleteCallback = onConfirm;

    modal.classList.add('active');
    modal.style.display = 'flex';

    inputEl.oninput = function() {
      submitBtn.disabled = (inputEl.value.trim().toUpperCase() !== matchWord.toUpperCase());
    };

    submitBtn.onclick = function() {
      if (deleteCallback) deleteCallback();
      window.closeDeleteConfirmModal();
    };
  };

  window.closeDeleteConfirmModal = function() {
    const modal = document.getElementById('delete-confirm-modal');
    modal.classList.remove('active');
    modal.style.display = 'none';
    deleteCallback = null;
  };

  // Helper sanitization
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function escapeSingleQuote(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'");
  }

})();
