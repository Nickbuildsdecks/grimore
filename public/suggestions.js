(function() {
  // Top progress bar and global progress overlay helpers
  window.startTopProgress = function() {
    const bar = document.getElementById('top-progress-bar');
    if (!bar) return;
    bar.style.transition = 'transform 0.4s ease, opacity 0.3s ease';
    bar.style.transform = 'scaleX(0)';
    bar.style.opacity = '1';
    setTimeout(() => {
      bar.style.transform = 'scaleX(0.35)';
      setTimeout(() => {
        bar.style.transform = 'scaleX(0.75)';
      }, 500);
    }, 50);
  };

  window.completeTopProgress = function() {
    const bar = document.getElementById('top-progress-bar');
    if (!bar) return;
    bar.style.transform = 'scaleX(1)';
    setTimeout(() => {
      bar.style.opacity = '0';
      setTimeout(() => {
        bar.style.transform = 'scaleX(0)';
      }, 300);
    }, 200);
  };

  // Toast Notification Helper
  window.showToast = function(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.style.cssText = 'background: rgba(18, 16, 28, 0.92); backdrop-filter: blur(12px); border: 1px solid rgba(168, 85, 247, 0.35); border-left: 4px solid var(--color-primary); color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 0.8rem; font-weight: 700; box-shadow: 0 8px 24px rgba(0,0,0,0.5); pointer-events: auto; display: flex; align-items: center; gap: 8px; transform: translateY(20px); opacity: 0; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);';
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.transform = 'translateY(0)';
      toast.style.opacity = '1';
    });
    setTimeout(() => {
      toast.style.transform = 'translateY(-10px)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  };

  // Category Icon Mapping for Grimore Functional Auto-Tagging Engine (No Emojis)
  const CATEGORY_ICONS = {
    'owned-suggestions': '',
    'wincons': '',
    'tutors': '',
    'stax': '',
    'mass-removal': '',
    'single-target-removal': '',
    'protection': '',
    'ramp': '',
    'card-advantage': '',
    'card-selection': '',
    'recursion': '',
    'reanimation': '',
    'graveyard-fillers': '',
    'sacrifice-outlets': '',
    'tokens-swarm': '',
    'counters-triggers': '',
    'equipment-auras': '',
    'artifact-engine': '',
    'enchantments': '',
    'blink-etb': '',
    'spellslinger': '',
    'landfall': '',
    'utility-lands': '',
    'lands': '',
    'unique': ''
  };

  // State Variables
  const urlParams = new URLSearchParams(window.location.search);
  const deckId = urlParams.get('deckId');

  if (!deckId) {
    alert("No deck selected. Returning to dashboard.");
    window.location.href = 'index.html';
    return;
  }

  // Update return to builder links
  const returnLink = document.getElementById('btn-return-deck-link');
  if (returnLink) returnLink.href = `index.html?deckId=${deckId}`;
  const returnLogo = document.getElementById('btn-return-to-deck');
  if (returnLogo) returnLogo.href = `index.html?deckId=${deckId}`;

  let currentUser = null;
  let currentSuggestionsMode = 'function'; // 'function' or 'type'
  let rawFunctionalCategories = [];
  let rawTypeCategories = [];
  let categories = [];
  let selectedCategoryTag = null;
  
  let searchQuery = '';
  let activeFilter = 'all'; // 'all', 'owned', 'budget'
  let activeSort = 'price-asc'; // 'price-asc', 'price-desc', 'name'

  let activeInspectorCard = null;
  let lastInspectorTrigger = null;
  let currentCardFaceIdx = 0;
  let suggestionsZoomed = false;

  window.currentCategoryCards = []; // In-memory cards array for current view

  // Switch between Type and Function suggestion modes
  window.setSuggestionsMode = function(mode) {
    if (currentSuggestionsMode === mode) return;
    currentSuggestionsMode = mode;

    const btnType = document.getElementById('mode-btn-type');
    const btnFunction = document.getElementById('mode-btn-function');

    if (mode === 'type') {
      if (btnType) {
        btnType.style.background = 'linear-gradient(135deg, rgba(168, 85, 247, 0.85) 0%, rgba(126, 34, 206, 0.95) 100%)';
        btnType.style.color = '#ffffff';
        btnType.style.boxShadow = '0 2px 10px rgba(168, 85, 247, 0.4)';
      }
      if (btnFunction) {
        btnFunction.style.background = 'transparent';
        btnFunction.style.color = 'var(--text-muted)';
        btnFunction.style.boxShadow = 'none';
      }
      categories = rawTypeCategories;
    } else {
      if (btnFunction) {
        btnFunction.style.background = 'linear-gradient(135deg, rgba(168, 85, 247, 0.85) 0%, rgba(126, 34, 206, 0.95) 100%)';
        btnFunction.style.color = '#ffffff';
        btnFunction.style.boxShadow = '0 2px 10px rgba(168, 85, 247, 0.4)';
      }
      if (btnType) {
        btnType.style.background = 'transparent';
        btnType.style.color = 'var(--text-muted)';
        btnType.style.boxShadow = 'none';
      }
      categories = rawFunctionalCategories;
    }

    if (categories.length > 0) {
      selectedCategoryTag = categories[0].tag;
    } else {
      selectedCategoryTag = null;
    }

    renderCategoriesSidebar();

    if (selectedCategoryTag) {
      const firstItem = document.querySelector(`.filters-sidebar-group[data-tag="${selectedCategoryTag}"]`);
      selectCategory(selectedCategoryTag, firstItem);
    }
  };

  // Initialize Page
  document.addEventListener('DOMContentLoaded', async () => {
    window.startTopProgress();
    const authed = await checkAuthStatus();
    if (!authed) {
      window.completeTopProgress();
      alert("Please log in to view suggestions.");
      window.location.href = 'index.html';
      return;
    }
    if (localStorage.getItem('theme-mode') === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }

    // Attach search input listener
    const searchInput = document.getElementById('suggestions-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        refreshCurrentCategoryView();
      });
    }

    await Promise.all([
      loadDeckDetails(),
      loadSuggestions()
    ]);
    window.completeTopProgress();
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

  // Fetch target deck data and its cards
  async function loadDeckDetails() {
    try {
      // Get deck metadata
      const resDecks = await fetch('/api/decks/my-decks');
      const decks = await resDecks.json();
      activeDeckData = decks.find(d => d.id === deckId);

      if (activeDeckData) {
        document.getElementById('active-deck-name-display').textContent = activeDeckData.deck_name;
      } else {
        document.getElementById('active-deck-name-display').textContent = "Unknown Deck";
      }

      // Get current deck cards
      const resCards = await fetch(`/api/decks/${deckId}/cards`);
      const cardList = await resCards.json();

      // Resolve commander and mainboard
      activeDeckCommander = cardList.filter(c => c.is_commander === 1).map(c => ({
        name: c.card_name,
        quantity: c.quantity || 1,
        qty: c.quantity || 1,
        scryfallId: c.scryfall_id || null,
        price: c.cheapest_card_price || 0.15,
        custom_tag: c.custom_tag
      }));
      activeDeckMainboard = cardList.filter(c => c.is_commander !== 1).map(c => ({
        name: c.card_name,
        quantity: c.quantity || 1,
        qty: c.quantity || 1,
        scryfallId: c.scryfall_id || null,
        price: c.cheapest_card_price || 0.15,
        custom_tag: c.custom_tag
      }));
    } catch (e) {
      console.error("Error loading deck details:", e);
    }
  }

  // Fetch suggestions from backend
  async function loadSuggestions() {
    try {
      const grid = document.getElementById('suggestions-grid');
      const catsList = document.getElementById('categories-list');

      const res = await fetch(`/api/decks/${deckId}/suggestions`);
      const data = await res.json();

      if (data.error) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4rem 1rem; text-align: center; gap: 0.75rem;">
            <div style="font-size: 1.5rem;">⚠️</div>
            <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-high);">${data.error}</div>
            <div style="font-size: 0.72rem; color: var(--text-muted); max-width: 320px;">
              Suggestions are based on the commander cards registered inside your deck builder. Make sure to tag your commander!
            </div>
          </div>
        `;
        catsList.innerHTML = `<div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.75rem;">No commander defined</div>`;
        return;
      }

      // Update Commander header avatar & title display
      if (data.commanderName) {
        const cmdNameDisplay = document.getElementById('commander-name-display');
        if (cmdNameDisplay) cmdNameDisplay.textContent = data.commanderName;
      }
      if (data.commanderScryfallId) {
        const cmdImg = document.getElementById('commander-avatar-img');
        if (cmdImg) {
          cmdImg.src = `https://cards.scryfall.io/art_crop/front/${data.commanderScryfallId[0]}/${data.commanderScryfallId[1]}/${data.commanderScryfallId}.jpg`;
        }
      }

      rawFunctionalCategories = data.functionalCategories || data.categories || [];
      rawTypeCategories = data.typeCategories || [];

      categories = currentSuggestionsMode === 'type' ? rawTypeCategories : rawFunctionalCategories;
      const totalCatBadge = document.getElementById('total-categories-count');
      if (totalCatBadge) totalCatBadge.textContent = categories.length;

      if (categories.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4rem 1rem; text-align: center; gap: 0.75rem;">
            <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-high);">No suggestions found</div>
            <div style="font-size: 0.72rem; color: var(--text-muted); max-width: 320px;">EDHREC returned no recommendations for this commander.</div>
          </div>
        `;
        catsList.innerHTML = `<div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.75rem;">No categories</div>`;
        return;
      }

      if (categories.length > 0) {
        selectedCategoryTag = categories[0].tag;
      }

      renderCategoriesSidebar();

      if (selectedCategoryTag) {
        const firstItem = document.querySelector(`.filters-sidebar-group[data-tag="${selectedCategoryTag}"]`);
        selectCategory(selectedCategoryTag, firstItem);
      }

    } catch (e) {
      console.error("Error loading suggestions:", e);
    }
  }

  // Populate categories sidebar with counts that filter out existing cards (No Emojis)
  function renderCategoriesSidebar() {
    const catsList = document.getElementById('categories-list');
    if (!catsList) return;
    catsList.innerHTML = '';

    categories.forEach((cat) => {
      const filteredCount = cat.cards.filter(card => {
        const inMainboard = activeDeckMainboard.some(c => c.name.toLowerCase() === card.name.toLowerCase());
        const inCommander = activeDeckCommander.some(c => c.name.toLowerCase() === card.name.toLowerCase());
        return !inMainboard && !inCommander;
      }).length;

      const item = document.createElement('div');
      item.className = 'filters-sidebar-group';
      item.dataset.tag = cat.tag;
      item.style.cssText = 'padding: 0.55rem 0.85rem; cursor: pointer; border-radius: 6px; font-size: 0.76rem; font-weight: 700; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); margin-bottom: 3px; letter-spacing: 0.03em;';

      if (cat.tag === selectedCategoryTag) {
        item.style.background = 'linear-gradient(135deg, rgba(168, 85, 247, 0.22) 0%, rgba(126, 34, 206, 0.28) 100%)';
        item.style.color = '#ffffff';
        item.style.border = '1px solid rgba(168, 85, 247, 0.45)';
        item.style.boxShadow = '0 2px 10px rgba(168, 85, 247, 0.25)';
      } else {
        item.style.background = 'rgba(255, 255, 255, 0.02)';
        item.style.color = 'var(--text-muted)';
        item.style.border = '1px solid transparent';
        item.style.boxShadow = 'none';
      }

      item.onmouseenter = () => {
        if (cat.tag !== selectedCategoryTag) {
          item.style.background = 'rgba(168, 85, 247, 0.08)';
          item.style.color = 'var(--text-high)';
        }
      };
      item.onmouseleave = () => {
        if (cat.tag !== selectedCategoryTag) {
          item.style.background = 'rgba(255, 255, 255, 0.02)';
          item.style.color = 'var(--text-muted)';
        }
      };

      item.innerHTML = `
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase;">
          ${cat.header}
        </span>
        <span class="category-badge" style="background: rgba(168, 85, 247, 0.18); color: var(--color-primary); font-size: 0.68rem; padding: 2px 8px; border-radius: 10px; font-weight: 800; flex-shrink: 0;">${filteredCount}</span>
      `;

      item.onclick = () => selectCategory(cat.tag, item);
      catsList.appendChild(item);
    });
  }

  // Filter and Sort card processing logic
  function processCards(rawCards) {
    let list = rawCards.filter(card => {
      const inMainboard = activeDeckMainboard.some(c => c.name.toLowerCase() === card.name.toLowerCase());
      const inCommander = activeDeckCommander.some(c => c.name.toLowerCase() === card.name.toLowerCase());
      return !inMainboard && !inCommander;
    });

    // Apply Live Search Query Filter
    if (searchQuery) {
      list = list.filter(c => c.name.toLowerCase().includes(searchQuery));
    }

    // Apply Quick Filter Pills
    if (activeFilter === 'owned') {
      list = list.filter(c => c.owned === true);
    } else if (activeFilter === 'budget') {
      list = list.filter(c => c.price <= 2.00);
    }

    // Apply Sorting
    list.sort((a, b) => {
      if (activeSort === 'price-asc') {
        return (a.price || 0) - (b.price || 0);
      } else if (activeSort === 'price-desc') {
        return (b.price || 0) - (a.price || 0);
      } else if (activeSort === 'name') {
        return a.name.localeCompare(b.name);
      }
      return 0;
    });

    return list;
  }

  // Handle category selection
  function selectCategory(tag, element) {
    selectedCategoryTag = tag;

    // Highlight category in sidebar
    const items = document.querySelectorAll('#categories-list > div');
    items.forEach(item => {
      item.style.background = 'transparent';
      item.style.color = 'var(--text-muted)';
      item.style.outline = 'none';
    });

    if (element) {
      element.style.background = 'rgba(168, 85, 247, 0.15)';
      element.style.color = 'var(--text-pure)';
      element.style.outline = '1px solid var(--color-primary)';
      element.style.outlineOffset = '-1px';
    } else {
      const targetEl = document.querySelector(`.filters-sidebar-group[data-tag="${tag}"]`);
      if (targetEl) {
        targetEl.style.background = 'rgba(168, 85, 247, 0.15)';
        targetEl.style.color = 'var(--text-pure)';
        targetEl.style.outline = '1px solid var(--color-primary)';
        targetEl.style.outlineOffset = '-1px';
      }
    }

    refreshCurrentCategoryView();
  }

  // Refresh current category view with applied filters & sort
  function refreshCurrentCategoryView() {
    const cat = categories.find(c => c.tag === selectedCategoryTag);
    if (!cat) return;

    const catTitleEl = document.getElementById('current-category-title');
    if (catTitleEl) catTitleEl.innerHTML = `<span id="current-category-icon" style="display:none;"></span> ${cat.header}`;

    const processedCards = processCards(cat.cards);

    const countEl = document.getElementById('current-category-count');
    if (countEl) countEl.textContent = `${processedCards.length} recommendations shown`;

    renderCardsGrid(processedCards);
  }

  // Quick Filter Pill Switcher
  window.setSuggestionsFilter = function(filterType) {
    activeFilter = filterType;
    ['all', 'owned', 'budget'].forEach(f => {
      const btn = document.getElementById(`filter-btn-${f}`);
      if (btn) {
        if (f === filterType) {
          btn.style.background = 'rgba(168,85,247,0.3)';
          btn.style.color = '#fff';
          btn.classList.add('active-filter-pill');
        } else {
          btn.style.background = 'transparent';
          btn.style.color = 'var(--text-muted)';
          btn.classList.remove('active-filter-pill');
        }
      }
    });
    refreshCurrentCategoryView();
  };

  // Sort Switcher
  window.setSuggestionsSort = function(sortType) {
    activeSort = sortType;
    refreshCurrentCategoryView();
  };

  // Zoom Toggle Switcher
  window.toggleSuggestionsZoom = function() {
    suggestionsZoomed = !suggestionsZoomed;
    const btn = document.getElementById('btn-zoom-toggle');
    if (btn) {
      if (suggestionsZoomed) {
        btn.textContent = '🔍 Zoom Out';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
      } else {
        btn.textContent = '🔍 Zoom In';
        btn.classList.add('btn-secondary');
        btn.classList.remove('btn-primary');
      }
    }
    refreshCurrentCategoryView();
  };

  // Add suggestion by array index in memory
  window.addSuggestionByIndex = function(index, event, buttonEl) {
    if (event) event.stopPropagation();
    const card = window.currentCategoryCards && window.currentCategoryCards[index];
    if (card) {
      window.addSuggestionToDeck(card, buttonEl);
    } else {
      console.error("Card not found at index", index);
    }
  };

  // Render cards grid
  function renderCardsGrid(cards) {
    const grid = document.getElementById('suggestions-grid');
    if (!grid) return;
    grid.innerHTML = '';

    window.currentCategoryCards = cards; // Store in memory for clean index-based click handling

    if (cards.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4rem 1rem; text-align: center; gap: 0.75rem;">
          <div style="font-size: 1.5rem;">🔍</div>
          <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-high);">No matching cards</div>
          <div style="font-size: 0.72rem; color: var(--text-muted); max-width: 320px;">Try loosening your search query or filter options.</div>
        </div>
      `;
      return;
    }

    const isMobile = window.innerWidth <= 480;
    const isTablet = window.innerWidth <= 768 && window.innerWidth > 480;

    grid.style.display = 'grid';
    grid.style.alignItems = 'start';
    grid.style.gridAutoRows = 'max-content';

    if (isMobile) {
      grid.style.gridTemplateColumns = suggestionsZoomed ? 'repeat(1, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))';
      grid.style.gap = suggestionsZoomed ? '0.5rem' : '0.35rem';
    } else if (isTablet) {
      grid.style.gridTemplateColumns = suggestionsZoomed ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))';
      grid.style.gap = suggestionsZoomed ? '0.6rem' : '0.45rem';
    } else {
      grid.style.gridTemplateColumns = suggestionsZoomed ? 'repeat(6, minmax(0, 1fr))' : 'repeat(10, minmax(0, 1fr))';
      grid.style.gap = suggestionsZoomed ? '0.75rem' : '0.5rem';
    }

    cards.forEach((card, index) => {
      const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
      const imgUrl = card.scryfallId 
        ? `https://cards.scryfall.io/normal/front/${card.scryfallId[0]}/${card.scryfallId[1]}/${card.scryfallId}.jpg` 
        : fallbackUrl;

      const cardEl = document.createElement('div');
      cardEl.className = 'search-card-item';
      cardEl.style.cssText = 'position: relative !important; border-radius: 8px !important; overflow: hidden !important; background: rgba(12, 13, 20, 0.5) !important; border: 1px solid rgba(168, 85, 247, 0.2) !important; transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s ease, border-color 0.2s ease !important; cursor: pointer !important; width: 100% !important; display: flex !important; flex-direction: column !important; box-sizing: border-box !important; container-type: inline-size; backdrop-filter: blur(8px);';

      cardEl.onmouseover = function() {
        this.style.transform = 'translateY(-4px)';
        this.style.boxShadow = '0 8px 24px rgba(168, 85, 247, 0.25)';
        this.style.borderColor = 'rgba(168, 85, 247, 0.45)';
      };
      cardEl.onmouseout = function() {
        this.style.transform = 'none';
        this.style.boxShadow = 'none';
        this.style.borderColor = 'rgba(168, 85, 247, 0.2)';
      };

      cardEl.onclick = function() {
        window.openInspector(card);
      };

      // Check quantity in target deck
      const qtyInTarget = activeDeckMainboard.reduce((acc, c) => c.name.toLowerCase() === card.name.toLowerCase() ? acc + c.quantity : acc, 0) +
                          activeDeckCommander.reduce((acc, c) => c.name.toLowerCase() === card.name.toLowerCase() ? acc + c.quantity : acc, 0);

      const inDeckBadge = qtyInTarget > 0 ? `
        <div style="position: absolute; top: 6px; left: 6px; background: rgba(245, 158, 11, 0.95) !important; border: 1px solid rgba(245, 158, 11, 0.4) !important; color: white !important; font-family: 'Outfit', sans-serif !important; font-size: 0.62rem !important; font-weight: 800 !important; padding: 2px 6px !important; border-radius: 4px !important; box-shadow: 0 2px 6px rgba(0,0,0,0.5) !important; z-index: 5 !important; text-transform: uppercase !important; pointer-events: none !important;">
          ${qtyInTarget} in Deck
        </div>
      ` : '';

      const ownedBadge = card.owned ? `
        <div style="position: absolute; top: 6px; right: 6px; background: rgba(16, 185, 129, 0.95) !important; border: 1px solid rgba(16, 185, 129, 0.4) !important; color: white !important; font-family: 'Outfit', sans-serif !important; font-size: 0.62rem !important; font-weight: 800 !important; padding: 2px 6px !important; border-radius: 4px !important; box-shadow: 0 2px 6px rgba(0,0,0,0.5) !important; z-index: 5 !important; text-transform: uppercase !important; pointer-events: none !important;">
          💎 Owned
        </div>
      ` : '';

      cardEl.innerHTML = `
        ${inDeckBadge}
        ${ownedBadge}
        <div style="width: 100% !important; aspect-ratio: 2.5/3.5 !important; overflow: hidden !important; position: relative !important;" data-card-name="${card.name}">
          <img src="${imgUrl}" alt="${card.name}" loading="lazy" style="width: 100% !important; height: 100% !important; object-fit: contain !important; transition: transform 0.2s ease !important; display: block !important;"
               onmouseover="this.style.transform='scale(1.04)'"
               onmouseout="this.style.transform='none'"
               onerror="this.src='logo.svg'">
        </div>
        <!-- Footer row with Add Button & Price Badge -->
        <div style="display: flex !important; align-items: center !important; gap: 4cqw !important; padding: 4cqw !important; background: rgba(12, 13, 20, 0.92) !important; border-top: 1px solid rgba(168, 85, 247, 0.2) !important; box-sizing: border-box !important; width: 100% !important;" onclick="event.stopPropagation();">
          <button type="button" class="btn btn-primary" onclick="window.addSuggestionByIndex(${index}, event, this)" style="width: 18cqw !important; height: 18cqw !important; padding: 0 !important; font-size: 10cqw !important; display: flex !important; align-items: center !important; justify-content: center !important; font-weight: 800 !important; border-radius: 50% !important; margin: 0 !important; border: 1px solid rgba(255,255,255,0.25) !important; background: var(--color-primary) !important; color: white !important; box-shadow: 0 2px 8px rgba(0,0,0,0.6) !important; cursor: pointer !important; transition: transform 0.15s ease;" onmouseover="this.style.transform='scale(1.18)'" onmouseout="this.style.transform='none'" title="Add to target deck">+</button>
          <div style="background: rgba(12, 13, 20, 0.85) !important; border: 1px solid rgba(168, 85, 247, 0.35) !important; padding: 0 4cqw !important; border-radius: 3cqw !important; display: flex !important; align-items: center !important; height: 18cqw !important; box-sizing: border-box !important; justify-content: center !important;">
            <span style="font-size: 7cqw !important; color: var(--color-secondary) !important; font-weight: 700 !important; white-space: nowrap !important;">$${Number(card.price || 0.15).toFixed(2)}</span>
          </div>
        </div>
      `;
      grid.appendChild(cardEl);
    });
  }

  // Add card to target deck list
  window.addSuggestionToDeck = async function(card, buttonEl) {
    // Update memory deck state immediately
    const existing = activeDeckMainboard.find(c => c.name.toLowerCase() === card.name.toLowerCase());
    if (existing) {
      existing.quantity = (existing.quantity || existing.qty || 0) + 1;
      existing.qty = existing.quantity;
    } else {
      activeDeckMainboard.push({
        name: card.name,
        quantity: 1,
        qty: 1,
        scryfallId: card.scryfallId || null,
        price: card.price || 0.15
      });
    }

    // Immediately trigger instant UI updates (0ms delay)
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = '✓';
      buttonEl.style.background = 'var(--color-success)';
      buttonEl.style.color = '#fff';
    }

    window.showToast(`Added <strong>${card.name}</strong> to mainboard`);
    renderCategoriesSidebar();
    refreshCurrentCategoryView();

    // Fire atomic card addition to server asynchronously (~50 bytes payload)
    fetch(`/api/decks/${encodeURIComponent(deckId)}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: card.name,
        price: card.price || 0.15,
        scryfallId: card.scryfallId || null
      })
    }).then(res => res.json()).then(saveResult => {
      if (saveResult.error) {
        window.showToast(`⚠️ Failed to save ${card.name}: ${saveResult.error}`);
      }
    }).catch(e => {
      console.error("Atomic card save error:", e);
    });
  };

  // ── INSPECTOR DRAWER ────────────────────────────────────────────────
  let selectedInspectorPrinting = null;

  window.openInspector = async function(card) {
    lastInspectorTrigger = document.activeElement;
    activeInspectorCard = card;
    currentCardFaceIdx = 0;
    selectedInspectorPrinting = {
      name: card.name,
      price: card.price || 0.15,
      scryfallId: card.scryfallId || null,
      type_line: card.type_line || 'Card',
      colors: card.colors || [],
      rarity: card.rarity || 'common'
    };

    // Reset Add to Deck button style
    const addBtn = document.getElementById('inspector-add-to-deck-btn');
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.textContent = '➕ Add Selected Printing to Deck';
      addBtn.style.background = '';
      addBtn.style.color = '';
    }

    const drawer = document.getElementById('card-inspector-drawer');
    drawer.removeAttribute('inert');
    drawer.removeAttribute('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('open');
    const closeButton = drawer.querySelector('.drawer-close');
    if (closeButton) closeButton.focus({ preventScroll: true });

    document.getElementById('inspector-card-name').textContent = card.name;
    document.getElementById('inspector-type').textContent = card.type_line;
    document.getElementById('inspector-price').textContent = `$${Number(card.price).toFixed(2)}`;

    const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
    const imgUrl = card.scryfallId 
      ? `https://cards.scryfall.io/normal/front/${card.scryfallId[0]}/${card.scryfallId[1]}/${card.scryfallId}.jpg` 
      : fallbackUrl;
    document.getElementById('inspector-card-img').src = imgUrl;

    // Check if card is double faced by checking name structure (e.g. "//")
    const isDoubleFaced = card.name.includes('//');
    document.getElementById('inspector-flip-overlay').style.display = isDoubleFaced ? 'flex' : 'none';

    // Clear and load print versions & rulings
    document.getElementById('inspector-version-list').innerHTML = `<div style="font-size:0.7rem; color:var(--text-muted); text-align:center; padding:0.5rem 0;">Loading variants...</div>`;
    document.getElementById('inspector-rulings-list').innerHTML = `<div style="font-size:0.7rem; color:var(--text-muted); text-align:center; padding:0.5rem 0;">Loading rulings...</div>`;

    await Promise.all([
      loadCardVersions(card.name),
      card.scryfallId ? loadCardRulings(card.scryfallId) : Promise.resolve()
    ]);
  };

  window.closeInspectorDrawer = function() {
    const drawer = document.getElementById('card-inspector-drawer');
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
      drawer.setAttribute('inert', '');
      drawer.setAttribute('hidden', '');
    }
    activeInspectorCard = null;
    if (lastInspectorTrigger && lastInspectorTrigger.isConnected) {
      lastInspectorTrigger.focus({ preventScroll: true });
    }
    lastInspectorTrigger = null;
  };

  window.toggleInspectorCardFace = function() {
    if (!activeInspectorCard) return;
    currentCardFaceIdx = currentCardFaceIdx === 0 ? 1 : 0;
    const imgElement = document.getElementById('inspector-card-img');
    const scryfallId = activeInspectorCard.scryfallId;

    if (scryfallId) {
      const side = currentCardFaceIdx === 1 ? 'back' : 'front';
      imgElement.src = `https://cards.scryfall.io/normal/${side}/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
    } else {
      imgElement.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(activeInspectorCard.name)}&format=image&version=normal${currentCardFaceIdx === 1 ? '&face=back' : ''}`;
    }
  };

  async function loadCardVersions(cardName) {
    try {
      const res = await fetch(`/api/cards/versions?name=${encodeURIComponent(cardName)}`);
      const data = await res.json();
      const listEl = document.getElementById('inspector-version-list');

      if (data.error || !Array.isArray(data) || data.length === 0) {
        listEl.innerHTML = `<div style="font-size: 0.7rem; color: var(--text-muted); text-align: center; padding: 0.5rem 0;">No printing variants cached.</div>`;
        return;
      }

      listEl.innerHTML = '';
      data.forEach(v => {
        const item = document.createElement('div');
        item.className = 'drawer-version-item';
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '0.35rem 0.5rem';
        item.style.borderRadius = 'var(--radius-sm)';
        item.style.background = 'rgba(255,255,255,0.01)';
        item.style.border = '1px solid rgba(168, 85, 247, 0.08)';
        item.style.fontSize = '0.72rem';
        item.style.cursor = 'pointer';

        item.onclick = () => {
          document.getElementById('inspector-card-img').src = v.image_uri;
          document.getElementById('inspector-price').textContent = `$${Number(v.price).toFixed(2)}`;
          selectedInspectorPrinting = {
            name: cardName,
            price: v.price || 0.15,
            scryfallId: v.scryfall_id || null,
            type_line: activeInspectorCard ? activeInspectorCard.type_line : 'Card',
            colors: activeInspectorCard ? activeInspectorCard.colors : [],
            rarity: v.rarity || 'common'
          };
          if (v.scryfall_id) {
            loadCardRulings(v.scryfall_id);
          }
        };

        item.innerHTML = `
          <div style="font-weight:600; color:var(--text-high); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${v.set_name} (${v.set.toUpperCase()})</div>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <span style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase;">${v.rarity}</span>
            <span style="font-weight:700; color:var(--color-primary); font-size:0.75rem;">$${Number(v.price).toFixed(2)}</span>
          </div>
        `;
        listEl.appendChild(item);
      });
    } catch (e) {
      console.error(e);
    }
  }

  async function loadCardRulings(scryfallId) {
    try {
      const res = await fetch(`/api/cards/rulings?id=${encodeURIComponent(scryfallId)}`);
      const data = await res.json();
      const listEl = document.getElementById('inspector-rulings-list');

      if (data.error || !Array.isArray(data) || data.length === 0) {
        listEl.innerHTML = `<div style="font-size: 0.7rem; color: var(--text-muted); font-style: italic; padding: 0.4rem 0;">No rulings cached.</div>`;
        return;
      }

      listEl.innerHTML = '';
      data.forEach(r => {
        const item = document.createElement('div');
        item.style.padding = '0.5rem';
        item.style.background = 'rgba(255, 255, 255, 0.02)';
        item.style.border = '1px solid rgba(168, 85, 247, 0.08)';
        item.style.borderRadius = 'var(--radius-sm)';
        item.style.fontSize = '0.72rem';
        item.style.lineHeight = '1.35';

        item.innerHTML = `
          <div style="font-size: 0.65rem; color: var(--color-secondary); font-weight: 700; margin-bottom: 2px;">${r.published_at}</div>
          <div style="color: var(--text-high);">${r.comment}</div>
        `;
        listEl.appendChild(item);
      });
    } catch (e) {
      console.error(e);
    }
  }

  window.addActivePrintingToDeck = async function() {
    if (!selectedInspectorPrinting) return;
    const btn = document.getElementById('inspector-add-to-deck-btn');
    await window.addSuggestionToDeck(selectedInspectorPrinting, btn);
  };

  // Window resize observer
  let lastWidthCategory = window.innerWidth <= 480 ? 'mobile' : (window.innerWidth <= 768 ? 'tablet' : 'desktop');
  window.addEventListener('resize', () => {
    const currentCategory = window.innerWidth <= 480 ? 'mobile' : (window.innerWidth <= 768 ? 'tablet' : 'desktop');
    if (currentCategory !== lastWidthCategory) {
      lastWidthCategory = currentCategory;
      refreshCurrentCategoryView();
    }
  });

})();
