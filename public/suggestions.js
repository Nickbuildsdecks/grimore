(function() {
  // Top progress bar and global progress overlay helpers
  window.startTopProgress = function() {
    const bar = document.getElementById('top-progress-bar');
    if (!bar) return;
    bar.style.transition = 'width 0.4s ease, opacity 0.3s ease';
    bar.style.width = '0%';
    bar.style.opacity = '1';
    setTimeout(() => {
      bar.style.width = '35%';
      setTimeout(() => {
        bar.style.width = '75%';
      }, 500);
    }, 50);
  };

  window.completeTopProgress = function() {
    const bar = document.getElementById('top-progress-bar');
    if (!bar) return;
    bar.style.width = '100%';
    setTimeout(() => {
      bar.style.opacity = '0';
      setTimeout(() => {
        bar.style.width = '0%';
      }, 300);
    }, 200);
  };

  // State Variables
  const urlParams = new URLSearchParams(window.location.search);
  const deckId = urlParams.get('deckId');
  
  if (!deckId) {
    alert("No deck selected. Returning to dashboard.");
    window.location.href = 'index.html';
    return;
  }

  // Update return to builder link
  const returnLink = document.getElementById('btn-return-deck-link');
  if (returnLink) {
    returnLink.href = `index.html?deckId=${deckId}`;
  }
  const returnLogo = document.getElementById('btn-return-to-deck');
  if (returnLogo) {
    returnLogo.href = `index.html?deckId=${deckId}`;
  }

  let currentUser = null;
  let activeDeckData = null;
  let activeDeckCommander = [];
  let activeDeckMainboard = [];
  let categories = [];
  let selectedCategoryTag = null;
  
  let activeInspectorCard = null;
  let currentCardFaceIdx = 0;
  let suggestionsZoomed = false;

  // Initialize
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
    
    await loadDeckDetails();
    await loadSuggestions();
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
      // Get deck name
      const resDecks = await fetch('/api/decks/my-decks');
      const decks = await resDecks.json();
      activeDeckData = decks.find(d => d.id === deckId);
      
      if (activeDeckData) {
        document.getElementById('active-deck-name-display').textContent = activeDeckData.deck_name;
      } else {
        document.getElementById('active-deck-name-display').textContent = "Unknown Deck";
      }

      // Get current cards
      const resCards = await fetch(`/api/decks/${deckId}/cards`);
      const cardList = await resCards.json();

      // Resolve commander and mainboard
      activeDeckCommander = cardList.filter(c => c.is_commander === 1).map(c => ({
        name: c.card_name,
        quantity: c.quantity || 1,
        scryfallId: c.scryfall_id || null,
        price: c.cheapest_card_price || 0.15
      }));

      activeDeckMainboard = cardList.filter(c => c.is_commander !== 1).map(c => ({
        name: c.card_name,
        quantity: c.quantity || 1,
        scryfallId: c.scryfall_id || null,
        price: c.cheapest_card_price || 0.15
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
              suggestions are based on the commander cards registered inside your deck builder. Make sure to tag your commander!
            </div>
          </div>
        `;
        catsList.innerHTML = `<div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.75rem;">No commander defined</div>`;
        return;
      }

      categories = data.categories || [];
      if (categories.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4rem 1rem; text-align: center; gap: 0.75rem;">
            <div style="font-size: 1.5rem;">💡</div>
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

  // Populate categories sidebar with counts that filter out existing cards
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
      item.style.padding = '0.5rem 0.75rem';
      item.style.cursor = 'pointer';
      item.style.borderRadius = 'var(--radius-sm)';
      item.style.fontSize = '0.78rem';
      item.style.fontWeight = '600';
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.style.alignItems = 'center';
      item.style.transition = 'all 0.2s ease';
      
      if (cat.tag === selectedCategoryTag) {
        item.style.background = 'rgba(168, 85, 247, 0.1)';
        item.style.color = 'var(--text-pure)';
        item.style.borderLeft = '3px solid var(--color-primary)';
      } else {
        item.style.background = 'transparent';
        item.style.color = 'var(--text-muted)';
        item.style.borderLeft = 'none';
      }
      
      item.innerHTML = `
        <span>${cat.header}</span>
        <span class="category-badge" style="background: rgba(168,85,247,0.15); color: var(--color-primary); font-size: 0.68rem; padding: 1px 6px; border-radius: 10px; font-weight: 700;">${filteredCount}</span>
      `;
      
      item.onclick = () => selectCategory(cat.tag, item);
      catsList.appendChild(item);
    });
  }

  // Handle category selection
  function selectCategory(tag, element) {
    selectedCategoryTag = tag;
    
    // Highlight category in sidebar
    const items = document.querySelectorAll('#categories-list > div');
    items.forEach(item => {
      item.style.background = 'transparent';
      item.style.color = 'var(--text-muted)';
      item.style.borderLeft = 'none';
    });
    
    if (element) {
      element.style.background = 'rgba(168, 85, 247, 0.1)';
      element.style.color = 'var(--text-pure)';
      element.style.borderLeft = '3px solid var(--color-primary)';
    } else {
      const targetEl = document.querySelector(`.filters-sidebar-group[data-tag="${tag}"]`);
      if (targetEl) {
        targetEl.style.background = 'rgba(168, 85, 247, 0.1)';
        targetEl.style.color = 'var(--text-pure)';
        targetEl.style.borderLeft = '3px solid var(--color-primary)';
      }
    }

    const cat = categories.find(c => c.tag === tag);
    if (!cat) return;

    const filteredCards = cat.cards.filter(card => {
      const inMainboard = activeDeckMainboard.some(c => c.name.toLowerCase() === card.name.toLowerCase());
      const inCommander = activeDeckCommander.some(c => c.name.toLowerCase() === card.name.toLowerCase());
      return !inMainboard && !inCommander;
    });

    document.getElementById('current-category-title').textContent = cat.header;
    document.getElementById('current-category-count').textContent = `${filteredCards.length} recommendations found`;

    renderCardsGrid(filteredCards);
  }

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
    const activeCat = categories.find(c => c.tag === selectedCategoryTag);
    if (activeCat) {
      renderCardsGrid(activeCat.cards);
    }
  };

  // Render cards grid
  function renderCardsGrid(cards) {
    const grid = document.getElementById('suggestions-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const isMobile = window.innerWidth <= 480;
    const isTablet = window.innerWidth <= 768 && window.innerWidth > 480;

    grid.style.display = 'grid';
    grid.style.alignItems = 'start';
    grid.style.gridAutoRows = 'max-content';

    if (isMobile) {
      if (suggestionsZoomed) {
        grid.style.gridTemplateColumns = 'repeat(1, minmax(0, 1fr))';
        grid.style.gap = '0.5rem';
      } else {
        grid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        grid.style.gap = '0.35rem';
      }
    } else if (isTablet) {
      if (suggestionsZoomed) {
        grid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        grid.style.gap = '0.6rem';
      } else {
        grid.style.gridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
        grid.style.gap = '0.45rem';
      }
    } else {
      if (suggestionsZoomed) {
        grid.style.gridTemplateColumns = 'repeat(6, minmax(0, 1fr))';
        grid.style.gap = '0.75rem';
      } else {
        grid.style.gridTemplateColumns = 'repeat(10, minmax(0, 1fr))';
        grid.style.gap = '0.5rem';
      }
    }

    cards.forEach((card, index) => {
      const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
      const imgUrl = card.scryfallId ? `https://api.scryfall.com/cards/${card.scryfallId}?format=image&version=normal` : fallbackUrl;

      const cardEl = document.createElement('div');
      cardEl.className = 'search-card-item';
      cardEl.style.cssText = 'position: relative !important; border-radius: 8px !important; overflow: hidden !important; background: rgba(12, 13, 20, 0.4) !important; border: 1px solid rgba(168, 85, 247, 0.15) !important; transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease !important; cursor: pointer !important; width: 100% !important; display: flex !important; flex-direction: column !important; box-sizing: border-box !important; container-type: inline-size;';

      cardEl.onmouseover = function() {
        this.style.transform = 'translateY(-4px)';
        this.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
        this.style.borderColor = 'rgba(168, 85, 247, 0.35)';
      };
      cardEl.onmouseout = function() {
        this.style.transform = 'none';
        this.style.boxShadow = 'none';
        this.style.borderColor = 'rgba(168, 85, 247, 0.15)';
      };

      cardEl.onclick = function() {
        window.openInspector(card);
      };

      // Check quantity in deck
      const qtyInTarget = activeDeckMainboard.reduce((acc, c) => c.name.toLowerCase() === card.name.toLowerCase() ? acc + c.quantity : acc, 0) + 
                          activeDeckCommander.reduce((acc, c) => c.name.toLowerCase() === card.name.toLowerCase() ? acc + c.quantity : acc, 0);

      const inDeckBadge = qtyInTarget > 0 ? `
        <div style="position: absolute; top: 6px; left: 6px; background: rgba(245, 158, 11, 0.9) !important; border: 1px solid rgba(245, 158, 11, 0.4) !important; color: white !important; font-family: 'Outfit', sans-serif !important; font-size: 0.62rem !important; font-weight: 800 !important; padding: 2px 6px !important; border-radius: 4px !important; box-shadow: 0 2px 6px rgba(0,0,0,0.5) !important; z-index: 5 !important; text-transform: uppercase !important; pointer-events: none !important;">
          ${qtyInTarget} in Deck
        </div>
      ` : '';

      const synergyBadge = card.synergy ? `
        <div style="position: absolute; top: 6px; right: 6px; background: rgba(124, 58, 237, 0.95) !important; border: 1px solid rgba(124, 58, 237, 0.4) !important; color: white !important; font-family: 'Outfit', sans-serif !important; font-size: 0.62rem !important; font-weight: 800 !important; padding: 2px 6px !important; border-radius: 4px !important; box-shadow: 0 2px 6px rgba(0,0,0,0.5) !important; z-index: 5 !important; text-transform: uppercase !important; pointer-events: none !important;">
          ${card.synergy}
        </div>
      ` : '';

      cardEl.innerHTML = `
        ${inDeckBadge}
        ${synergyBadge}
        <div style="width: 100% !important; aspect-ratio: 2.5/3.5 !important; overflow: hidden !important; position: relative !important;">
          <img src="${imgUrl}" alt="${card.name}" loading="lazy" style="width: 100% !important; height: 100% !important; object-fit: fill !important; transition: transform 0.2s ease !important; display: block !important;" 
               onmouseover="this.style.transform='scale(1.03)'"
               onmouseout="this.style.transform='none'"
               onerror="this.src='logo.svg'">
        </div>
        <!-- Footer row with Add Button & Price Badge scaling dynamically -->
        <div style="display: flex !important; align-items: center !important; gap: 4cqw !important; padding: 4cqw !important; background: rgba(12, 13, 20, 0.9) !important; border-top: 1px solid rgba(168, 85, 247, 0.2) !important; box-sizing: border-box !important; width: 100% !important;" onclick="event.stopPropagation();">
          <button type="button" class="btn btn-primary" onclick="window.addSuggestionToDeck(${JSON.stringify(card).replace(/'/g, "&apos;")}, this)" style="width: 18cqw !important; height: 18cqw !important; padding: 0 !important; font-size: 10cqw !important; display: flex !important; align-items: center !important; justify-content: center !important; font-weight: 800 !important; border-radius: 50% !important; margin: 0 !important; border: 1px solid rgba(255,255,255,0.25) !important; background: var(--color-primary) !important; color: white !important; box-shadow: 0 2px 8px rgba(0,0,0,0.6) !important; cursor: pointer !important; transition: transform 0.15s ease;" onmouseover="this.style.transform='scale(1.15)'" onmouseout="this.style.transform='none'" title="Add to target deck">+</button>
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
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = '✓';
      buttonEl.style.background = 'var(--color-success)';
      buttonEl.style.color = '#fff';
    }

    // Check if card is already in mainboard
    const existing = activeDeckMainboard.find(c => c.name.toLowerCase() === card.name.toLowerCase());
    if (existing) {
      existing.quantity += 1;
    } else {
      activeDeckMainboard.push({
        name: card.name,
        quantity: 1,
        scryfallId: card.scryfallId || null,
        price: card.price || 0.15
      });
    }

    try {
      window.startTopProgress();
      const saveRes = await fetch('/api/decks/builder-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deckId,
          deckName: activeDeckData ? activeDeckData.deck_name : 'New Deck',
          commanderCards: activeDeckCommander,
          mainboardCards: activeDeckMainboard,
          isPublic: activeDeckData ? (activeDeckData.is_public !== undefined ? activeDeckData.is_public : 0) : 0,
          format: activeDeckData ? activeDeckData.format : 'commander',
          keepCheapest: activeDeckData ? activeDeckData.keep_cheapest : 0
        })
      });
      
      const saveResult = await saveRes.json();
      window.completeTopProgress();

      if (saveResult.error) {
        alert("Failed to add card: " + saveResult.error);
        if (buttonEl) {
          buttonEl.disabled = false;
          buttonEl.textContent = buttonEl.id === 'inspector-add-to-deck-btn' ? '➕ Add Selected Printing to Deck' : '+';
          buttonEl.style.background = '';
        }
      } else {
        // Re-render suggestion grid to remove the added card and update the sidebar counts
        setTimeout(() => {
          if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = buttonEl.id === 'inspector-add-to-deck-btn' ? '➕ Add Selected Printing to Deck' : '+';
            buttonEl.style.background = '';
            buttonEl.style.color = '';
          }
          renderCategoriesSidebar();
          const activeCat = categories.find(c => c.tag === selectedCategoryTag);
          if (activeCat) {
            const filteredCards = activeCat.cards.filter(card => {
              const inMainboard = activeDeckMainboard.some(c => c.name.toLowerCase() === card.name.toLowerCase());
              const inCommander = activeDeckCommander.some(c => c.name.toLowerCase() === card.name.toLowerCase());
              return !inMainboard && !inCommander;
            });
            document.getElementById('current-category-count').textContent = `${filteredCards.length} recommendations found`;
            renderCardsGrid(filteredCards);
          }
        }, 1200);
      }
    } catch (e) {
      window.completeTopProgress();
      console.error(e);
      alert("Failed to save changes.");
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = buttonEl.id === 'inspector-add-to-deck-btn' ? '➕ Add Selected Printing to Deck' : '+';
        buttonEl.style.background = '';
      }
    }
  };

  // ── INSPECTOR DRAWER ────────────────────────────────────────────────
  let selectedInspectorPrinting = null;

  window.openInspector = async function(card) {
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
    drawer.classList.add('open');
    
    document.getElementById('inspector-card-name').textContent = card.name;
    document.getElementById('inspector-type').textContent = card.type_line;
    document.getElementById('inspector-price').textContent = `$${Number(card.price).toFixed(2)}`;
    
    const fallbackUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
    const imgUrl = card.scryfallId ? `https://api.scryfall.com/cards/${card.scryfallId}?format=image&version=normal` : fallbackUrl;
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
    if (drawer) drawer.classList.remove('open');
    activeInspectorCard = null;
  };

  window.toggleInspectorCardFace = function() {
    if (!activeInspectorCard) return;
    currentCardFaceIdx = currentCardFaceIdx === 0 ? 1 : 0;
    const imgElement = document.getElementById('inspector-card-img');
    const scryfallId = activeInspectorCard.scryfallId;
    
    if (scryfallId) {
      imgElement.src = `https://api.scryfall.com/cards/${scryfallId}?format=image&version=normal${currentCardFaceIdx === 1 ? '&face=back' : ''}`;
    } else {
      imgElement.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(activeInspectorCard.name)}&format=image&version=normal${currentCardFaceIdx === 1 ? '&face=back' : ''}`;
    }
  };

  async function loadCardVersions(cardName) {
    try {
      const res = await fetch(`/api/cards/versions?name=${encodeURIComponent(cardName)}`);
      const data = await res.json();
      const listEl = document.getElementById('inspector-version-list');
      
      if (data.error || !data.versions || data.versions.length === 0) {
        listEl.innerHTML = `<div style="font-size: 0.7rem; color: var(--text-muted); text-align: center; padding: 0.5rem 0;">No printing variants cached.</div>`;
        return;
      }

      listEl.innerHTML = '';
      data.versions.forEach(v => {
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
          // Update active scryfall_id in inspector details if matching
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
      
      if (data.error || !data.rulings || data.rulings.length === 0) {
        listEl.innerHTML = `<div style="font-size: 0.7rem; color: var(--text-muted); font-style: italic; padding: 0.4rem 0;">No rulings cached.</div>`;
        return;
      }

      listEl.innerHTML = '';
      data.rulings.forEach(r => {
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

  // Window resize observer to adapt columns dynamically
  let lastWidthCategory = window.innerWidth <= 480 ? 'mobile' : (window.innerWidth <= 768 ? 'tablet' : 'desktop');
  window.addEventListener('resize', () => {
    const currentCategory = window.innerWidth <= 480 ? 'mobile' : (window.innerWidth <= 768 ? 'tablet' : 'desktop');
    if (currentCategory !== lastWidthCategory) {
      lastWidthCategory = currentCategory;
      const activeCat = categories.find(c => c.tag === selectedCategoryTag);
      if (activeCat) {
        const filteredCards = activeCat.cards.filter(card => {
          const inMainboard = activeDeckMainboard.some(c => c.name.toLowerCase() === card.name.toLowerCase());
          const inCommander = activeDeckCommander.some(c => c.name.toLowerCase() === card.name.toLowerCase());
          return !inMainboard && !inCommander;
        });
        renderCardsGrid(filteredCards);
      }
    }
  });

})();
