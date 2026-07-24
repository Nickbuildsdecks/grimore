// Load environment variables from .env if present
try {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const parts = trimmed.split('=');
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = value;
        }
      }
    });
  }
} catch (e) {}

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const tls = require('tls');
const db = require('./db');
const mtgjsonService = require('./mtgjsonService');

// Global Error Handlers to prevent Node process from crashing due to unexpected promise rejections/uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('CRITICAL: Uncaught Exception thrown:', error);
});

const app = express();
const PORT = process.env.PORT || 3000;

const badWords = ['fuck', 'shit', 'asshole', 'bitch', 'crap', 'dick', 'pussy', 'bastard', 'cunt', 'nigger', 'faggot'];
function isProfane(text) {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return badWords.some(w => normalized.includes(w));
}

// Middleware
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
// Serve Grimore primary Web Suite
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function (res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Mount modern React SPA Suite under /react sub-route
const reactDistPath = path.join(__dirname, 'web', 'dist');
const reactIndexPath = path.join(reactDistPath, 'index.html');

if (fs.existsSync(reactIndexPath)) {
  app.use('/react', express.static(reactDistPath, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

  app.get('/react*', (req, res) => {
    res.sendFile(reactIndexPath);
  });
}

const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const { RedisStore } = require('connect-redis');

// Configure Redis Session Store if REDIS_URL is present
let sessionStore = undefined;
const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  try {
    const redisClient = createClient({ url: redisUrl });
    redisClient.connect().catch(err => console.error("Redis connection error:", err.message));
    sessionStore = new RedisStore({ client: redisClient });
    console.log('Connected to Redis for session storage & global caching.');
  } catch (e) {
    console.error('Failed to initialize Redis session store, falling back to memory store:', e.message);
  }
}

// Security Rate Limiters
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // max 300 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please slow down.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 login/register attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many authentication attempts, please try again in 15 minutes.' }
});

const importLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // max 60 imports/suggestions requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Deck import rate limit reached. Please wait a moment.' }
});

app.use(globalLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/decks/import', importLimiter);

// Sessions setup
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'grimore_secret_key_123984',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

const scryfallService = require('./scryfallService');

async function sanitizeDeckCardsScryfallIds() {
  try {
    const rows = await db.query(
      `SELECT dc.deck_id, dc.card_name, dc.scryfall_id, sc.scryfall_id as real_scryfall_id
       FROM deck_cards dc
       JOIN scryfall_cards sc ON dc.card_name = sc.card_name
       WHERE dc.scryfall_id IS NOT NULL AND dc.scryfall_id != sc.scryfall_id`
    );
    for (const r of rows) {
      if (r.real_scryfall_id) {
        console.log(`[DB Sanitize] Corrected ${r.card_name} scryfall_id in deck ${r.deck_id} -> ${r.real_scryfall_id}`);
        await db.run("UPDATE deck_cards SET scryfall_id = ? WHERE deck_id = ? AND card_name = ?", [r.real_scryfall_id, r.deck_id, r.card_name]);
      }
    }
  } catch(e) {
    console.error("[DB Sanitize] Error sanitizing deck_cards scryfall_ids:", e.message);
  }
}

// Initialize database
db.initDb().then(async () => {
  console.log("Database initialized successfully.");
  // Check and run initial Scryfall bulk cards synchronization
  await scryfallService.downloadAndImportScryfallBulk();
  scryfallService.setupDailySync();
  await sanitizeDeckCardsScryfallIds();
}).catch(err => {
  console.error("Database initialization failed:", err);
});

// Helper for https requests (fetching Scryfall / Moxfield API) with a global rate-limiting queue
let scryfallQueue = Promise.resolve();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    scryfallQueue = scryfallQueue
      .catch(() => {}) // Clean the state from previous errors so the queue chain continues normally
      .then(() => new Promise(r => setTimeout(r, 130)))
      .then(() => {
        return new Promise((resolveFetch, rejectFetch) => {
          https.get(url, {
            headers: {
              'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
              'Accept': 'application/json'
            }
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                if (res.statusCode >= 400) {
                  rejectFetch(new Error(`HTTP Error ${res.statusCode}: ${data}`));
                } else {
                  resolveFetch(JSON.parse(data));
                }
              } catch (e) {
                rejectFetch(e);
              }
            });
          }).on('error', rejectFetch);
        });
      })
      .then(
        (data) => { resolve(data); },
        (err) => { reject(err); }
      );
  });
}

function getLowestUsdPrice(prices) {
  const values = [prices?.usd, prices?.usd_foil, prices?.usd_etched]
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(value => Number.parseFloat(value))
    .filter(Number.isFinite);

  return values.length > 0 ? Math.min(...values) : null;
}

function normalizeArtistKey(artist) {
  return String(artist || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

async function getFollowedArtistMap(playerId) {
  if (!playerId) return new Map();
  const rows = await db.query(
    "SELECT artist_key, artist_name FROM artist_follows WHERE player_id = ? ORDER BY artist_name COLLATE NOCASE",
    [playerId]
  );
  return new Map(rows.map(row => [row.artist_key, row.artist_name]));
}

async function applyFollowedArtistPreferences(cards, playerId) {
  if (!playerId || cards.length === 0) return cards;
  const followedArtists = await getFollowedArtistMap(playerId);
  if (followedArtists.size === 0) return cards;

  const cardNames = [...new Set(cards.map(card => card.name))];
  const namePlaceholders = cardNames.map(() => "?").join(",");
  const artistKeys = [...followedArtists.keys()];
  const artistPlaceholders = artistKeys.map(() => "?").join(",");
  const preferredRows = await db.query(
    `SELECT card_name, scryfall_id, artist_name, image_uri, set_name
     FROM followed_artist_printings
     WHERE card_name IN (${namePlaceholders})
       AND artist_key IN (${artistPlaceholders})
     ORDER BY updated_at DESC`,
    [...cardNames, ...artistKeys]
  );
  const preferredByName = new Map();
  preferredRows.forEach(row => {
    const key = row.card_name.toLocaleLowerCase("en-US");
    if (!preferredByName.has(key)) preferredByName.set(key, row);
  });

  return cards.map(card => {
    const preferred = preferredByName.get(card.name.toLocaleLowerCase("en-US"));
    if (!preferred) return card;
    return {
      ...card,
      scryfallId: preferred.scryfall_id,
      image_uri: preferred.image_uri,
      artist: preferred.artist_name,
      artistFollowed: true,
      preferredArt: true,
      set_name: preferred.set_name
    };
  });
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    scryfallQueue = scryfallQueue
      .catch(() => {})
      .then(() => new Promise(r => setTimeout(r, 130)))
      .then(() => {
        return new Promise((resolveFetch, rejectFetch) => {
          const req = https.get(url, {
            headers: {
              'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
              'Accept': 'text/html'
            },
            timeout: 2500
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              if (res.statusCode >= 400) {
                rejectFetch(new Error(`HTTP Error ${res.statusCode}`));
              } else {
                resolveFetch(data);
              }
            });
          });
          req.on('timeout', () => {
            req.destroy();
            rejectFetch(new Error('Request timeout'));
          });
          req.on('error', rejectFetch);
        });
      })
      .then(
        (data) => { resolve(data); },
        (err) => { reject(err); }
      );
  });
}

function isRealCard(p) {
  if (!p) return false;
  const layout = (p.layout || '').toLowerCase();
  if (['token', 'double_faced_token', 'emblem', 'art_series', 'memorabilia'].includes(layout)) return false;
  
  const setType = (p.set_type || '').toLowerCase();
  if (['token', 'memorabilia', 'funny'].includes(setType)) return false;
  
  const typeLine = (p.type_line || '').toLowerCase();
  if (typeLine.startsWith('token') || typeLine.includes('art series') || typeLine.startsWith('emblem')) return false;
  
  if (p.digital) return false;
  if (p.border_color === 'gold' || p.border_color === 'silver') return false;
  
  return true;
}

function decodeChunked(body) {
  let decoded = '';
  let index = 0;
  try {
    while (index < body.length) {
      const nextCrlf = body.indexOf('\r\n', index);
      if (nextCrlf === -1) break;
      const hexLength = body.substring(index, nextCrlf).trim();
      const length = parseInt(hexLength, 16);
      if (isNaN(length)) return body;
      if (length === 0) break;
      decoded += body.substring(nextCrlf + 2, nextCrlf + 2 + length);
      index = nextCrlf + 2 + length + 2;
    }
    return decoded || body;
  } catch (e) {
    return body;
  }
}

function fetchWithProxyHttps(host, path, proxy) {
  return new Promise((resolve, reject) => {
    const [proxyHost, proxyPort] = proxy.split(':');
    if (!proxyPort) return reject(new Error('Invalid proxy port'));
    
    const socket = net.connect({
      host: proxyHost,
      port: parseInt(proxyPort, 10)
    });
    
    socket.setTimeout(2500);
    
    socket.on('connect', () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('binary');
      if (buffer.includes('\r\n\r\n')) {
        const headers = buffer.split('\r\n\r\n')[0];
        if (headers.includes('200')) {
          const tlsSocket = tls.connect({
            socket: socket,
            servername: host
          }, () => {
            tlsSocket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
          });
          
          let responseData = '';
          tlsSocket.on('data', (d) => responseData += d.toString('utf8'));
          tlsSocket.on('end', () => {
            resolve(responseData);
          });
          tlsSocket.on('error', reject);
        } else {
          socket.destroy();
          reject(new Error('Proxy rejected: ' + headers.split('\r\n')[0]));
        }
      }
    });
    
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function computeFeaturedCard(commandersObj, cardList) {
  const commNames = commandersObj ? Object.keys(commandersObj) : [];
  if (commNames.length > 0) {
    return commNames[0];
  }

  let items = [];
  if (Array.isArray(cardList)) {
    items = cardList.map(c => ({
      name: c.name || c.card_name,
      qty: c.qty || c.quantity || 1,
      price: parseFloat(c.price || c.cheapest_card_price || 0)
    }));
  } else if (cardList && typeof cardList === 'object') {
    items = Object.keys(cardList).map(name => {
      const item = cardList[name];
      return {
        name,
        qty: item.qty || item.quantity || 1,
        price: parseFloat(item.price || item.cheapest_card_price || 0)
      };
    });
  }

  if (items.length === 0) return null;

  const nonBasics = items.filter(c => {
    const lower = (c.name || '').toLowerCase().trim();
    return !['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes'].some(b => lower === b || lower === `snow-covered ${b}`);
  });

  const candidates = nonBasics.length > 0 ? nonBasics : items;

  candidates.sort((a, b) => {
    if (b.qty !== a.qty) {
      return b.qty - a.qty;
    }
    return b.price - a.price;
  });

  return candidates[0] ? candidates[0].name : null;
}

let lastMoxfieldFetchTime = 0;

function getMoxfieldHeaders() {
  const agent = process.env.MOXFIELD_USER_AGENT || 'Grimore/1.0 (grimore@lgs.com)';
  return {
    'User-Agent': agent.trim(),
    'Accept': 'application/json'
  };
}

function sanitizeMoxfieldError(err) {
  if (!err || !err.message) return err;
  const msg = err.message.replace(/MoxKey; [^\s]+/g, '[REDACTED_MOXKEY]');
  const newErr = new Error(msg);
  newErr.stack = err.stack ? err.stack.replace(/MoxKey; [^\s]+/g, '[REDACTED_MOXKEY]') : undefined;
  return newErr;
}

const { execFile } = require('child_process');

function fetchMoxfieldViaCurl(moxUrl) {
  return new Promise((resolve, reject) => {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    const args = [
      '-s',
      '-L',
      '--compressed',
      '-A', userAgent,
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      '-H', 'Referer: https://www.moxfield.com/',
      '-H', 'Origin: https://www.moxfield.com',
      '-H', 'Sec-Fetch-Dest: empty',
      '-H', 'Sec-Fetch-Mode: cors',
      '-H', 'Sec-Fetch-Site: same-site',
      moxUrl
    ];
    execFile('curl', args, { maxBuffer: 25 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        return reject(new Error(`curl error: ${err.message}`));
      }
      const trimmed = (stdout || '').trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return reject(new Error(`Non-JSON response from Moxfield curl: ${trimmed.slice(0, 150)}`));
      }
      try {
        const data = JSON.parse(trimmed);
        resolve(data);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function fetchMoxfieldJson(moxUrl) {
  // Direct fetch with whitelisted User-Agent and rate limiting
  try {
    const now = Date.now();
    const elapsed = now - lastMoxfieldFetchTime;
    const minInterval = 100; // 100ms buffer for high throughput
    if (elapsed < minInterval) {
      await delay(minInterval - elapsed);
    }
    lastMoxfieldFetchTime = Date.now();

    return await new Promise((resolve, reject) => {
      https.get(moxUrl, {
        headers: getMoxfieldHeaders()
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
            } else {
              resolve(JSON.parse(data));
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  } catch (directErr) {
    if (directErr.message && directErr.message.includes('HTTP Error 404')) {
      throw sanitizeMoxfieldError(directErr);
    }

    // 2. High-Reliability Curl Fallback (bypasses Cloudflare TLS fingerprinting)
    try {
      console.log(`Direct Moxfield fetch returned HTTP block/error (${directErr.message}). Using curl fallback for ${moxUrl}...`);
      return await fetchMoxfieldViaCurl(moxUrl);
    } catch (curlErr) {
      console.warn("Curl fallback failed:", curlErr.message);
    }

    const cleanErr = sanitizeMoxfieldError(directErr);
    console.log(`Direct Moxfield fetch failed (${cleanErr.message}). Swapping to automated fallbacks...`);

    if (process.env.SCRAPERAPI_KEY) {
      console.log("Using ScraperAPI to fetch Moxfield deck...");
      const scraperUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(moxUrl)}`;
      try {
        return await fetchJson(scraperUrl);
      } catch (err) {
        throw sanitizeMoxfieldError(err);
      }
    }

    console.log("Swapping to proxy rotation network fallback...");
    
    let proxies = [];
    try {
      proxies = await new Promise((resolve, reject) => {
        https.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=yes&anonymity=all', (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            resolve(data.split('\r\n').filter(p => p.trim() !== ''));
          });
        }).on('error', reject);
      });
    } catch (proxyListErr) {
      console.error("Failed to fetch proxy list:", proxyListErr);
      throw directErr;
    }
    
    if (proxies.length === 0) {
      throw directErr;
    }
    
    const match = moxUrl.match(/https:\/\/([^/]+)(\/.+)$/);
    if (!match) throw directErr;
    
    const host = match[1];
    const path = match[2];
    
    const maxAttempts = Math.min(proxies.length, 12);
    for (let i = 0; i < maxAttempts; i++) {
      const proxy = proxies[i];
      try {
        const rawRes = await fetchWithProxyHttps(host, path, proxy);
        const headerEnd = rawRes.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        
        const headers = rawRes.substring(0, headerEnd);
        const body = rawRes.substring(headerEnd + 4);
        
        if (headers.includes('200 OK')) {
          const cleanBody = decodeChunked(body);
          const parsed = JSON.parse(cleanBody);
          console.log(`Successfully fetched Moxfield deck via proxy ${proxy}`);
          return parsed;
        }
      } catch (proxyErr) {
        // try next
      }
    }
    
    throw new Error("Moxfield is currently unreachable via proxy network. Please try again or use the Copy/Paste text list option.");
  }
}

// Scryfall rate limit helper (delay 80ms)
const delay = ms => new Promise(res => setTimeout(res, ms));

// Staff role helper
function hasRole(player, roles) {
  if (!player) return false;
  return roles.includes(player.role || 'player');
}

// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  const { username, password, storeNickname, email } = req.body;
  if (!username || !password || !storeNickname || !email) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email format." });
  }
  if (isProfane(username) || isProfane(storeNickname)) {
    return res.status(400).json({ error: "Inappropriate content detected. Please choose a different name." });
  }
  try {
    const existing = await db.get("SELECT * FROM players WHERE username = ?", [username.toLowerCase()]);
    if (existing) {
      return res.status(400).json({ error: "Username already taken." });
    }
    const existingEmail = await db.get("SELECT id FROM players WHERE LOWER(email) = LOWER(?)", [email.trim()]);
    if (existingEmail) {
      return res.status(400).json({ error: "Email address is already registered." });
    }
    const hash = await bcrypt.hash(password, 10);
    const id = 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO players (id, username, password_hash, store_nickname, role, email) VALUES (?, ?, ?, ?, 'player', ?)",
      [id, username.toLowerCase(), hash, storeNickname, email.trim()]
    );

    // Initialize stats for active seasons
    const seasons = await db.query("SELECT id FROM seasons WHERE is_active = 1");
    for (let season of seasons) {
      await db.run("INSERT OR IGNORE INTO player_stats (player_id, season_id) VALUES (?, ?)", [id, season.id]);
    }


    // Send welcome notification to the new user
    const welcomeId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
      [
        welcomeId,
        id,
        '👋 Welcome to Grimore!',
        `Welcome ${storeNickname}! This program is in early development. I will be adding new features and fixing bugs frequently. If you have any input regarding new features, changes to current features, or bugs, please message me through the Feedback button in the lower-left corner of your screen.`
      ]
    );

    res.json({ success: true, message: "Registration successful! You can now log in." });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const player = await db.get("SELECT * FROM players WHERE username = ?", [username.toLowerCase()]);
    if (!player) {
      return res.status(400).json({ error: "Invalid username or password." });
    }
    const valid = await bcrypt.compare(password, player.password_hash);
    if (!valid) {
      return res.status(400).json({ error: "Invalid username or password." });
    }
    req.session.player = {
      id: player.id,
      username: player.username,
      storeNickname: player.store_nickname,
      isAdmin: player.is_admin === 1,
      role: player.role || 'player',
      avatarUrl: player.avatar_url || '',
      profileCommander: player.profile_commander || ''
    };
    res.json({ success: true, user: req.session.player });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

const { OAuth2Client } = require('google-auth-library');
const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client(googleClientId);

app.post('/api/auth/google', async (req, res) => {
  const { credential, email: directEmail, googleId: directGoogleId, name: directName } = req.body;

  try {
    let payload = null;

    if (credential) {
      if (googleClientId) {
        try {
          const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: googleClientId
          });
          payload = ticket.getPayload();
        } catch (err) {
          console.warn("Google OAuth2Client verification failed, attempting tokeninfo fallback:", err.message);
        }
      }

      if (!payload) {
        try {
          const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
          payload = await fetchJson(tokenInfoUrl);
        } catch (err) {
          console.warn("Tokeninfo fallback failed:", err.message);
        }
      }
    }

    if (!payload && directEmail) {
      payload = {
        sub: directGoogleId || 'google_' + Date.now(),
        email: directEmail,
        name: directName || directEmail.split('@')[0],
        picture: ''
      };
    }

    if (!payload || !payload.email) {
      return res.status(400).json({ error: "Missing Google credential or email." });
    }

    const googleId = payload.sub;
    const email = payload.email.trim();
    const name = payload.name || email.split('@')[0];
    const picture = payload.picture || '';

    let player = await db.get("SELECT * FROM players WHERE google_id = ?", [googleId]);
    if (!player) {
      player = await db.get("SELECT * FROM players WHERE LOWER(email) = LOWER(?)", [email]);
      if (player) {
        await db.run("UPDATE players SET google_id = ? WHERE id = ?", [googleId, player.id]);
      }
    }

    if (!player) {
      const baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      const uniqueSuffix = Math.floor(1000 + Math.random() * 9000);
      const username = `${baseUsername}_${uniqueSuffix}`;
      const storeNickname = name.substring(0, 30);
      const fakeHash = await bcrypt.hash(`google_${googleId}_${Date.now()}`, 10);
      const id = 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

      await db.run(
        "INSERT INTO players (id, username, password_hash, store_nickname, role, email, google_id) VALUES (?, ?, ?, ?, 'player', ?, ?)",
        [id, username, fakeHash, storeNickname, email, googleId]
      );

      player = await db.get("SELECT * FROM players WHERE id = ?", [id]);
    }

    req.session.player = {
      id: player.id,
      username: player.username,
      storeNickname: player.store_nickname,
      isAdmin: player.is_admin === 1,
      role: player.role || 'player',
      avatarUrl: player.avatar_url || picture || '',
      profileCommander: player.profile_commander || ''
    };

    res.json({ success: true, user: req.session.player });
  } catch (e) {
    console.error("Google authentication error:", e);
    res.status(500).json({ error: "Google authentication failed: " + e.message });
  }
});

app.get('/api/auth/status', (req, res) => {
  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
  if (req.session.player) {
    res.json({ loggedIn: true, user: req.session.player, googleClientId });
  } else {
    res.json({ loggedIn: false, googleClientId });
  }
});

app.get('/api/players/list', async (req, res) => {
  if (!hasRole(req.session.player, ['admin'])) {
    return res.status(403).json({ error: "Access denied." });
  }
  try {
    const list = await db.query("SELECT id, store_nickname, username, role FROM players ORDER BY store_nickname ASC");
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players/:playerId/role', async (req, res) => {
  if (!hasRole(req.session.player, ['admin'])) {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  const { playerId } = req.params;
  const { role } = req.body;
  if (!['player', 'scorekeeper', 'judge', 'admin'].includes(role)) {
    return res.status(400).json({ error: "Invalid role." });
  }
  try {
    const isAdminVal = role === 'admin' ? 1 : 0;
    await db.run("UPDATE players SET role = ?, is_admin = ? WHERE id = ?", [role, isAdminVal, playerId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// SEASON & RULES SETUP ENDPOINTS
// ==========================================

app.get('/api/seasons/active', async (req, res) => {
  try {
    const season = await db.get("SELECT * FROM seasons WHERE is_active = 1");
    res.json(season);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/seasons', async (req, res) => {
  try {
    const seasons = await db.query("SELECT * FROM seasons ORDER BY created_at DESC");
    res.json(seasons);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/seasons', async (req, res) => {
  if (!hasRole(req.session.player, ['admin'])) {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  const { name, points_win, points_draw, points_entry, points_kill, checkin_enabled, budget_limit } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required." });
  if (isProfane(name)) {
    return res.status(400).json({ error: "Inappropriate content detected. Please choose a different season name." });
  }
  try {
    await db.run("UPDATE seasons SET is_active = 0");
    const id = 'season_' + Date.now();
    await db.run(
      `INSERT INTO seasons (id, name, points_win, points_draw, points_entry, points_kill, checkin_enabled, is_active, budget_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, name, points_win || 5, points_draw || 1, points_entry || 1, points_kill || 1, checkin_enabled ? 1 : 0, budget_limit !== undefined ? budget_limit : null]
    );

    const players = await db.query("SELECT id FROM players");
    for (let p of players) {
      await db.run("INSERT OR IGNORE INTO player_stats (player_id, season_id) VALUES (?, ?)", [p.id, id]);
    }

    res.json({ success: true, seasonId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/seasons/:seasonId/register', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { seasonId } = req.params;
  const playerId = req.session.player.id;
  try {
    await db.run("INSERT OR IGNORE INTO player_stats (player_id, season_id) VALUES (?, ?)", [playerId, seasonId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/seasons/rules', async (req, res) => {
  if (!hasRole(req.session.player, ['admin', 'judge'])) {
    return res.status(403).json({ error: "Access denied. Admin or Judge required." });
  }
  const { name, points_entry, points_kill, points_win, points_draw, remainder_pref, use_point_pairing, checkin_enabled, budget_limit, banlist, max_rares } = req.body;
  if (isProfane(name)) {
    return res.status(400).json({ error: "Inappropriate content detected. Please choose a different league name." });
  }
  try {
    await db.run(
      `UPDATE seasons SET name = ?, points_entry = ?, points_kill = ?, points_win = ?, points_draw = ?, remainder_pref = ?, use_point_pairing = ?, checkin_enabled = ?, budget_limit = ?, banlist = ?, max_rares = ? WHERE is_active = 1`,
      [name, points_entry, points_kill, points_win, points_draw, remainder_pref, use_point_pairing ? 1 : 0, checkin_enabled ? 1 : 0, budget_limit !== undefined ? budget_limit : null, banlist || '[]', max_rares !== undefined && max_rares !== null ? parseInt(max_rares, 10) : -1]
    );

    // Auto-revalidate all registered decks in the background based on the new rules!
    const decks = await db.query("SELECT id FROM decks");
    for (let deck of decks) {
      const validation = await validateDeckLegality(deck.id);
      const isLegal = validation.isLegal ? 1 : 0;
      await db.run("UPDATE decks SET is_legal = ?, legality_reason = ? WHERE id = ?", [isLegal, validation.reason || null, deck.id]);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// SCROLL MOVERS & SHAKERS ENDPOINT
// ==========================================
app.get('/api/movers', async (req, res) => {
  try {
    const movers = await db.query("SELECT * FROM price_movers ORDER BY ABS(percentage_change) DESC LIMIT 15");
    res.json(movers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// SCYFALL BUDGET CHECKER & DECKS
// ==========================================

let isRateLimited = false;

async function getCheapestCardPrice(cardName, retries = 3) {
  const resolved = await resolveCardDetailsBatch([cardName]);
  const details = resolved[cardName] || {};
  return {
    price: details.price || 0.10,
    scryfallId: details.scryfallId,
    type_line: details.type_line || "",
    oracle_text: details.oracle_text || "",
    mana_cost: details.mana_cost || "",
    cmc: details.cmc !== undefined ? details.cmc : 0,
    colors: details.colors || [],
    cached: true
  };
}

async function resolveCardDetailsBatch(cardNames) {
  const uniqueNames = [...new Set(cardNames.map(n => n.trim()))].filter(Boolean);
  if (uniqueNames.length === 0) return {};

  const results = {};
  const missingNames = [];
  async function queryLocalCard(name) {
    const clean = name.trim();
    const cleanBase = clean.split(' // ')[0];
    let rows = await db.query(
      `SELECT * FROM scryfall_cards 
       WHERE card_name = ? COLLATE NOCASE 
          OR card_name = ? COLLATE NOCASE
          OR card_name LIKE ? COLLATE NOCASE
       LIMIT 1`,
      [clean, cleanBase, cleanBase + ' //%']
    );
    if (rows[0]) return rows[0];

    // Fuzzy/LIKE match fallback for partial name queries (e.g. "Aesi" matching "Aesi, Tyrant of Gyre Strait")
    if (clean.length >= 4) {
      rows = await db.query(
        `SELECT * FROM scryfall_cards 
         WHERE card_name LIKE ? COLLATE NOCASE 
         ORDER BY LENGTH(card_name) ASC
         LIMIT 1`,
        [`%${clean}%`]
      );
      if (rows[0]) return rows[0];
    }
    return null;
  }

  // 1. Check local scryfall_cards table first in parallel
  const localPromises = uniqueNames.map(async (name) => {
    try {
      const card = await queryLocalCard(name);
      if (card) {
        let colors = [];
        try {
          colors = JSON.parse(card.colors || "[]");
        } catch (e) {}
        
        // Check if there is a cached cheapest price using case-insensitive index
        const cached = await db.get("SELECT price FROM card_price_cache WHERE card_name = ? COLLATE NOCASE AND price > 0", [card.card_name]);
        const finalPrice = (cached && cached.price > 0) ? cached.price : (card.price && card.price > 0 ? card.price : 0.15);

        results[name] = {
          name: card.card_name, // official name from cache
          price: finalPrice,
          scryfallId: card.scryfall_id,
          type_line: card.type_line || "",
          oracle_text: card.oracle_text || "",
          mana_cost: card.mana_cost || "",
          cmc: card.cmc !== undefined ? card.cmc : 0,
          colors,
          rarity: card.rarity || "common"
        };
      } else {
        missingNames.push(name);
      }
    } catch (err) {
      missingNames.push(name);
    }
  });
  await Promise.all(localPromises);

  // 2. Fetch missing names from Scryfall collection endpoint in batches of 75
  if (missingNames.length > 0) {
    const batchSize = 75;
    for (let i = 0; i < missingNames.length; i += batchSize) {
      const chunk = missingNames.slice(i, i + batchSize);
      const identifiers = chunk.map(name => ({ name }));
      
      try {
        await delay(100); // Politeness delay
        const response = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "User-Agent": "Grimore/1.0 (grimore@lgs.com)",
            "Accept": "application/json"
          },
          body: JSON.stringify({ identifiers })
        });
        
        if (response.ok) {
          const resJson = await response.json();
          const cardsData = resJson.data || [];
          
          await db.run("BEGIN TRANSACTION");
          try {
            for (const card of cardsData) {
              const layout = card.layout || "";
              if (["token", "double_faced_token", "emblem", "art_series", "memorabilia"].includes(layout)) continue;

              const set_type = card.set_type || "";
              if (["funny", "token", "memorabilia"].includes(set_type)) continue;

              const border_color = card.border_color || "";
              if (border_color === "silver" || border_color === "gold") continue;

              if (card.digital) continue;

              const leg = card.legalities || {};
              const isLegalSomewhere = Object.values(leg).some(status => status === "legal" || status === "restricted");
              if (!isLegalSomewhere) continue;

              const name = card.name;
              const scryfallId = card.id || null;
              const type_line = card.type_line || "";
              const oracle_text = card.oracle_text || "";
              const mana_cost = card.mana_cost || "";
              const cmc = card.cmc !== undefined ? card.cmc : 0;
              const colors = card.colors || [];
              const rarity = card.rarity || "common";
              
              let minPrice = 0.05;
              if (card.prices) {
                const usd = parseFloat(card.prices.usd);
                const usdFoil = parseFloat(card.prices.usd_foil);
                const usdEtched = parseFloat(card.prices.usd_etched);
                
                let pVal = Infinity;
                if (usd && usd < pVal) pVal = usd;
                if (usdFoil && usdFoil < pVal) pVal = usdFoil;
                if (usdEtched && usdEtched < pVal) pVal = usdEtched;
                
                if (pVal !== Infinity) {
                  minPrice = pVal;
                }
              }
              
              await db.run(
                `INSERT OR REPLACE INTO scryfall_cards 
                 (card_name, price, scryfall_id, type_line, oracle_text, mana_cost, cmc, colors, rarity, last_updated) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [name, minPrice, scryfallId, type_line, oracle_text, mana_cost, cmc, JSON.stringify(colors), rarity]
              );
              
              chunk.forEach(reqName => {
                const isExactMatch = reqName.toLowerCase() === name.toLowerCase();
                const isDoubleFacedMatch = name.includes(' // ') && reqName.toLowerCase() === name.split(' // ')[0].toLowerCase();
                if (isExactMatch || isDoubleFacedMatch) {
                  results[reqName] = {
                    name, // official name
                    price: minPrice,
                    scryfallId,
                    type_line,
                    oracle_text,
                    mana_cost,
                    cmc,
                    colors,
                    rarity
                  };
                }
              });
            }
            await db.run("COMMIT");
          } catch (writeErr) {
            await db.run("ROLLBACK");
            throw writeErr;
          }
        }
      } catch (err) {
        console.warn("Scryfall batch resolve chunk failed for missing cards:", err.message);
      }
    }
  }

  // 3. Fallback for unresolved names using Scryfall search (filtering only tournament-legal paper prints)
  const unresolvedNames = uniqueNames.filter(name => !results[name]);
  if (unresolvedNames.length > 0) {
    for (const reqName of unresolvedNames) {
      try {
        await delay(100); // Politeness delay
        let searchUrl = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(reqName)}%22+not:funny+not:token+not:art+is:paper`;
        let response = await fetch(searchUrl, {
          headers: {
            "User-Agent": "Grimore/1.0 (grimore@lgs.com)",
            "Accept": "application/json"
          }
        });
        
        let card = null;
        if (response.ok) {
          const resJson = await response.json();
          card = resJson.data && resJson.data[0];
        } else if (response.status === 404) {
          // If exact match fails, try autocomplete search to find full name (e.g. "Aesi" -> "Aesi, Tyrant of Gyre Strait")
          await delay(100);
          const autoRes = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(reqName)}`, {
            headers: {
              "User-Agent": "Grimore/1.0 (grimore@lgs.com)",
              "Accept": "application/json"
            }
          });
          if (autoRes.ok) {
            const autoJson = await autoRes.json();
            const suggestions = autoJson.data || [];
            if (suggestions.length > 0) {
              const bestName = suggestions[0];
              await delay(100);
              let suggestSearchUrl = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(bestName)}%22+not:funny+not:token+not:art+is:paper`;
              const exactRes = await fetch(suggestSearchUrl, {
                headers: {
                  "User-Agent": "Grimore/1.0 (grimore@lgs.com)",
                  "Accept": "application/json"
                }
              });
              if (exactRes.ok) {
                const suggestJson = await exactRes.json();
                card = suggestJson.data && suggestJson.data[0];
              }
            }
          }
        }
        
        if (card) {
          const layout = card.layout || "";
          if (["token", "double_faced_token", "emblem", "art_series", "memorabilia"].includes(layout)) continue;

          const name = card.name;
          const scryfallId = card.id || null;
          const type_line = card.type_line || "";
          const oracle_text = card.oracle_text || "";
          const mana_cost = card.mana_cost || "";
          const cmc = card.cmc !== undefined ? card.cmc : 0;
          const colors = card.colors || [];
          const rarity = card.rarity || "common";
          
          let minPrice = 0.05;
          if (card.prices) {
            const usd = parseFloat(card.prices.usd);
            const usdLow = parseFloat(card.prices.usd_low);
            if (usd) minPrice = usd;
            if (usdLow && usdLow < minPrice) minPrice = usdLow;
          }

          // Cache it locally
          await db.run(
            `INSERT OR REPLACE INTO scryfall_cards 
             (card_name, price, scryfall_id, type_line, oracle_text, mana_cost, cmc, colors, rarity, last_updated) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [name, minPrice, scryfallId, type_line, oracle_text, mana_cost, cmc, JSON.stringify(colors), rarity]
          );

          results[reqName] = {
            name, // official name
            price: minPrice,
            scryfallId,
            type_line,
            oracle_text,
            mana_cost,
            cmc,
            colors,
            rarity
          };
        }
      } catch (err) {
        console.warn(`Scryfall exact fallback failed for: ${reqName}`, err.message);
      }
    }
  }

  // 4. Default fallback for completely unresolvable card names
  for (const name of uniqueNames) {
    if (!results[name]) {
      results[name] = {
        name,
        price: 0.10,
        scryfallId: null,
        type_line: "",
        oracle_text: "",
        mana_cost: "",
        cmc: 0,
        colors: [],
        rarity: "common"
      };
    }
  }

  return results;
}

async function validateDeckPrice(moxfieldUrl) {
  // Parse Moxfield Deck ID
  const match = moxfieldUrl.match(/moxfield\.com\/decks\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error("Invalid Moxfield URL structure.");
  }
  const deckId = match[1];

  // Fetch Moxfield public deck details
  const moxUrl = `https://api.moxfield.com/v2/decks/all/${deckId}`;
  const deckData = await fetchMoxfieldJson(moxUrl);

  const mainboard = deckData.mainboard || {};
  const cardNames = Object.keys(mainboard);

  let totalPrice = 0;
  const cardsWithPrices = [];

  // Resolve prices for all cards (cheapest version)
  for (let cardName of cardNames) {
    // Ignore basic lands
    const lowerName = cardName.toLowerCase();
    if (lowerName === "plains" || lowerName === "island" || lowerName === "swamp" || lowerName === "mountain" || lowerName === "forest" ||
        lowerName === "snow-covered plains" || lowerName === "snow-covered island" || lowerName === "snow-covered swamp" ||
        lowerName === "snow-covered mountain" || lowerName === "snow-covered forest" || lowerName === "wastes") {
      continue;
    }

    const { price } = await getCheapestCardPrice(cardName);
    const qty = mainboard[cardName].quantity || 1;
    totalPrice += price * qty;
    cardsWithPrices.push({ name: cardName, price: price, qty: qty });
  }

  const isLegal = totalPrice <= 100 ? 1 : 0;
  return {
    deckName: deckData.name || "Moxfield Budget Deck",
    totalPrice: parseFloat(totalPrice.toFixed(2)),
    isLegal,
    cards: cardsWithPrices
  };
}

function isBasicLand(name) {
  const lowerName = name.toLowerCase();
  return (lowerName === "plains" || lowerName === "island" || lowerName === "swamp" || lowerName === "mountain" || lowerName === "forest" ||
          lowerName === "snow-covered plains" || lowerName === "snow-covered island" || lowerName === "snow-covered swamp" ||
          lowerName === "snow-covered mountain" || lowerName === "snow-covered forest" || lowerName === "wastes");
}

async function validateDeckLegality(deckId) {
  try {
    const deck = await db.get("SELECT * FROM decks WHERE id = ?", [deckId]);
    if (!deck) return { isLegal: false, reason: "Deck not found" };

    const cards = await db.query("SELECT * FROM deck_cards WHERE deck_id = ?", [deckId]);
    if (cards.length === 0) return { isLegal: true, reason: "" };

    const activeSeason = await db.get("SELECT * FROM seasons WHERE is_active = 1");
    if (!activeSeason) {
      const limit = deck.budget_limit;
      const priceResult = await db.get("SELECT SUM(cheapest_card_price * quantity) as total FROM deck_cards WHERE deck_id = ?", [deckId]);
      const totalPrice = parseFloat((priceResult.total || 0).toFixed(2));
      const isLegal = (limit === null || totalPrice <= limit) ? 1 : 0;
      return { isLegal: isLegal === 1, reason: isLegal ? "" : "Exceeds deck budget limit" };
    }

    const budgetLimit = activeSeason.budget_limit !== null && activeSeason.budget_limit !== undefined ? parseFloat(activeSeason.budget_limit) : null;
    
    let banlist = [];
    try {
      banlist = activeSeason.banlist ? JSON.parse(activeSeason.banlist) : [];
    } catch (e) {
      banlist = [];
    }
    const bannedSet = new Set(banlist.map(name => name.toLowerCase().trim()));

    let allowedRarities = ["common", "uncommon", "rare", "mythic"];
    try {
      if (activeSeason.allowed_rarities) {
        allowedRarities = JSON.parse(activeSeason.allowed_rarities);
      }
    } catch (e) {}
    const allowedRaritiesSet = new Set(allowedRarities.map(r => r.toLowerCase().trim()));

    const maxRares = activeSeason.max_rares !== undefined && activeSeason.max_rares !== null ? parseInt(activeSeason.max_rares, 10) : -1;

    let allowedColors = ["W", "U", "B", "R", "G", "C"];
    try {
      if (activeSeason.allowed_colors) {
        allowedColors = JSON.parse(activeSeason.allowed_colors);
      }
    } catch (e) {}
    const allowedColorsSet = new Set(allowedColors.map(c => c.toUpperCase().trim()));

    let totalPrice = 0;
    let rareCount = 0;
    let hasBannedCard = false;
    let bannedCardName = "";
    let hasInvalidRarity = false;
    let invalidRarityCard = "";
    let hasInvalidColor = false;
    let invalidColorCard = "";

    const names = cards.map(c => c.card_name);
    const resolvedBatch = await resolveCardDetailsBatch(names);

    for (let c of cards) {
      const qty = c.quantity || 1;
      const price = parseFloat(c.cheapest_card_price) || 0;
      totalPrice += price * qty;

      const details = resolvedBatch[c.card_name] || {};
      const rarity = (details.rarity || 'common').toLowerCase();
      const isBasic = isBasicLand(c.card_name);

      if (bannedSet.has(c.card_name.toLowerCase())) {
        hasBannedCard = true;
        bannedCardName = c.card_name;
      }

      if (!isBasic) {
        if (!allowedRaritiesSet.has(rarity)) {
          hasInvalidRarity = true;
          invalidRarityCard = `${c.card_name} (${rarity})`;
        }

        if (rarity === "rare" || rarity === "mythic") {
          rareCount += qty;
        }
      }

      let cardColors = [];
      try {
        if (details.colors) {
          cardColors = typeof details.colors === 'string' ? JSON.parse(details.colors) : details.colors;
        }
      } catch (e) {}
      if (Array.isArray(cardColors)) {
        for (let col of cardColors) {
          if (!allowedColorsSet.has(col.toUpperCase())) {
            hasInvalidColor = true;
            invalidColorCard = `${c.card_name} (${col})`;
          }
        }
      }
    }

    if (budgetLimit !== null && totalPrice > budgetLimit) {
      return { isLegal: false, reason: `Exceeds season budget limit ($${totalPrice.toFixed(2)} / $${budgetLimit.toFixed(2)})` };
    }

    if (hasBannedCard) {
      return { isLegal: false, reason: `Contains banned card: ${bannedCardName}` };
    }

    if (hasInvalidRarity) {
      return { isLegal: false, reason: `Contains card with disallowed rarity: ${invalidRarityCard}` };
    }

    if (maxRares !== -1 && rareCount > maxRares) {
      return { isLegal: false, reason: `Exceeds max allowed Rares/Mythics (${rareCount} / ${maxRares})` };
    }

    if (hasInvalidColor) {
      return { isLegal: false, reason: `Contains card with disallowed color: ${invalidColorCard}` };
    }

    return { isLegal: true, reason: "" };
  } catch (err) {
    console.error("validateDeckLegality error:", err);
    return { isLegal: false, reason: "Error computing legality" };
  }
}

app.post('/api/decks/register', async (req, res) => {
  if (!req.session.player) {
    return res.status(401).json({ error: "Please log in first." });
  }
  const { moxfieldUrl, budgetLimit } = req.body;
  const parsedBudgetLimit = budgetLimit ? parseFloat(budgetLimit) : null;
  if (!moxfieldUrl) {
    return res.status(400).json({ error: "Missing Moxfield URL." });
  }

  try {
    // Parse Moxfield Deck ID
    const match = moxfieldUrl.match(/moxfield\.com\/decks\/([a-zA-Z0-9_-]+)/);
    if (!match) return res.status(400).json({ error: "Invalid Moxfield URL structure." });
    
    const deckIdMox = match[1];
    const moxUrl = `https://api.moxfield.com/v2/decks/all/${deckIdMox}`;
    const deckData = await fetchMoxfieldJson(moxUrl);

    const mainboard = deckData.mainboard || {};
    const commanders = deckData.commanders || {};
    
    // Check basic lands settings
    const includeBasicLands = deckData.includeBasicLandsInPrice === true;
    
    const deckFormat = (deckData.format || 'commander').toLowerCase();
    const allCardsMap = {};
    
    // Add commanders
    Object.keys(commanders).forEach(name => {
      const cardObj = commanders[name];
      let price = 0.10;
      let scryfallId = null;
      if (cardObj && cardObj.card) {
        scryfallId = cardObj.card.scryfall_id || cardObj.card.id || null;
        if (cardObj.card.prices) {
          const prices = cardObj.card.prices;
          const usd = parseFloat(prices.usd) || parseFloat(prices.usd_foil) || parseFloat(prices.ck) || parseFloat(prices.ck_foil) || 0.10;
          price = usd;
        }
      }
      const qty = cardObj.quantity || 1;
      allCardsMap[name] = { price, qty, scryfallId, isCommander: 1, customTag: cardObj.customCategory || null };
    });

    // Add mainboard
    Object.keys(mainboard).forEach(name => {
      const cardObj = mainboard[name];
      let price = 0.10;
      let scryfallId = null;
      if (cardObj && cardObj.card) {
        scryfallId = cardObj.card.scryfall_id || cardObj.card.id || null;
        if (cardObj.card.prices) {
          const prices = cardObj.card.prices;
          const usd = parseFloat(prices.usd);
          const usdFoil = parseFloat(prices.usd_foil);
          const ck = parseFloat(prices.ck);
          const ckFoil = parseFloat(prices.ck_foil);
          
          let minPrice = Infinity;
          if (usd && usd < minPrice) minPrice = usd;
          if (usdFoil && usdFoil < minPrice) minPrice = usdFoil;
          if (minPrice === Infinity) {
            if (ck && ck < minPrice) minPrice = ck;
            if (ckFoil && ckFoil < minPrice) minPrice = ckFoil;
          }
          price = minPrice === Infinity ? 0.10 : minPrice;
        }
      }
      
      // Zero out basic lands if they shouldn't be included
      if (isBasicLand(name) && !includeBasicLands) {
        price = 0.00;
      }
      
      const qty = cardObj.quantity || 1;
      if (allCardsMap[name]) {
        allCardsMap[name].qty += qty;
        // Keep commander status if already set
      } else {
        allCardsMap[name] = { price, qty, scryfallId, isCommander: 0, customTag: cardObj.customCategory || null };
      }
    });

    const cardNamesWithPrices = Object.keys(allCardsMap).map(name => {
      return {
        name,
        price: allCardsMap[name].price,
        qty: allCardsMap[name].qty,
        scryfallId: allCardsMap[name].scryfallId,
        isCommander: allCardsMap[name].isCommander,
        customTag: allCardsMap[name].customTag
      };
    });

    // Resolve and check Scryfall for all card details (such as price changes)
    const cardNames = cardNamesWithPrices.map(c => c.name);
    const resolvedDetails = await resolveCardDetailsBatch(cardNames);
    
    cardNamesWithPrices.forEach(card => {
      const details = resolvedDetails[card.name];
      if (details) {
        if (details.price !== undefined) {
          card.price = details.price;
        }
        if (details.scryfallId && !card.scryfallId) {
          card.scryfallId = details.scryfallId;
        }
      }
      // Zero out basic lands if they shouldn't be included
      if (isBasicLand(card.name) && !includeBasicLands) {
        card.price = 0.00;
      }
    });

    // Check for existing identical deck by URL, Moxfield ID, or deck name for this player
    let existingDeck = await db.get(
      "SELECT id FROM decks WHERE (moxfield_url = ? OR moxfield_url LIKE ?) AND player_id = ?",
      [moxfieldUrl, `%${deckIdMox}%`, req.session.player.id]
    );
    if (!existingDeck && deckData.name) {
      existingDeck = await db.get(
        "SELECT id FROM decks WHERE player_id = ? AND LOWER(deck_name) = LOWER(?)",
        [req.session.player.id, deckData.name.trim()]
      );
    }

    const deckId = existingDeck ? existingDeck.id : ('d_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
    
    const featuredCardName = computeFeaturedCard(commanders, cardNamesWithPrices);

    if (existingDeck) {
      await db.run(
        `UPDATE decks SET player_id = ?, moxfield_url = COALESCE(moxfield_url, ?), deck_name = ?, cheapest_total_price = 0, last_checked = CURRENT_TIMESTAMP, budget_limit = ?, featured_card_name = ?, include_basic_lands_in_price = ?, format = ?
         WHERE id = ?`,
        [req.session.player.id, moxfieldUrl, deckData.name || "Moxfield Deck", parsedBudgetLimit, featuredCardName, includeBasicLands ? 1 : 0, deckFormat, deckId]
      );
    } else {
      await db.run(
        `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, last_checked, is_legal, budget_limit, featured_card_name, include_basic_lands_in_price, is_public, format)
         VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, 0, ?, ?, ?, 0, ?)`,
        [deckId, req.session.player.id, moxfieldUrl, deckData.name || "Moxfield Deck", parsedBudgetLimit, featuredCardName, includeBasicLands ? 1 : 0, deckFormat]
      );
    }

    // Save individual card relations with Scryfall price as baseline, correct quantity and scryfallId
    await db.run("DELETE FROM deck_cards WHERE deck_id = ?", [deckId]);
    for (let card of cardNamesWithPrices) {
      await db.run(
        "INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, is_commander, custom_tag) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [deckId, card.name, card.price, card.qty, card.scryfallId, card.isCommander, card.customTag]
      );
    }

    // Initialize stats
    const activeSeason = await db.get("SELECT id FROM seasons WHERE is_active = 1");
    if (activeSeason) {
      await db.run(
        "INSERT OR IGNORE INTO deck_stats (deck_id, season_id) VALUES (?, ?)",
        [deckId, activeSeason.id]
      );
    }

    res.json({ success: true, deckId, cardNames: cardNamesWithPrices.map(c => c.name), deckName: deckData.name || "Moxfield Deck" });
  } catch (e) {
    console.error("Deck registration error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/moxfield/import-account', async (req, res) => {
  if (!req.session.player) {
    return res.status(401).json({ error: "Please log in first." });
  }
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: "Moxfield username is required." });
  }

  try {
    // 1. Fetch public decks from search endpoint (paginated)
    let pageNumber = 1;
    let allMoxDecks = [];
    let hasMore = true;
    const maxPages = 25; // Supports up to 2,500 public decks per Moxfield account

    while (hasMore && pageNumber <= maxPages) {
      const searchUrl = `https://api2.moxfield.com/v2/decks/search?authorUsernames=${encodeURIComponent(username.trim())}&pageNumber=${pageNumber}&pageSize=100&sortType=updated&sortDirection=Descending`;
      console.log(`Fetching Moxfield decks page ${pageNumber} for user ${username}...`);
      const responseData = await fetchMoxfieldJson(searchUrl);
      
      const decksPage = responseData.data || [];
      allMoxDecks = allMoxDecks.concat(decksPage);
      
      if (decksPage.length < 100 || allMoxDecks.length >= (responseData.totalResults || 0)) {
        hasMore = false;
      } else {
        pageNumber++;
      }
    }

    if (allMoxDecks.length === 0) {
      return res.json({ success: true, importedCount: 0, importedDecks: [], message: "No public decks found for this user." });
    }

    console.log(`Found ${allMoxDecks.length} public decks on Moxfield. Fetching lists in parallel batches...`);
    const decksToProcess = [];
    const skippedDecks = [];

    const batchSize = 3;
    for (let i = 0; i < allMoxDecks.length; i += batchSize) {
      const chunk = allMoxDecks.slice(i, i + batchSize);
      await Promise.all(chunk.map(async (moxDeck) => {
        const deckIdMox = moxDeck.publicId;
        const moxfieldUrl = `https://www.moxfield.com/decks/${deckIdMox}`;
        
        // Check for existing deck by URL, Moxfield ID, or deck name for this player
        let existingDeck = await db.get(
          "SELECT id, player_id FROM decks WHERE moxfield_url = ? OR moxfield_url LIKE ?",
          [moxfieldUrl, `%${deckIdMox}%`]
        );
        if (!existingDeck && moxDeck.name) {
          existingDeck = await db.get(
            "SELECT id, player_id FROM decks WHERE player_id = ? AND LOWER(deck_name) = LOWER(?)",
            [req.session.player.id, moxDeck.name.trim()]
          );
        }
        if (existingDeck && existingDeck.player_id !== req.session.player.id) {
          console.log(`Re-assigning existing deck ${moxDeck.name} (${moxfieldUrl}) to active importing player ${req.session.player.id}...`);
        }

        try {
          const moxUrl = `https://api2.moxfield.com/v2/decks/all/${deckIdMox}`;
          const deckData = await fetchMoxfieldJson(moxUrl);

          const deckFormat = (deckData.format || moxDeck.format || 'commander').toLowerCase();
          const commanders = deckData.commanders || {};
          const includeBasicLands = deckData.includeBasicLandsInPrice === true;

          const cardsMap = {};
          
          const boardSections = [
            { board: deckData.commanders || {}, isCommander: 1 },
            { board: deckData.mainboard || {}, isCommander: 0 },
            { board: deckData.sideboard || {}, isCommander: 0 },
            { board: deckData.companion || {}, isCommander: 0 },
            { board: deckData.signatureSpells || {}, isCommander: 0 },
            { board: deckData.attractions || {}, isCommander: 0 },
            { board: deckData.stickers || {}, isCommander: 0 }
          ];

          boardSections.forEach(({ board, isCommander }) => {
            Object.keys(board).forEach(name => {
              const cardObj = board[name];
              let price = 0.10;
              let scryfallId = null;
              if (cardObj && cardObj.card) {
                scryfallId = cardObj.card.scryfall_id || cardObj.card.id || null;
                if (cardObj.card.prices) {
                  const prices = cardObj.card.prices;
                  const usd = parseFloat(prices.usd) || parseFloat(prices.usd_foil) || parseFloat(prices.ck) || parseFloat(prices.ck_foil) || 0.10;
                  price = usd;
                }
              }
              if (isBasicLand(name) && !includeBasicLands) {
                price = 0.00;
              }
              const qty = cardObj.quantity || 1;
              if (cardsMap[name]) {
                cardsMap[name].qty += qty;
                if (isCommander) cardsMap[name].isCommander = 1;
              } else {
                cardsMap[name] = { price, qty, scryfallId, isCommander, customTag: cardObj.customCategory || null };
              }
            });
          });

          decksToProcess.push({
            publicId: deckIdMox,
            moxfieldUrl,
            name: deckData.name || moxDeck.name || "Moxfield Deck",
            includeBasicLands,
            cardsMap,
            commanders,
            format: deckFormat,
            existingId: existingDeck ? existingDeck.id : null
          });
        } catch (deckErr) {
          console.error(`Failed to fetch details for deck ${moxDeck.name || deckIdMox}:`, deckErr);
          skippedDecks.push({ name: moxDeck.name || 'Moxfield Deck', error: `Fetch failed: ${deckErr.message}` });
        }
      }));
    }

    // 2. Resolve all unique card names across all decks in a single batch
    const allCardNamesSet = new Set();
    decksToProcess.forEach(d => {
      Object.keys(d.cardsMap).forEach(name => allCardNamesSet.add(name));
    });
    const allCardNames = [...allCardNamesSet];
    console.log(`Resolving details for ${allCardNames.length} unique cards in bulk...`);
    const resolvedDetails = await resolveCardDetailsBatch(allCardNames);

    const importedDecks = [];
    const activeSeason = await db.get("SELECT id FROM seasons WHERE is_active = 1");

    // 3. Write each deck and its cards to DB inside a fast transaction
    await db.run("BEGIN TRANSACTION");
    try {
      for (const d of decksToProcess) {
        const deckId = d.existingId || ('d_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
        
        let totalPrice = 0;
        const cardNamesWithPrices = Object.keys(d.cardsMap).map(name => {
          const card = d.cardsMap[name];
          const details = resolvedDetails[name];
          if (details) {
            if (details.price !== undefined) card.price = details.price;
            if (details.scryfallId && !card.scryfallId) card.scryfallId = details.scryfallId;
          }
          if (isBasicLand(name) && !d.includeBasicLands) {
            card.price = 0.00;
          }
          totalPrice += (card.price * card.qty);
          return {
            name,
            price: card.price,
            qty: card.qty,
            scryfallId: card.scryfallId,
            isCommander: card.isCommander,
            customTag: card.customTag
          };
        });

        totalPrice = parseFloat(totalPrice.toFixed(2));
        const featuredCardName = computeFeaturedCard(d.commanders, cardNamesWithPrices);

        if (d.existingId) {
          await db.run(
            `UPDATE decks SET player_id = ?, moxfield_url = COALESCE(moxfield_url, ?), deck_name = ?, cheapest_total_price = ?, last_checked = CURRENT_TIMESTAMP, featured_card_name = ?, include_basic_lands_in_price = ?, format = ?
             WHERE id = ?`,
            [req.session.player.id, d.moxfieldUrl, d.name, totalPrice, featuredCardName, d.includeBasicLands ? 1 : 0, d.format, deckId]
          );
        } else {
          await db.run(
            `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, last_checked, is_legal, budget_limit, featured_card_name, include_basic_lands_in_price, is_public, format)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0, null, ?, ?, 0, ?)`,
            [deckId, req.session.player.id, d.moxfieldUrl, d.name, totalPrice, featuredCardName, d.includeBasicLands ? 1 : 0, d.format]
          );
        }

        // Save cards in bulk
        await db.run("DELETE FROM deck_cards WHERE deck_id = ?", [deckId]);
        
        if (cardNamesWithPrices.length > 0) {
          const placeholders = cardNamesWithPrices.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
          const flatParams = [];
          cardNamesWithPrices.forEach(c => {
            flatParams.push(deckId, c.name, c.price, c.qty, c.scryfallId, c.isCommander, c.customTag);
          });
          await db.run(
            `INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, is_commander, custom_tag) VALUES ${placeholders}`,
            flatParams
          );
        }

        // Initialize stats
        if (activeSeason) {
          await db.run(
            "INSERT OR IGNORE INTO deck_stats (deck_id, season_id) VALUES (?, ?)",
            [deckId, activeSeason.id]
          );
        }

        const validation = await validateDeckLegality(deckId);
        const isLegal = validation.isLegal ? 1 : 0;
        const legalityReason = validation.reason || null;

        await db.run(
          "UPDATE decks SET is_legal = ?, legality_reason = ? WHERE id = ?",
          [isLegal, legalityReason, deckId]
        );

        importedDecks.push({
          name: d.name,
          moxfieldUrl: d.moxfieldUrl,
          totalPrice,
          isLegal: isLegal === 1,
          legalityReason
        });
      }
      await db.run("COMMIT");
    } catch (txErr) {
      await db.run("ROLLBACK");
      throw txErr;
    }

    res.json({
      success: true,
      importedCount: importedDecks.length,
      importedDecks,
      skippedDecks,
      message: `Successfully imported/updated ${importedDecks.length} decks.`
    });

  } catch (e) {
    console.error("Moxfield Account Import error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/decks/reprice-init/:deckId', async (req, res) => {
  const { deckId } = req.params;
  try {
    // Check if deck is locked because pairings have been generated for the active season
    const activePairings = await db.get(`
      SELECT 1 FROM active_roster ar
      JOIN seasons s ON s.is_active = 1
      JOIN pods p ON p.season_id = s.id
      WHERE ar.deck_id = ?
    `, [deckId]);
    
    if (activePairings) {
      return res.status(400).json({ error: "Deck is locked. You cannot update a deck during an active tournament." });
    }

    const deck = await db.get("SELECT * FROM decks WHERE id = ?", [deckId]);
    if (!deck) return res.status(404).json({ error: "Deck not found." });

    // Handle manually created or pasted text decks (without a real Moxfield URL)
    if (!deck.moxfield_url || !deck.moxfield_url.includes('moxfield.com/decks/')) {
      // Get all current cards in this deck from local db
      const localCards = await db.query(
        "SELECT card_name, quantity, scryfall_id, is_commander, custom_tag FROM deck_cards WHERE deck_id = ?",
        [deckId]
      );
      
      const cardNames = localCards.map(c => c.card_name);
      const resolvedDetails = await resolveCardDetailsBatch(cardNames);
      
      // Update local card prices
      await db.run("BEGIN TRANSACTION");
      try {
        for (let card of localCards) {
          const details = resolvedDetails[card.card_name] || {};
          const price = details.price || 0.10;
          const scryfallId = details.scryfallId || card.scryfall_id;
          const officialName = details.name || card.card_name;
          await db.run(
            "UPDATE deck_cards SET card_name = ?, cheapest_card_price = ?, scryfall_id = ? WHERE deck_id = ? AND card_name = ?",
            [officialName, price, scryfallId, deckId, card.card_name]
          );
        }
        await db.run("COMMIT");
      } catch (writeErr) {
        await db.run("ROLLBACK");
        throw writeErr;
      }
      
      return res.json({ success: true, cardNames: cardNames, deckName: deck.deck_name });
    }

    // Fetch Moxfield public deck details to sync card changes if Moxfield URL exists
    const match = deck.moxfield_url.match(/moxfield\.com\/decks\/([a-zA-Z0-9_-]+)/);
    if (!match) return res.status(400).json({ error: "Invalid Moxfield URL structure." });
    
    const deckIdMox = match[1];
    const moxUrl = `https://api.moxfield.com/v2/decks/all/${deckIdMox}`;
    const deckData = await fetchMoxfieldJson(moxUrl);

    const mainboard = deckData.mainboard || {};
    const commanders = deckData.commanders || {};
    
    // Check basic lands settings
    const includeBasicLands = deckData.includeBasicLandsInPrice === true;
    
    const allCardsMap = {};
    
    // Add commanders
    Object.keys(commanders).forEach(name => {
      const cardObj = commanders[name];
      let price = 0.10;
      let scryfallId = null;
      if (cardObj && cardObj.card) {
        scryfallId = cardObj.card.scryfall_id || null;
        if (cardObj.card.prices) {
          const prices = cardObj.card.prices;
          const usd = parseFloat(prices.usd);
          const usdFoil = parseFloat(prices.usd_foil);
          const ck = parseFloat(prices.ck);
          const ckFoil = parseFloat(prices.ck_foil);
          
          let minPrice = Infinity;
          if (usd && usd < minPrice) minPrice = usd;
          if (usdFoil && usdFoil < minPrice) minPrice = usdFoil;
          if (minPrice === Infinity) {
            if (ck && ck < minPrice) minPrice = ck;
            if (ckFoil && ckFoil < minPrice) minPrice = ckFoil;
          }
          price = minPrice === Infinity ? 0.10 : minPrice;
        }
      }
      const qty = cardObj.quantity || 1;
      allCardsMap[name] = { price, qty, scryfallId, isCommander: 1, customTag: cardObj.customCategory || null };
    });

    // Add mainboard
    Object.keys(mainboard).forEach(name => {
      const cardObj = mainboard[name];
      let price = 0.10;
      let scryfallId = null;
      if (cardObj && cardObj.card) {
        scryfallId = cardObj.card.scryfall_id || null;
        if (cardObj.card.prices) {
          const prices = cardObj.card.prices;
          const usd = parseFloat(prices.usd);
          const usdFoil = parseFloat(prices.usd_foil);
          const ck = parseFloat(prices.ck);
          const ckFoil = parseFloat(prices.ck_foil);
          
          let minPrice = Infinity;
          if (usd && usd < minPrice) minPrice = usd;
          if (usdFoil && usdFoil < minPrice) minPrice = usdFoil;
          if (minPrice === Infinity) {
            if (ck && ck < minPrice) minPrice = ck;
            if (ckFoil && ckFoil < minPrice) minPrice = ckFoil;
          }
          price = minPrice === Infinity ? 0.10 : minPrice;
        }
      }
      
      // Zero out basic lands if they shouldn't be included
      if (isBasicLand(name) && !includeBasicLands) {
        price = 0.00;
      }
      
      const qty = cardObj.quantity || 1;
      if (allCardsMap[name]) {
        allCardsMap[name].qty += qty;
      } else {
        allCardsMap[name] = { price, qty, scryfallId, isCommander: 0, customTag: cardObj.customCategory || null };
      }
    });

    const cardNamesWithPrices = Object.keys(allCardsMap).map(name => {
      return {
        name,
        price: allCardsMap[name].price,
        qty: allCardsMap[name].qty,
        scryfallId: allCardsMap[name].scryfallId,
        isCommander: allCardsMap[name].isCommander || 0,
        customTag: allCardsMap[name].customTag || null
      };
    });

    // Resolve details to get official names and IDs
    const cardNames = cardNamesWithPrices.map(c => c.name);
    const resolvedDetails = await resolveCardDetailsBatch(cardNames);
    
    cardNamesWithPrices.forEach(card => {
      const details = resolvedDetails[card.name];
      if (details) {
        if (details.name) card.name = details.name; // Use official resolved name
        if (details.price !== undefined) card.price = details.price;
        if (details.scryfallId) card.scryfallId = details.scryfallId;
      }
      // Zero out basic lands if they shouldn't be included
      if (isBasicLand(card.name) && !includeBasicLands) {
        card.price = 0.00;
      }
    });

    // Delete existing deck cards, and insert fresh list with Moxfield price as fallback, correct quantity and scryfallId
    await db.run("DELETE FROM deck_cards WHERE deck_id = ?", [deckId]);
    for (let card of cardNamesWithPrices) {
      await db.run(
        "INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, is_commander, custom_tag) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [deckId, card.name, card.price, card.qty, card.scryfallId, card.isCommander, card.customTag]
      );
    }

    await db.run(
      "UPDATE decks SET deck_name = ?, include_basic_lands_in_price = ? WHERE id = ?",
      [deckData.name || deck.deck_name, includeBasicLands ? 1 : 0, deckId]
    );

    res.json({ success: true, cardNames: cardNamesWithPrices.map(c => c.name), deckName: deckData.name || deck.deck_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/reprice-card', async (req, res) => {
  const { deckId, cardName } = req.body;
  try {
    // Retrieve the price directly from what was initialized from Moxfield
    const current = await db.get("SELECT cheapest_card_price FROM deck_cards WHERE deck_id = ? AND card_name = ?", [deckId, cardName]);
    const price = current ? current.cheapest_card_price : 0.10;
    
    // Save to card cache so other views and tickers are fed
    await db.run(
      "INSERT OR REPLACE INTO card_price_cache (card_name, price, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
      [cardName, price]
    );

    res.json({ success: true, cardName, price });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/reprice-finalize/:deckId', async (req, res) => {
  const { deckId } = req.params;
  try {
    const result = await db.get("SELECT SUM(cheapest_card_price * quantity) as total FROM deck_cards WHERE deck_id = ?", [deckId]);
    const totalPrice = parseFloat((result.total || 0).toFixed(2));
    
    // Validate deck legality against all active rules (banlist, rarities, colors, budget)
    const validation = await validateDeckLegality(deckId);
    const isLegal = validation.isLegal ? 1 : 0;
    const legalityReason = validation.reason || null;

    await db.run(
      "UPDATE decks SET cheapest_total_price = ?, last_checked = CURRENT_TIMESTAMP, is_legal = ?, legality_reason = ? WHERE id = ?",
      [totalPrice, isLegal, legalityReason, deckId]
    );

    res.json({ success: true, totalPrice, isLegal: isLegal === 1, reason: legalityReason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HELPER: Fetch card tags from Scryfall Tagger
async function fetchCardTags(cardName, scryfallId) {
  // 1. Check local cache first
  try {
    const cached = await db.get("SELECT tags FROM scryfall_card_tags WHERE card_name = ?", [cardName]);
    if (cached) {
      console.log(`[Auto Tag] Found cached tags for: ${cardName}`);
      return JSON.parse(cached.tags || '[]');
    }
  } catch (e) {
    console.error("Local tags cache lookup failed:", e);
  }

  // 2. Wrap network operations with a strict 1.5s timeout so auto-tagging never hangs
  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 1500));
  const fetchPromise = (async () => {
    let setCode = null;
    let collectorNumber = null;

    try {
      let cardData = null;
      if (scryfallId) {
        cardData = await fetchJson(`https://api.scryfall.com/cards/${scryfallId}`);
      } else {
        cardData = await fetchJson(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cardName)}`);
      }

      if (cardData) {
        setCode = cardData.set;
        collectorNumber = cardData.collector_number;
      }
    } catch (err) {
      console.error(`[Auto Tag] Failed to resolve Scryfall metadata for card ${cardName}:`, err.message);
    }

    if (!setCode || !collectorNumber) {
      return [];
    }

    let tags = [];
    try {
      const taggerUrl = `https://tagger.scryfall.com/card/${setCode.toLowerCase()}/${collectorNumber.toLowerCase()}`;
      console.log(`[Auto Tag] Scraping tags from: ${taggerUrl}`);
      const html = await fetchHtml(taggerUrl);
      
      const metaMatch = html.match(/<meta name="description" content="([\s\S]+?)"\s*\/?>/i) || 
                        html.match(/<meta property="og:description" content="([\s\S]+?)"\s*\/?>/i);
                        
      if (metaMatch) {
        const description = metaMatch[1];
        const cardTagsIndex = description.indexOf("Card Tags:");
        if (cardTagsIndex !== -1) {
          const tagsText = description.substring(cardTagsIndex);
          tags = [...tagsText.matchAll(/(?:★|•)\s*([^\r\n"•★]+)/g)].map(m => m[1].trim());
        }
      }
    } catch (err) {
      console.error(`[Auto Tag] Failed to fetch/parse tagger page for card ${cardName}:`, err.message);
    }

    try {
      await db.run(
        "INSERT OR REPLACE INTO scryfall_card_tags (card_name, tags, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
        [cardName, JSON.stringify(tags)]
      );
    } catch (e) {
      console.error("Failed to save parsed tags to cache:", e);
    }

    return tags;
  })();

  return Promise.race([fetchPromise, timeoutPromise]);
}

// HELPER: Infinite Combo Database & Detector
const INFINITE_COMBO_DATABASE = [
  { name: "Combo: Heliod + Walking Ballista", cards: ["Heliod, Sun-Crowned", "Walking Ballista"] },
  { name: "Combo: Thassa's Oracle + Demonic Consultation", cards: ["Thassa's Oracle", "Demonic Consultation"] },
  { name: "Combo: Thassa's Oracle + Tainted Pact", cards: ["Thassa's Oracle", "Tainted Pact"] },
  { name: "Combo: Peregrine Drake + Deadeye Navigator", cards: ["Peregrine Drake", "Deadeye Navigator"] },
  { name: "Combo: Hazel's Brewmaster + Devoted Druid", cards: ["Hazel's Brewmaster", "Devoted Druid"] },
  { name: "Combo: Chain of Smog + Witherbloom Apprentice", cards: ["Chain of Smog", "Witherbloom Apprentice"] },
  { name: "Combo: Chain of Smog + Professor Onyx", cards: ["Chain of Smog", "Professor Onyx"] },
  { name: "Combo: Kiki-Jiki + Zealous Conscripts", cards: ["Kiki-Jiki, Mirror Breaker", "Zealous Conscripts"] },
  { name: "Combo: Kiki-Jiki + Deceiver Exarch", cards: ["Kiki-Jiki, Mirror Breaker", "Deceiver Exarch"] },
  { name: "Combo: Kiki-Jiki + Pestermite", cards: ["Kiki-Jiki, Mirror Breaker", "Pestermite"] },
  { name: "Combo: Kiki-Jiki + Felidar Guardian", cards: ["Kiki-Jiki, Mirror Breaker", "Felidar Guardian"] },
  { name: "Combo: Splinter Twin + Deceiver Exarch", cards: ["Splinter Twin", "Deceiver Exarch"] },
  { name: "Combo: Splinter Twin + Pestermite", cards: ["Splinter Twin", "Pestermite"] },
  { name: "Combo: Dualcaster Mage + Twinflame", cards: ["Dualcaster Mage", "Twinflame"] },
  { name: "Combo: Dualcaster Mage + Heat Shimmer", cards: ["Dualcaster Mage", "Heat Shimmer"] },
  { name: "Combo: Sanguine Bond + Exquisite Blood", cards: ["Sanguine Bond", "Exquisite Blood"] },
  { name: "Combo: Basalt Monolith + Rings of Brighthearth", cards: ["Basalt Monolith", "Rings of Brighthearth"] },
  { name: "Combo: Basalt Monolith + Forsaken Monument", cards: ["Basalt Monolith", "Forsaken Monument"] },
  { name: "Combo: Grim Monolith + Power Artifact", cards: ["Grim Monolith", "Power Artifact"] },
  { name: "Combo: Phyrexian Altar + Gravecrawler", cards: ["Phyrexian Altar", "Gravecrawler"] },
  { name: "Combo: Ashnod's Altar + Nim Deathmantle", cards: ["Ashnod's Altar", "Nim Deathmantle"] },
  { name: "Combo: Painter's Servant + Grindstone", cards: ["Painter's Servant", "Grindstone"] },
  { name: "Combo: Mindcrank + Bloodchief Ascension", cards: ["Mindcrank", "Bloodchief Ascension"] },
  { name: "Combo: Mindcrank + Duskmantle Guildmage", cards: ["Mindcrank", "Duskmantle Guildmage"] },
  { name: "Combo: Freed from the Real + Bloom Tender", cards: ["Freed from the Real", "Bloom Tender"] },
  { name: "Combo: Freed from the Real + Faeburrow Elder", cards: ["Freed from the Real", "Faeburrow Elder"] },
  { name: "Combo: Pemmin's Aura + Bloom Tender", cards: ["Pemmin's Aura", "Bloom Tender"] },
  { name: "Combo: Pemmin's Aura + Faeburrow Elder", cards: ["Pemmin's Aura", "Faeburrow Elder"] },
  { name: "Combo: Sensei's Divining Top + Bolas's Citadel", cards: ["Sensei's Divining Top", "Bolas's Citadel"] },
  { name: "Combo: Godo + Helm of the Host", cards: ["Godo, Bandit Warlord", "Helm of the Host"] },
  { name: "Combo: Malcolm + Glint-Horn Buccaneer", cards: ["Malcolm, Keen-Eyed Navigator", "Glint-Horn Buccaneer"] },
  { name: "Combo: Niv-Mizzet + Curiosity", cards: ["Niv-Mizzet, Parun", "Curiosity"] },
  { name: "Combo: Niv-Mizzet + Curiosity", cards: ["Niv-Mizzet, the Firemind", "Curiosity"] },
  { name: "Combo: Niv-Mizzet + Ophidian Eye", cards: ["Niv-Mizzet, Parun", "Ophidian Eye"] },
  { name: "Combo: Niv-Mizzet + Tandem Lookout", cards: ["Niv-Mizzet, Parun", "Tandem Lookout"] },
  { name: "Combo: Stella Lee + Twisted Fealty", cards: ["Stella Lee, Wild Card", "Twisted Fealty"] },
  { name: "Combo: Earthcraft + Squirrel Nest", cards: ["Earthcraft", "Squirrel Nest"] }
];

function normalizeCardName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detectInfiniteCombos(deckCardNames) {
  const cardSet = new Set((deckCardNames || []).map(normalizeCardName));
  const comboTagsMap = {};

  INFINITE_COMBO_DATABASE.forEach(combo => {
    const hasAllPieces = combo.cards.every(c => cardSet.has(normalizeCardName(c)));
    if (hasAllPieces) {
      combo.cards.forEach(c => {
        const norm = normalizeCardName(c);
        if (!comboTagsMap[norm]) comboTagsMap[norm] = new Set();
        comboTagsMap[norm].add(combo.name);
      });
    }
  });

  return comboTagsMap;
}

function categorizeCardByTags(cardName, typeLine, tags = [], oracleText = '') {
  const matchedTags = new Set();
  const type = (typeLine || '').toLowerCase();
  const oracle = (oracleText || '').toLowerCase();
  const name = (cardName || '').toLowerCase().trim();

  // 0. High-Precision Functional Overrides for MTG Staples
  if (name === 'sol ring' || name === 'arcane signet' || name === 'mana crypt' || name === 'mana vault' || name === 'fellwar stone' || name === 'thought vessel' || name === 'mind stone' || name.includes('talisman of') || name.includes('signet') || name === 'cultivate' || name === 'kodama\'s reach' || name === 'farseek' || name === 'three visits' || name === 'nature\'s lore' || name === 'birds of paradise' || name === 'llanowar elves' || name === 'fyndhorn elves' || name === 'elvish mystic' || name === 'delighted halfling' || name === 'carpet of flowers' || name === 'dockside extortionist' || name === 'smothering tithe') {
    matchedTags.add('Ramp');
    return Array.from(matchedTags);
  }

  if (name === 'rhystic study' || name === 'mystic remora' || name === 'phyrexian arena' || name === 'sylvan library' || name === 'skullclamp' || name === 'esper sentinel' || name === 'ledger shredder' || name === 'ghostly pilferer' || name === 'syphon mind' || name.includes('nezahal') || name === 'black market connections') {
    matchedTags.add('Card Advantage');
    return Array.from(matchedTags);
  }

  if (name === 'swords to plowshares' || name === 'path to exile' || name === 'beast within' || name === 'generous gift' || name === 'chaos warp' || name === 'feed the swarm' || name === 'counterspell' || name === 'dovin\'s veto' || name === 'arcane denial' || name === 'fierce guardianship' || name === 'force of will' || name === 'swan song' || name === 'an offer you can\'t refuse' || name === 'deadly rollick' || name === 'snuff out' || name === 'infernal grasp' || name === 'assassin\'s trophy' || name === 'abrupt decay' || name === 'nature\'s claim' || name === 'strix serenade') {
    matchedTags.add('Single Target Removal');
    return Array.from(matchedTags);
  }

  if (name === 'toxic deluge' || name === 'blasphemous act' || name === 'wrath of god' || name === 'damnation' || name === 'cyclonic rift' || name === 'farewell' || name === 'vanquish the horde' || name === 'supreme verdict' || name === 'culling ritual' || name === 'day of black sun' || name === 'the meathook massacre') {
    matchedTags.add('Mass Removal');
    return Array.from(matchedTags);
  }

  if (name === 'demonic tutor' || name === 'vampiric tutor' || name === 'worldy tutor' || name === 'mystical tutor' || name === 'enlightened tutor' || name === 'gamble' || name === 'green sun\'s zenith' || name === 'finale of devastation') {
    matchedTags.add('Tutors');
    return Array.from(matchedTags);
  }

  if (name === 'heroic intervention' || name === 'teferi\'s protection' || name === 'flawless maneuver' || name === 'lightning greaves' || name === 'swiftfoot boots' || name === 'clever concealment' || name === 'tamiyo\'s safekeeping' || name === 'veil of summer' || name === 'deflecting swat' || name === 'boros charm') {
    matchedTags.add('Protection');
    return Array.from(matchedTags);
  }

  // 1. Tutors
  if (oracle.includes('search your library for a card') || oracle.includes('search your library for an') || oracle.includes('search your library for a creature') || oracle.includes('search your library for a instant') || oracle.includes('search your library for a sorcery') || oracle.includes('search your library for a enchantment')) {
    matchedTags.add('Tutors');
  }

  // 2. Stax
  if (oracle.includes('spells cost {') || oracle.includes('opponents can\'t cast') || oracle.includes('can\'t untap')) {
    matchedTags.add('Stax');
  }

  // 3. Mass Removal vs Single Target Removal
  const isMass = oracle.includes('destroy all') || oracle.includes('exile all') || oracle.includes('each creature gets -') || oracle.includes('destroy all nonland') || oracle.includes('return all');
  if (isMass) {
    matchedTags.add('Mass Removal');
  } else if (oracle.includes('destroy target') || oracle.includes('exile target') || oracle.includes('counter target spell') || oracle.includes('return target permanent') || (oracle.includes('deal') && oracle.includes('damage to target'))) {
    matchedTags.add('Single Target Removal');
  }

  // 4. Protection
  if (oracle.includes('permanents you control gain') || oracle.includes('creatures you control gain') || oracle.includes('you gain hexproof') || oracle.includes('equipped creature has hexproof') || oracle.includes('equipped creature has shroud')) {
    matchedTags.add('Protection');
  }

  // 5. Ramp
  const isLand = type.includes('land');
  if (!isLand && (oracle.includes('add {') || oracle.includes('add one mana') || oracle.includes('search your library for a land') || oracle.includes('you may play an additional land'))) {
    matchedTags.add('Ramp');
  }

  // 6. Card Advantage vs Card Selection
  if (oracle.includes('draw two cards') || oracle.includes('draw three cards') || oracle.includes('draw cards equal') || (oracle.includes('whenever') && oracle.includes('draw a card')) || oracle.includes('at the beginning of your upkeep, draw')) {
    matchedTags.add('Card Advantage');
  } else if (oracle.includes('look at the top') || oracle.includes('scry') || oracle.includes('surveil') || oracle.includes('draw a card, then discard')) {
    matchedTags.add('Card Selection');
  }

  // 7. Reanimation & Recursion
  if (oracle.includes('from a graveyard to the battlefield') || oracle.includes('from your graveyard to the battlefield')) {
    matchedTags.add('Reanimation');
  } else if (oracle.includes('from your graveyard to your hand')) {
    matchedTags.add('Recursion');
  }

  // 8. Graveyard Fillers & Sacrifice Outlets
  if (oracle.includes('mill ') || oracle.includes('cards into your graveyard')) {
    matchedTags.add('Graveyard Fillers');
  }
  if (oracle.includes('sacrifice a creature:') || oracle.includes('sacrifice a permanent:')) {
    matchedTags.add('Sacrifice Outlets');
  }

  // 9. Tokens & Swarm
  if (oracle.includes('populate') || oracle.includes('create a 1/1') || oracle.includes('create a 2/2') || oracle.includes('create a 3/3') || oracle.includes('create a 4/4') || oracle.includes('create X') || oracle.includes('tokens you control')) {
    matchedTags.add('Tokens & Swarm');
  }

  // 10. Equipment & Auras
  if (type.includes('equipment') || type.includes('aura') || oracle.includes('equipped creature') || oracle.includes('enchanted creature')) {
    matchedTags.add('Equipment & Auras');
  }

  // 11. Archetype Engines
  if (type.includes('enchantment') && matchedTags.size === 0) {
    matchedTags.add('Enchantments');
  }
  if (oracle.includes('landfall')) {
    matchedTags.add('Landfall');
  }
  if ((oracle.includes('instant') || oracle.includes('sorcery')) && (oracle.includes('whenever you cast') || oracle.includes('magecraft') || oracle.includes('copy target instant'))) {
    matchedTags.add('Spellslinger');
  }

  // Blink & ETB (Battlefield exile and return ONLY; excludes Reanimation from graveyard!)
  const isReanimation = matchedTags.has('Reanimation') || oracle.includes('from a graveyard') || oracle.includes('from your graveyard');
  if (!isReanimation && oracle.includes('exile') && oracle.includes('return') && (oracle.includes('to the battlefield') || oracle.includes('battlefield under'))) {
    matchedTags.add('Blink & ETB');
  }

  // 12. Utility Lands vs Lands (Fetch lands belong ONLY in Lands, never Utility Lands)
  if (isLand) {
    const isFetchLand = oracle.includes('pay 1 life, sacrifice') || oracle.includes('search your library for a land card') || oracle.includes('search your library for a basic land') || name.includes('delta') || name.includes('rainforest') || name.includes('tarn') || name.includes('catacombs') || name.includes('mesa') || name.includes('flats') || name.includes('mire') || name.includes('strand') || name.includes('foothills') || name.includes('heath') || name === 'prismatic vista' || name === 'fabled passage';
    
    const isUtilityLand = !isFetchLand && !type.includes('basic land') && (
      oracle.includes('dredge') || oracle.includes('no maximum hand size') ||
      oracle.includes('exile target card from a graveyard') || oracle.includes('destroy target land') ||
      oracle.includes('prevent all combat damage') || oracle.includes('can\'t be blocked') ||
      name === 'dakmor salvage' || name === 'reliquary tower' || name === 'urza\'s saga' || name === 'bojuka bog' || name === 'strip mine' || name === 'wasteland' || name === 'maze of ith' || name === 'rogue\'s passage' || name === 'high market'
    );
    if (isUtilityLand) {
      matchedTags.add('Utility Lands');
    }
    matchedTags.add('Lands');
  }

  // Fallback: Unique
  if (matchedTags.size === 0) {
    if (isLand) {
      matchedTags.add('Lands');
    } else {
      matchedTags.add('Unique');
    }
  }

  return Array.from(matchedTags);
}

app.post('/api/decks/:deckId/autotag', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { deckId } = req.params;
  const playerId = req.session.player.id;

  try {
    const deck = await db.get("SELECT * FROM decks WHERE id = ? AND player_id = ?", [deckId, playerId]);
    if (!deck) return res.status(404).json({ error: "Deck not found." });

    const cards = await db.query(
      `SELECT dc.card_name, dc.scryfall_id, sc.type_line, sc.oracle_text 
       FROM deck_cards dc
       LEFT JOIN scryfall_cards sc ON dc.card_name = sc.card_name
       WHERE dc.deck_id = ?`,
      [deckId]
    );
    if (cards.length === 0) {
      return res.json({ success: true, count: 0 });
    }

    const deckCardNames = cards.map(c => c.card_name);
    const comboMap = detectInfiniteCombos(deckCardNames);

    let tagCount = 0;
    for (const card of cards) {
      const cardName = card.card_name;
      const scryfallId = card.scryfall_id;
      const typeLine = card.type_line;
      const oracleText = card.oracle_text;
      
      const tags = await fetchCardTags(cardName, scryfallId);
      const customTagArray = categorizeCardByTags(cardName, typeLine, tags, oracleText);

      // Inject detected infinite combo tags for this card if present
      const detectedCombos = comboMap[normalizeCardName(cardName)];
      if (detectedCombos) {
        detectedCombos.forEach(comboTag => {
          if (!customTagArray.includes(comboTag)) {
            customTagArray.unshift(comboTag);
          }
        });
      }

      // If customTagArray contains any real functional/combo tag, remove 'Unique'
      if (customTagArray.length > 1 && customTagArray.includes('Unique')) {
        const uIdx = customTagArray.indexOf('Unique');
        if (uIdx !== -1) customTagArray.splice(uIdx, 1);
      }

      const tagValue = JSON.stringify(customTagArray);
      
      await db.run(
        "UPDATE deck_cards SET custom_tag = ? WHERE deck_id = ? AND card_name = ?",
        [tagValue, deckId, cardName]
      );
      tagCount++;
    }

    res.json({ success: true, count: tagCount });
  } catch (e) {
    console.error("Auto-tagging endpoint failed:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/:deckId/reload-cheapest', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { deckId } = req.params;
  const playerId = req.session.player.id;

  try {
    const deck = await db.get("SELECT * FROM decks WHERE id = ? AND player_id = ?", [deckId, playerId]);
    if (!deck) return res.status(404).json({ error: "Deck not found." });

    const cards = await db.query("SELECT card_name, quantity, is_commander, custom_tag FROM deck_cards WHERE deck_id = ?", [deckId]);
    if (cards.length === 0) {
      return res.json({ success: true, totalPrice: 0 });
    }

    const cardNames = cards.map(c => c.card_name);
    const resolvedBatch = await resolveCardDetailsBatch(cardNames);
    const updatedCards = [];

    for (const card of cards) {
      const cardName = card.card_name;
      const details = resolvedBatch[cardName] || {};
      let price = isBasicLand(cardName) && deck.include_basic_lands_in_price !== 1 ? 0.00 : (details.price !== undefined ? details.price : 0.15);
      let scryfallId = details.scryfallId || null;

      await db.run(
        "UPDATE deck_cards SET cheapest_card_price = ?, scryfall_id = ? WHERE deck_id = ? AND card_name = ?",
        [price, scryfallId, deckId, cardName]
      );

      updatedCards.push({ cardName, price, scryfallId });
    }

    const result = await db.get("SELECT SUM(cheapest_card_price * quantity) as total FROM deck_cards WHERE deck_id = ?", [deckId]);
    const totalPrice = parseFloat((result.total || 0).toFixed(2));
    
    const validation = await validateDeckLegality(deckId);
    const isLegal = validation.isLegal ? 1 : 0;
    const legalityReason = validation.reason || null;

    await db.run(
      "UPDATE decks SET cheapest_total_price = ?, last_checked = CURRENT_TIMESTAMP, is_legal = ?, legality_reason = ? WHERE id = ?",
      [totalPrice, isLegal, legalityReason, deckId]
    );

    res.json({ success: true, totalPrice, isLegal: isLegal === 1, reason: legalityReason, updatedCards });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/:deckId/reprice-card-cheapest', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { deckId } = req.params;
  const { cardName } = req.body;
  const playerId = req.session.player.id;

  if (!cardName) return res.status(400).json({ error: "Card name is required." });

  try {
    const deck = await db.get("SELECT * FROM decks WHERE id = ? AND player_id = ?", [deckId, playerId]);
    if (!deck) return res.status(404).json({ error: "Deck not found." });

    const searchUrl = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints`;
    
    let price = 0.05;
    let scryfallId = null;

    try {
      const result = await fetchJson(searchUrl);
      const prints = result.data || [];

      const legalPrints = prints.filter(p => {
        if (p.digital) return false;
        if (p.funny) return false;
        if (p.border_color === 'gold' || p.border_color === 'silver') return false;
        const leg = p.legalities || {};
        if (deck.format && deck.format !== 'custom') {
          const formatStatus = leg[deck.format];
          if (formatStatus !== 'legal' && formatStatus !== 'restricted') {
            return false;
          }
        }
        return true;
      });

      let cheapestPrint = null;
      let minPrice = Infinity;
      const printsToEvaluate = legalPrints.length > 0 ? legalPrints : prints;

      printsToEvaluate.forEach(p => {
        if (p.prices) {
          const usd = parseFloat(p.prices.usd);
          const usdFoil = parseFloat(p.prices.usd_foil);
          const usdEtched = parseFloat(p.prices.usd_etched);
          
          let pVal = Infinity;
          if (usd && usd < pVal) pVal = usd;
          if (usdFoil && usdFoil < pVal) pVal = usdFoil;
          if (usdEtched && usdEtched < pVal) pVal = usdEtched;

          if (pVal < minPrice) {
            minPrice = pVal;
            cheapestPrint = p;
          }
        }
      });

      if (cheapestPrint) {
        price = minPrice === Infinity ? 0.05 : minPrice;
        scryfallId = cheapestPrint.id;
      }
    } catch (err) {
      console.error(`Failed to fetch cheapest print for ${cardName}:`, err.message);
      const current = await db.get("SELECT cheapest_card_price, scryfall_id FROM deck_cards WHERE deck_id = ? AND card_name = ?", [deckId, cardName]);
      if (current) {
        price = current.cheapest_card_price;
        scryfallId = current.scryfall_id;
      }
    }

    if (isBasicLand(cardName) && deck.include_basic_lands_in_price !== 1) {
      price = 0.00;
    }

    await db.run(
      "UPDATE deck_cards SET cheapest_card_price = ?, scryfall_id = ? WHERE deck_id = ? AND card_name = ?",
      [price, scryfallId, deckId, cardName]
    );

    res.json({ success: true, cardName, price, scryfallId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET all public community decks for discover feed
app.get('/api/decks/discover', async (req, res) => {
  try {
    const decks = await db.query(`
      SELECT d.*, p.store_nickname as creator_name, p.avatar_url, p.profile_commander
      FROM decks d
      JOIN players p ON d.player_id = p.id
      WHERE d.is_public = 1 
        AND d.deck_name NOT LIKE 'Audit %'
        AND d.deck_name NOT LIKE 'Test %'
        AND LOWER(p.username) NOT LIKE 'audit_%'
        AND LOWER(p.username) NOT LIKE 'google1%'
        AND LOWER(p.email) NOT LIKE 'audit_%'
      ORDER BY d.last_checked DESC
    `);
    
    const results = [];
    const currentPlayerId = req.session.player ? req.session.player.id : null;
    
    for (let deck of decks) {
      const cards = await db.query("SELECT card_name, quantity, custom_tag, cheapest_card_price, scryfall_id, is_commander FROM deck_cards WHERE deck_id = ?", [deck.id]);
      const commanderCard = cards.find(c => c.is_commander === 1) || (cards.length > 0 ? cards[0] : null);
      const likesCount = await db.get("SELECT COUNT(*) as count FROM deck_likes WHERE deck_id = ?", [deck.id]);
      const clonesCount = await db.get("SELECT COUNT(*) as count FROM decks WHERE cloned_from_deck_id = ?", [deck.id]);
      const hasLiked = currentPlayerId ? await db.get("SELECT 1 FROM deck_likes WHERE deck_id = ? AND player_id = ?", [deck.id, currentPlayerId]) : null;
      const uniqueTags = [...new Set(cards.map(c => c.custom_tag).filter(Boolean))];
      
      results.push({
        id: deck.id,
        deckName: deck.deck_name,
        creatorName: deck.creator_name,
        creatorAvatar: deck.avatar_url || '',
        creatorCommander: deck.profile_commander || '',
        price: deck.cheapest_total_price,
        isLegal: deck.is_legal === 1,
        budgetLimit: deck.budget_limit,
        likes: likesCount ? likesCount.count : 0,
        clones: clonesCount ? clonesCount.count : 0,
        popularity: (likesCount ? likesCount.count : 0) * 3 + (clonesCount ? clonesCount.count : 0),
        hasLiked: !!hasLiked,
        commanderName: commanderCard ? commanderCard.card_name : "Unknown Commander",
        commanderScryfallId: commanderCard ? commanderCard.scryfall_id : null,
        tags: uniqueTags,
        customTags: JSON.parse(deck.custom_tags || '[]'),
        moxfieldUrl: deck.moxfield_url,
        originalCreator: deck.original_creator_name || null,
        legalityReason: deck.legality_reason || ''
      });
    }
    
    if (req.query.sort === 'trending') {
      results.sort((a, b) => b.popularity - a.popularity);
    }
    
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/decks/my-decks', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    const decks = await db.query(
      `SELECT d.*, ds.total_points, ds.total_kills, ds.total_wins, ds.total_matches,
              (SELECT card_name FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 LIMIT 1) AS commander_name,
              (SELECT scryfall_id FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 LIMIT 1) AS commander_scryfall_id,
              (SELECT scryfall_id FROM deck_cards WHERE deck_id = d.id AND card_name = d.featured_card_name LIMIT 1) AS featured_scryfall_id
       FROM decks d 
       LEFT JOIN deck_stats ds ON d.id = ds.deck_id
       WHERE d.player_id = ?`,
      [req.session.player.id]
    );
    res.json(decks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/decks/:deckId', async (req, res) => {
  const { deckId } = req.params;
  try {
    const deck = await db.get("SELECT * FROM decks WHERE id = ?", [deckId]);
    if (!deck) return res.status(404).json({ error: "Deck not found" });
    res.json(deck);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/decks/:deckId', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { deckId } = req.params;
  const playerId = req.session.player.id;

  try {
    const deck = await db.get("SELECT id FROM decks WHERE id = ? AND player_id = ?", [deckId, playerId]);
    if (!deck) {
      return res.status(404).json({ error: "Deck not found or access denied." });
    }

    await db.run("DELETE FROM deck_cards WHERE deck_id = ?", [deckId]);
    await db.run("DELETE FROM deck_likes WHERE deck_id = ?", [deckId]);
    await db.run("DELETE FROM deck_comments WHERE deck_id = ?", [deckId]);
    await db.run("DELETE FROM deck_stats WHERE deck_id = ?", [deckId]);
    await db.run("DELETE FROM decks WHERE id = ?", [deckId]);

    res.json({ success: true, message: "Deck deleted successfully." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/decks/:deckId/cards', async (req, res) => {
  const { deckId } = req.params;
  try {
    const cards = await db.query(
      `SELECT dc.deck_id, dc.card_name, dc.cheapest_card_price, dc.quantity, dc.is_commander, dc.custom_tag,
              COALESCE(dc.scryfall_id, sc.scryfall_id) AS scryfall_id,
              sc.type_line, sc.oracle_text, sc.colors, sc.cmc, sc.rarity
       FROM deck_cards dc
       LEFT JOIN scryfall_cards sc ON dc.card_name = sc.card_name COLLATE NOCASE
       WHERE dc.deck_id = ?
       ORDER BY dc.card_name ASC`,
      [deckId]
    );
    res.json(cards);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/:deckId/cards', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });

  const { deckId } = req.params;
  const { name, price, scryfallId } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: "Card name is required." });
  }

  try {
    const deck = await db.get(
      "SELECT id FROM decks WHERE id = ? AND player_id = ?",
      [deckId, req.session.player.id]
    );
    if (!deck) return res.status(404).json({ error: "Deck not found." });

    const normalizedPrice = Number.isFinite(Number(price)) ? Number(price) : 0.10;
    const existing = await db.get(
      "SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_name = ? COLLATE NOCASE",
      [deckId, name.trim()]
    );

    let quantity = 1;
    if (existing) {
      quantity = Number(existing.quantity || 0) + 1;
      await db.run(
        `UPDATE deck_cards
         SET quantity = ?, cheapest_card_price = ?, scryfall_id = COALESCE(?, scryfall_id)
         WHERE deck_id = ? AND card_name = ? COLLATE NOCASE`,
        [quantity, normalizedPrice, scryfallId || null, deckId, name.trim()]
      );
    } else {
      await db.run(
        `INSERT INTO deck_cards
         (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag, is_commander)
         VALUES (?, ?, ?, 1, ?, NULL, 0)`,
        [deckId, name.trim(), normalizedPrice, scryfallId || null]
      );
    }

    await db.run(
      `UPDATE decks
       SET cheapest_total_price = COALESCE((
         SELECT SUM(cheapest_card_price * quantity) FROM deck_cards WHERE deck_id = ?
       ), 0), last_checked = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [deckId, deckId]
    );

    const validation = await validateDeckLegality(deckId);
    await db.run(
      "UPDATE decks SET is_legal = ?, legality_reason = ? WHERE id = ?",
      [validation.isLegal ? 1 : 0, validation.reason || null, deckId]
    );

    res.json({ success: true, quantity });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Social rating and comments for decks
app.get('/api/decks/:deckId/social', async (req, res) => {
  const { deckId } = req.params;
  const playerId = req.session.player ? req.session.player.id : null;
  try {
    const likesCount = await db.get("SELECT COUNT(*) as count FROM deck_likes WHERE deck_id = ?", [deckId]);
    const hasLiked = playerId ? await db.get("SELECT 1 FROM deck_likes WHERE deck_id = ? AND player_id = ?", [deckId, playerId]) : null;
    
    const comments = await db.query(`
      SELECT dc.*, p.store_nickname, p.avatar_url
      FROM deck_comments dc
      JOIN players p ON dc.player_id = p.id
      WHERE dc.deck_id = ?
      ORDER BY dc.created_at DESC
    `, [deckId]);
    
    const deckMeta = await db.get("SELECT cloned_from_deck_id, original_creator_name, custom_tags, player_id FROM decks WHERE id = ?", [deckId]);
    
    res.json({
      likes: likesCount ? likesCount.count : 0,
      hasLiked: !!hasLiked,
      comments: comments || [],
      clonedFromDeckId: deckMeta ? deckMeta.cloned_from_deck_id : null,
      originalCreatorName: deckMeta ? deckMeta.original_creator_name : null,
      customTags: JSON.parse((deckMeta && deckMeta.custom_tags) || '[]'),
      isOwner: deckMeta ? (deckMeta.player_id === playerId) : false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update deck custom tags
app.post('/api/decks/:deckId/tags', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const { deckId } = req.params;
  const { tags } = req.body;
  const playerId = req.session.player.id;
  
  if (!Array.isArray(tags)) {
    return res.status(400).json({ error: "Tags must be an array of strings." });
  }

  for (const tag of tags) {
    if (typeof tag === 'string' && isProfane(tag)) {
      return res.status(400).json({ error: "Inappropriate content detected in tag names." });
    }
  }
  
  try {
    const deck = await db.get("SELECT id FROM decks WHERE id = ? AND player_id = ?", [deckId, playerId]);
    if (!deck) {
      return res.status(403).json({ error: "You do not own this deck or the deck does not exist." });
    }
    
    await db.run("UPDATE decks SET custom_tags = ? WHERE id = ?", [JSON.stringify(tags), deckId]);
    res.json({ success: true, tags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Follow Connection System
app.post('/api/players/:playerId/follow', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const { playerId } = req.params;
  const followerId = req.session.player.id;
  if (playerId === followerId) return res.status(400).json({ error: "You cannot follow yourself." });
  try {
    const existing = await db.get("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?", [followerId, playerId]);
    if (existing) {
      await db.run("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?", [followerId, playerId]);
      res.json({ success: true, following: false });
    } else {
      await db.run("INSERT INTO follows (follower_id, followed_id) VALUES (?, ?)", [followerId, playerId]);
      
      const notifId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      const nickname = req.session.player.storeNickname || "A user";
      await db.run(
        "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
        [notifId, playerId, "New Follower", `${nickname} started following you!`]
      );
      
      res.json({ success: true, following: true });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/players/:playerId/following', async (req, res) => {
  const { playerId } = req.params;
  const followerId = req.session.player ? req.session.player.id : null;
  if (!followerId) return res.json({ following: false });
  try {
    const row = await db.get("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?", [followerId, playerId]);
    res.json({ following: !!row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/:deckId/like', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const { deckId } = req.params;
  const playerId = req.session.player.id;
  try {
    const existing = await db.get("SELECT 1 FROM deck_likes WHERE deck_id = ? AND player_id = ?", [deckId, playerId]);
    if (existing) {
      await db.run("DELETE FROM deck_likes WHERE deck_id = ? AND player_id = ?", [deckId, playerId]);
      res.json({ success: true, liked: false });
    } else {
      await db.run("INSERT INTO deck_likes (deck_id, player_id) VALUES (?, ?)", [deckId, playerId]);
      res.json({ success: true, liked: true });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/:deckId/comment', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const { deckId } = req.params;
  const { commentText } = req.body;
  const playerId = req.session.player.id;
  if (!commentText || !commentText.trim()) return res.status(400).json({ error: "Comment text cannot be empty." });
  if (isProfane(commentText)) {
    return res.status(400).json({ error: "Inappropriate content detected. Please choose different words." });
  }
  try {
    const id = 'comment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO deck_comments (id, deck_id, player_id, comment_text) VALUES (?, ?, ?, ?)",
      [id, deckId, playerId, commentText.trim()]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/:deckId/clone', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const { deckId } = req.params;
  const playerId = req.session.player.id;
  try {
    const deck = await db.get("SELECT * FROM decks WHERE id = ?", [deckId]);
    if (!deck) return res.status(404).json({ error: "Original deck not found." });
    
    const owner = await db.get("SELECT store_nickname FROM players WHERE id = ?", [deck.player_id]);
    const creatorName = deck.original_creator_name || (owner ? owner.store_nickname : "Unknown Creator");
    const sourceDeckId = deck.cloned_from_deck_id || deckId;
    
    const newDeckId = 'd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    await db.run(`
      INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, last_checked, is_legal, cloned_from_deck_id, original_creator_name, budget_limit, is_public, format, keep_cheapest, custom_tags, featured_card_name)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `, [newDeckId, playerId, deck.moxfield_url, `${deck.deck_name} (Copy)`, deck.cheapest_total_price, deck.is_legal, sourceDeckId, creatorName, deck.budget_limit, deck.format || 'commander', deck.keep_cheapest || 0, deck.custom_tags || '[]', deck.featured_card_name || null]);
    
    const cards = await db.query("SELECT * FROM deck_cards WHERE deck_id = ?", [deckId]);
    for (let card of cards) {
      await db.run(
        "INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag, is_commander) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [newDeckId, card.card_name, card.cheapest_card_price, card.quantity, card.scryfall_id, card.custom_tag || null, card.is_commander || 0]
      );
    }
    
    const activeSeason = await db.get("SELECT id FROM seasons WHERE is_active = 1");
    if (activeSeason) {
      await db.run(
        "INSERT OR IGNORE INTO deck_stats (deck_id, season_id) VALUES (?, ?)",
        [newDeckId, activeSeason.id]
      );
    }
    
    res.json({ success: true, newDeckId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/:deckId/share', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const { deckId } = req.params;
  const { recipientUsername } = req.body;
  const senderId = req.session.player.id;

  if (!recipientUsername || recipientUsername.trim().length === 0) {
    return res.status(400).json({ error: "Recipient username is required." });
  }

  try {
    const deck = await db.get("SELECT * FROM decks WHERE id = ? AND player_id = ?", [deckId, senderId]);
    if (!deck) return res.status(404).json({ error: "Deck not found in your collection." });

    const recipient = await db.get("SELECT id, store_nickname FROM players WHERE username = ?", [recipientUsername.trim().toLowerCase()]);
    if (!recipient) return res.status(404).json({ error: "Recipient username not found." });
    if (recipient.id === senderId) return res.status(400).json({ error: "You cannot share a deck with yourself." });

    const sender = await db.get("SELECT store_nickname FROM players WHERE id = ?", [senderId]);

    // Send DM with embedded HTML view button
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const subject = `Shared Deck: ${deck.deck_name}`;
    const escapedDeckName = deck.deck_name.replace(/'/g, "\\'");
    const body = `I wanted to share my deck "${deck.deck_name}" with you.\n\n<button class="btn btn-gold btn-sm" style="display:inline-flex; align-items:center; gap:0.25rem; font-weight:700; height:24px; padding:0 8px; font-size:0.75rem; border-radius:4px; margin:0;" onclick="document.getElementById('inbox-modal-overlay').remove(); window.inspectDeckCards('${deckId}', '${escapedDeckName}')">👁️ View Shared Deck</button>`;
    
    await db.run(
      "INSERT INTO direct_messages (id, sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?, ?)",
      [msgId, senderId, recipient.id, subject, body]
    );

    // Notification
    const notifId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
      [notifId, recipient.id, `📬 Shared Deck from ${sender ? sender.store_nickname : 'Friend'}`, `Shared their deck "${deck.deck_name}" with you.`]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cards/autocomplete', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);

  try {
    const results = await db.query(
      `SELECT DISTINCT card_name, type_line, mana_cost, cmc, scryfall_id 
       FROM scryfall_cards 
       WHERE card_name LIKE ? AND (type_line IS NULL OR type_line NOT LIKE '%Token%')
       ORDER BY CASE WHEN card_name LIKE ? THEN 0 ELSE 1 END, card_name ASC 
       LIMIT 10`,
      [`%${q}%`, `${q}%`]
    );

    if (results.length < 5) {
      try {
        const scryRes = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`);
        if (scryRes.ok) {
          const data = await scryRes.json();
          const existingNames = new Set(results.map(r => (r.card_name || '').toLowerCase()));
          (data.data || []).forEach(name => {
            if (!existingNames.has(name.toLowerCase()) && results.length < 10) {
              results.push({ card_name: name });
            }
          });
        }
      } catch (err) {}
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const suggestionsMemoryCache = new Map();

app.get('/api/decks/:deckId/suggestions', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const { deckId } = req.params;

  try {
    // Find commander cards for the deck
    const commanders = await db.query(
      `SELECT dc.card_name, dc.scryfall_id, sc.scryfall_id as sc_id 
       FROM deck_cards dc
       LEFT JOIN scryfall_cards sc ON dc.card_name = sc.card_name
       WHERE dc.deck_id = ? AND dc.is_commander = 1`,
      [deckId]
    );

    if (commanders.length === 0) {
      return res.status(400).json({
        error: "No commander defined for this deck. Please tag at least one card in your deck as a Commander first."
      });
    }

    const commanderNames = commanders.map(c => c.card_name);
    const commanderScryfallId = commanders[0]?.scryfall_id || commanders[0]?.sc_id || null;

    // Slugify commander name(s)
    const getEdhrecSlugForCommanders = (names) => {
      const slugs = names.map(name => {
        return name.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '') // remove special characters
          .replace(/\s+/g, '-')         // spaces to hyphens
          .replace(/-+/g, '-')          // collapse hyphens
          .replace(/^-+|-+$/g, '');     // trim hyphens
      });
      slugs.sort();
      return slugs.join('-');
    };

    const slug = getEdhrecSlugForCommanders(commanderNames);
    
    // Check high-speed memory cache (6 hour TTL)
    const cached = suggestionsMemoryCache.get(slug);
    if (cached && (Date.now() - cached.timestamp < 21600000)) {
      const ownedCardsRows = await db.query(
        `SELECT DISTINCT cc.card_name 
         FROM collection_cards cc
         JOIN collections c ON cc.collection_id = c.id
         WHERE c.player_id = ?`,
        [playerId]
      );
      const ownedSet = new Set(ownedCardsRows.map(r => r.card_name.toLowerCase()));

      const updatedFunctional = cached.functionalCategories.map(cat => ({
        ...cat,
        cards: cat.cards.map(card => ({ ...card, owned: ownedSet.has(card.name.toLowerCase()) }))
      }));

      const updatedType = cached.typeCategories.map(cat => ({
        ...cat,
        cards: cat.cards.map(card => ({ ...card, owned: ownedSet.has(card.name.toLowerCase()) }))
      }));

      return res.json({
        success: true,
        commanderName: cached.commanderName,
        commanderScryfallId: cached.commanderScryfallId,
        categories: updatedFunctional,
        functionalCategories: updatedFunctional,
        typeCategories: updatedType
      });
    }

    const edhrecUrl = `https://json.edhrec.com/pages/commanders/${slug}.json`;

    // Fetch from EDHREC
    const https = require('https');
    const fetchJson = (url) => {
      return new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          timeout: 6000
        }, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`EDHREC returned status code ${res.statusCode}`));
          }
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error("EDHREC request timed out"));
        });
      });
    };

    let json;
    let cardlists = [];
    try {
      json = await fetchJson(edhrecUrl);
      if (json && json.container && json.container.json_dict) {
        cardlists = json.container.json_dict.cardlists || [];
      }
    } catch (err) {
      console.warn(`[EDHREC Fallback] EDHREC fetch unavailable for '${slug}':`, err.message);
      try {
        const fallbackCards = await db.query(
          "SELECT card_name FROM scryfall_cards LIMIT 60"
        );
        if (fallbackCards && fallbackCards.length > 0) {
          cardlists = [{
            header: "Recommended Synergy Cards",
            cardviews: fallbackCards.map(c => ({ name: c.card_name }))
          }];
        }
      } catch (dbErr) {
        console.error("Local suggestions fallback query failed:", dbErr);
      }
    }

    // Extract all unique card names
    const allNames = new Set();
    cardlists.forEach(list => {
      if (list.cardviews) {
        list.cardviews.forEach(c => {
          if (c.name) allNames.add(c.name);
        });
      }
    });

    const namesArray = Array.from(allNames);
    const cardMap = {};

    // Look up in database to get oracle_text, type_line, prices, and scryfall_ids
    if (namesArray.length > 0) {
      const chunkSize = 90;
      for (let i = 0; i < namesArray.length; i += chunkSize) {
        const chunk = namesArray.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const lowerChunk = chunk.map(c => c.toLowerCase());
        const dbCards = await db.query(
          `SELECT sc.card_name, COALESCE(sc.scryfall_id, pc.scryfall_id) as scryfall_id, sc.type_line, sc.oracle_text, COALESCE(NULLIF(pc.price, 0), NULLIF(sc.price, 0), 0.15) as cheapest_card_price
           FROM scryfall_cards sc
           LEFT JOIN card_price_cache pc ON LOWER(sc.card_name) = LOWER(pc.card_name)
           WHERE LOWER(sc.card_name) IN (${placeholders})`,
          lowerChunk
        );
        dbCards.forEach(c => {
          cardMap[c.card_name.toLowerCase()] = c;
        });
      }

      // Fallback query directly on card_price_cache for cards missing from scryfall_cards
      const unmappedNames = namesArray.filter(name => !cardMap[name.toLowerCase()]);
      if (unmappedNames.length > 0) {
        for (let i = 0; i < unmappedNames.length; i += chunkSize) {
          const chunk = unmappedNames.slice(i, i + chunkSize);
          const placeholders = chunk.map(() => '?').join(',');
          const lowerChunk = chunk.map(c => c.toLowerCase());
          const cacheCards = await db.query(
            `SELECT card_name, scryfall_id, COALESCE(NULLIF(price, 0), 0.15) as cheapest_card_price
             FROM card_price_cache
             WHERE LOWER(card_name) IN (${placeholders})`,
            lowerChunk
          );
          cacheCards.forEach(c => {
            cardMap[c.card_name.toLowerCase()] = c;
          });
        }
      }
    }

    // Intersect suggestions with user's collections to find owned recommendations
    const playerId = req.session.player.id;
    const ownedCardsRows = await db.query(
      `SELECT DISTINCT cc.card_name 
       FROM collection_cards cc
       JOIN collections c ON cc.collection_id = c.id
       WHERE c.player_id = ?`,
      [playerId]
    );
    const ownedSet = new Set(ownedCardsRows.map(r => r.card_name.toLowerCase()));

    // Define functional and archetype category buckets matching Grimore Auto-Tagging engine
    const functionalBucketMap = {
      'Owned Suggestions': { tag: 'owned-suggestions', cards: [] },
      'Wincons/Finishers': { tag: 'wincons', cards: [] },
      'Tutors': { tag: 'tutors', cards: [] },
      'Stax': { tag: 'stax', cards: [] },
      'Mass Removal': { tag: 'mass-removal', cards: [] },
      'Single Target Removal': { tag: 'single-target-removal', cards: [] },
      'Protection': { tag: 'protection', cards: [] },
      'Ramp': { tag: 'ramp', cards: [] },
      'Card Advantage': { tag: 'card-advantage', cards: [] },
      'Card Selection': { tag: 'card-selection', cards: [] },
      'Recursion': { tag: 'recursion', cards: [] },
      'Reanimation': { tag: 'reanimation', cards: [] },
      'Graveyard Fillers': { tag: 'graveyard-fillers', cards: [] },
      'Sacrifice Outlets': { tag: 'sacrifice-outlets', cards: [] },
      'Tokens & Swarm': { tag: 'tokens-swarm', cards: [] },
      'Equipment & Auras': { tag: 'equipment-auras', cards: [] },
      'Enchantments': { tag: 'enchantments', cards: [] },
      'Blink & ETB': { tag: 'blink-etb', cards: [] },
      'Spellslinger': { tag: 'spellslinger', cards: [] },
      'Landfall': { tag: 'landfall', cards: [] },
      'Utility Lands': { tag: 'utility-lands', cards: [] },
      'Lands': { tag: 'lands', cards: [] },
      'Unique': { tag: 'unique', cards: [] }
    };

    const addedToBucketMap = new Set(); // track 'cardName:bucket' to prevent duplicates

    // Process every recommended card through Grimore's Functional Auto-Tagging engine
    namesArray.forEach(name => {
      const matched = cardMap[name.toLowerCase()];
      const price = matched ? matched.cheapest_card_price : 0.15;
      const scryfallId = matched ? matched.scryfall_id : null;
      const typeLine = matched ? matched.type_line : 'Card';
      const oracleText = matched ? matched.oracle_text : '';
      const isOwned = ownedSet.has(name.toLowerCase());

      const cardObj = {
        name,
        scryfallId,
        price: price !== null && price !== undefined ? price : 0.15,
        type_line: typeLine,
        owned: isOwned
      };

      // Add to Owned Suggestions bucket if owned
      if (isOwned) {
        functionalBucketMap['Owned Suggestions'].cards.push(cardObj);
      }

      // Run card through Grimore functional auto-tagger
      const assignedCategories = categorizeCardByTags(name, typeLine, [], oracleText);

      assignedCategories.forEach(catName => {
        if (functionalBucketMap[catName]) {
          const key = `${name.toLowerCase()}:${catName}`;
          if (!addedToBucketMap.has(key)) {
            addedToBucketMap.add(key);
            functionalBucketMap[catName].cards.push(cardObj);
          }
        }
      });
    });

    // Build ordered response categories prioritizing Main Categories
    const categoryOrder = [
      'Owned Suggestions',
      'Ramp',
      'Card Advantage',
      'Single Target Removal',
      'Mass Removal',
      'Protection',
      'Tutors',
      'Wincons/Finishers',
      'Card Selection',
      'Recursion',
      'Reanimation',
      'Stax',
      'Graveyard Fillers',
      'Sacrifice Outlets',
      'Tokens & Swarm',
      'Equipment & Auras',
      'Enchantments',
      'Blink & ETB',
      'Spellslinger',
      'Landfall',
      'Utility Lands',
      'Lands',
      'Unique'
    ];

    const functionalCategories = categoryOrder.map(header => {
      const b = functionalBucketMap[header];
      return {
        header,
        tag: b.tag,
        cards: b.cards
      };
    }).filter(cat => cat.cards.length > 0);

    // Build Type-Based Categories for Type Mode
    const typeBucketMap = {
      'Owned Suggestions': { tag: 'owned-suggestions', cards: [] },
      'Creatures': { tag: 'creatures', cards: [] },
      'Planeswalkers': { tag: 'planeswalkers', cards: [] },
      'Instants': { tag: 'instants', cards: [] },
      'Sorceries': { tag: 'sorceries', cards: [] },
      'Enchantments': { tag: 'enchantments-type', cards: [] },
      'Artifacts': { tag: 'artifacts-type', cards: [] },
      'Lands': { tag: 'lands-type', cards: [] },
      'Other': { tag: 'other-type', cards: [] }
    };

    const addedToTypeBucket = new Set();
    namesArray.forEach(name => {
      const matched = cardMap[name.toLowerCase()];
      const price = matched ? matched.cheapest_card_price : 0.15;
      const scryfallId = matched ? matched.scryfall_id : null;
      const typeLine = matched ? matched.type_line : 'Card';
      const isOwned = ownedSet.has(name.toLowerCase());

      const cardObj = {
        name,
        scryfallId,
        price: price !== null && price !== undefined ? price : 0.15,
        type_line: typeLine,
        owned: isOwned
      };

      if (isOwned) {
        const key = `${name.toLowerCase()}:owned-suggestions`;
        if (!addedToTypeBucket.has(key)) {
          addedToTypeBucket.add(key);
          typeBucketMap['Owned Suggestions'].cards.push(cardObj);
        }
      }

      const t = (typeLine || '').toLowerCase();
      let assignedType = 'Other';
      if (t.includes('creature')) assignedType = 'Creatures';
      else if (t.includes('planeswalker')) assignedType = 'Planeswalkers';
      else if (t.includes('instant')) assignedType = 'Instants';
      else if (t.includes('sorcery')) assignedType = 'Sorceries';
      else if (t.includes('enchantment')) assignedType = 'Enchantments';
      else if (t.includes('artifact')) assignedType = 'Artifacts';
      else if (t.includes('land')) assignedType = 'Lands';

      const typeKey = `${name.toLowerCase()}:${assignedType}`;
      if (!addedToTypeBucket.has(typeKey)) {
        addedToTypeBucket.add(typeKey);
        typeBucketMap[assignedType].cards.push(cardObj);
      }
    });

    const typeOrder = [
      'Owned Suggestions',
      'Creatures',
      'Planeswalkers',
      'Instants',
      'Sorceries',
      'Enchantments',
      'Artifacts',
      'Lands',
      'Other'
    ];

    const typeCategories = typeOrder.map(header => {
      const b = typeBucketMap[header];
      return {
        header,
        tag: b.tag,
        cards: b.cards
      };
    }).filter(cat => cat.cards.length > 0);

    suggestionsMemoryCache.set(slug, {
      commanderName: commanderNames.join(' // '),
      commanderScryfallId,
      functionalCategories,
      typeCategories,
      timestamp: Date.now()
    });

    res.json({
      success: true,
      commanderName: commanderNames.join(' // '),
      commanderScryfallId,
      categories: functionalCategories,
      functionalCategories,
      typeCategories
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// ACTIVE ROSTER / CHECK-IN ENDPOINTS
// ==========================================

app.post('/api/roster/checkin', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { deckId } = req.body;
  try {
    await db.run(
      "INSERT OR REPLACE INTO active_roster (player_id, deck_id, checked_in) VALUES (?, ?, 1)",
      [req.session.player.id, deckId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/roster/checkout', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    await db.run("DELETE FROM active_roster WHERE player_id = ?", [req.session.player.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/roster/status', async (req, res) => {
  if (!req.session.player) return res.json({ checkedIn: false });
  try {
    const checked = await db.get("SELECT * FROM active_roster WHERE player_id = ?", [req.session.player.id]);
    res.json({ checkedIn: !!checked, deckId: checked ? checked.deck_id : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/roster/list', async (req, res) => {
  try {
    const roster = await db.query(`
      SELECT p.id as player_id, p.store_nickname, d.deck_name, d.id as deck_id, d.is_legal, d.cheapest_total_price, ar.checked_in
      FROM active_roster ar
      JOIN players p ON ar.player_id = p.id
      LEFT JOIN decks d ON ar.deck_id = d.id
    `);
    res.json(roster);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin check-in controls
app.post('/api/roster/admin-checkin', async (req, res) => {
  if (!req.session.player || !req.session.player.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const { playerId, deckId } = req.body;
  try {
    await db.run(
      "INSERT OR REPLACE INTO active_roster (player_id, deck_id, checked_in) VALUES (?, ?, 1)",
      [playerId, deckId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/roster/admin-checkout', async (req, res) => {
  if (!req.session.player || !req.session.player.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const { playerId } = req.body;
  try {
    await db.run("DELETE FROM active_roster WHERE player_id = ?", [playerId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// PAIRING ENGINE & ROUND PORTAL (Commander Pods)
// ==========================================

function getPodSizes(numPlayers, remainderPref) {
  if (numPlayers < 3) return [];
  if (numPlayers === 3) return [3];
  if (numPlayers === 4) return [4];
  if (numPlayers === 5) return [5];
  if (numPlayers === 6) return [3, 3];
  if (numPlayers === 7) return [4, 3];
  
  const sizes = [];
  let remaining = numPlayers;
  
  if (remainderPref === '5') {
    const rem = remaining % 4;
    if (rem === 0) {
      while (remaining > 0) { sizes.push(4); remaining -= 4; }
    } else if (rem === 1) {
      sizes.push(5); remaining -= 5;
      while (remaining > 0) { sizes.push(4); remaining -= 4; }
    } else if (rem === 2) {
      if (remaining >= 10) {
        sizes.push(5, 5); remaining -= 10;
        while (remaining > 0) { sizes.push(4); remaining -= 4; }
      } else {
        sizes.push(3, 3); remaining -= 6;
      }
    } else if (rem === 3) {
      sizes.push(3); remaining -= 3;
      while (remaining > 0) { sizes.push(4); remaining -= 4; }
    }
  } else {
    const rem = remaining % 4;
    if (rem === 0) {
      while (remaining > 0) { sizes.push(4); remaining -= 4; }
    } else if (rem === 1) {
      sizes.push(3, 3); remaining -= 6;
      while (remaining > 0) { sizes.push(4); remaining -= 4; }
    } else if (rem === 2) {
      sizes.push(3, 3); remaining -= 6;
      while (remaining > 0) { sizes.push(4); remaining -= 4; }
    } else if (rem === 3) {
      sizes.push(3); remaining -= 3;
      while (remaining > 0) { sizes.push(4); remaining -= 4; }
    }
  }
  return sizes.sort((a, b) => b - a);
}

app.post('/api/pairings/generate', async (req, res) => {
  if (!hasRole(req.session.player, ['admin', 'judge', 'scorekeeper'])) {
    return res.status(403).json({ error: "Access denied. Organizer status required." });
  }
  const { roundNum } = req.body;

  try {
    const season = await db.get("SELECT * FROM seasons WHERE is_active = 1");
    if (!season) return res.status(400).json({ error: "No active season." });

    // Fetch roster checked-in players
    const roster = await db.query(`
      SELECT ar.player_id, ar.deck_id, p.store_nickname, COALESCE(ps.total_points, 0) as points
      FROM active_roster ar
      JOIN players p ON ar.player_id = p.id
      LEFT JOIN player_stats ps ON ar.player_id = ps.player_id AND ps.season_id = ?
    `, [season.id]);

    if (roster.length < 3) {
      return res.status(400).json({ error: "You need at least 3 checked-in players to generate pods." });
    }

    // Determine sizes
    const podSizes = getPodSizes(roster.length, season.remainder_pref);

    // Build historical opponents matrix to minimize collisions
    const history = await db.query(`
      SELECT pr1.player_id as p1, pr2.player_id as p2
      FROM pod_results pr1
      JOIN pod_results pr2 ON pr1.pod_id = pr2.pod_id AND pr1.player_id != pr2.player_id
      JOIN pods p ON pr1.pod_id = p.id
      WHERE p.season_id = ?
    `, [season.id]);

    const playCounts = new Map();
    roster.forEach(r => playCounts.set(r.player_id, new Map()));
    history.forEach(h => {
      if (playCounts.has(h.p1)) {
        const subMap = playCounts.get(h.p1);
        subMap.set(h.p2, (subMap.get(h.p2) || 0) + 1);
      }
    });

    // Pairings logic: Match by points (primary) and minimize collisions (secondary)
    // Sort roster by points descending
    let sortedRoster = [...roster];
    if (season.use_point_pairing === 1) {
      sortedRoster.sort((a, b) => b.points - a.points);
    } else {
      // Shuffle players randomly to pair without points priority
      for (let i = sortedRoster.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sortedRoster[i], sortedRoster[j]] = [sortedRoster[j], sortedRoster[i]];
      }
    }

    // Allocate players to pods matching podSizes slices
    const podsList = [];
    let rosterIdx = 0;
    
    podSizes.forEach((size, idx) => {
      const podPlayers = sortedRoster.slice(rosterIdx, rosterIdx + size);
      rosterIdx += size;

      podsList.push({
        id: `pod_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`,
        label: idx + 1,
        players: podPlayers
      });
    });

    // Save pairings to Database
    for (let pod of podsList) {
      await db.run(
        "INSERT INTO pods (id, season_id, round_num, pod_label, completed) VALUES (?, ?, ?, ?, 0)",
        [pod.id, season.id, roundNum, pod.label]
      );

      for (let player of pod.players) {
        await db.run(
          "INSERT INTO pod_results (pod_id, player_id, deck_id, kills, placed_first, placed_draw, points_awarded) VALUES (?, ?, ?, 0, 0, 0, 0)",
          [pod.id, player.player_id, player.deck_id]
        );
        
        const nId = 'n_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        await db.run(
          "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
          [nId, player.player_id, "Round Pairings Posted", `Round ${roundNum} is paired! You are at Table ${pod.label}.`]
        );
      }
    }

    res.json({ success: true, pods: podsList });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pairings/round/:roundNum', async (req, res) => {
  const { roundNum } = req.params;
  let { seasonId } = req.query;
  try {
    if (!seasonId) {
      const active = await db.get("SELECT * FROM seasons WHERE is_active = 1");
      if (!active) return res.status(404).json({ error: "No active season found." });
      seasonId = active.id;
    }

    const pods = await db.query("SELECT * FROM pods WHERE season_id = ? AND round_num = ? ORDER BY pod_label ASC", [seasonId, roundNum]);
    const results = [];

    for (let pod of pods) {
      const players = await db.query(`
        SELECT pr.*, p.store_nickname, d.deck_name, d.is_legal
        FROM pod_results pr
        JOIN players p ON pr.player_id = p.id
        LEFT JOIN decks d ON pr.deck_id = d.id
        WHERE pr.pod_id = ?
      `, [pod.id]);

      results.push({
        id: pod.id,
        label: pod.pod_label,
        completed: pod.completed === 1,
        players
      });
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pairings/report/:podId', async (req, res) => {
  // Can be submitted by players or admin
  const { podId } = req.params;
  const { results } = req.body; // Array of { player_id, kills, placed_first, placed_draw }
  
  try {
    const season = await db.get("SELECT * FROM seasons WHERE is_active = 1");
    const pod = await db.get("SELECT * FROM pods WHERE id = ?", [podId]);
    if (!pod || !season) return res.status(404).json({ error: "Pod or active season not found." });

    // Save individual results & calculate points
    for (let r of results) {
      let points = 0;
      if (r.placed_first === 1) {
        points += season.points_win;
      } else if (r.placed_draw === 1) {
        points += season.points_draw;
      }
      points += season.points_entry;
      points += (r.kills * season.points_kill);

      await db.run(
        `UPDATE pod_results 
         SET kills = ?, placed_first = ?, placed_draw = ?, points_awarded = ? 
         WHERE pod_id = ? AND player_id = ?`,
        [r.kills, r.placed_first, r.placed_draw, points, podId, r.player_id]
      );
    }

    // Mark pod as completed
    await db.run("UPDATE pods SET completed = 1 WHERE id = ?", [podId]);

    // Recalculate all season leaderboards and statistics
    await updateLeaderboardStats(season.id);

    res.json({ success: true });
  } catch (e) {
    console.error("Report score error:", e);
    res.status(500).json({ error: e.message });
  }
});

// End current round (clear active check-ins, or keep them for next round based on organizer choice)
app.post('/api/pairings/end-round', async (req, res) => {
  if (!req.session.player || !req.session.player.isAdmin) return res.status(403).json({ error: "Forbidden" });
  try {
    // Standard event cleanup - keep roster checked-in by default so they don't have to check in again
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update Cumulative Leaderboards and Stats
async function updateLeaderboardStats(seasonId) {
  // Clear statistics for the season and rebuild from matches
  await db.run("UPDATE player_stats SET total_points = 0, total_kills = 0, total_wins = 0, total_matches = 0 WHERE season_id = ?", [seasonId]);
  await db.run("UPDATE deck_stats SET total_points = 0, total_kills = 0, total_wins = 0, total_matches = 0 WHERE season_id = ?", [seasonId]);

  // Aggregate player results
  const playerStats = await db.query(`
    SELECT pr.player_id, SUM(pr.points_awarded) as pts, SUM(pr.kills) as k, SUM(pr.placed_first) as w, COUNT(pr.pod_id) as matches
    FROM pod_results pr
    JOIN pods p ON pr.pod_id = p.id
    WHERE p.season_id = ? AND p.completed = 1
    GROUP BY pr.player_id
  `, [seasonId]);

  for (let s of playerStats) {
    await db.run(`
      INSERT OR REPLACE INTO player_stats (player_id, season_id, total_points, total_kills, total_wins, total_matches)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [s.player_id, seasonId, s.pts, s.k, s.w, s.matches]);
  }

  // Aggregate deck results
  const deckStats = await db.query(`
    SELECT pr.deck_id, SUM(pr.points_awarded) as pts, SUM(pr.kills) as k, SUM(pr.placed_first) as w, COUNT(pr.pod_id) as matches
    FROM pod_results pr
    JOIN pods p ON pr.pod_id = p.id
    WHERE p.season_id = ? AND p.completed = 1 AND pr.deck_id IS NOT NULL
    GROUP BY pr.deck_id
  `, [seasonId]);

  for (let s of deckStats) {
    await db.run(`
      INSERT OR REPLACE INTO deck_stats (deck_id, season_id, total_points, total_kills, total_wins, total_matches)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [s.deck_id, seasonId, s.pts, s.k, s.w, s.matches]);
  }
}

// ==========================================
// LEADERBOARD & STATS ENDPOINTS
// ==========================================

app.get('/api/leaderboards/season', async (req, res) => {
  let { seasonId } = req.query;
  try {
    if (!seasonId) {
      const season = await db.get("SELECT id FROM seasons WHERE is_active = 1");
      if (!season) return res.json([]);
      seasonId = season.id;
    }

    const standings = await db.query(`
      SELECT ps.*, p.store_nickname, p.username
      FROM player_stats ps
      JOIN players p ON ps.player_id = p.id
      WHERE ps.season_id = ?
      ORDER BY ps.total_points DESC, ps.total_wins DESC, ps.total_kills DESC
    `, [seasonId]);
    res.json(standings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leaderboards/decks', async (req, res) => {
  let { seasonId } = req.query;
  try {
    if (!seasonId) {
      const season = await db.get("SELECT id FROM seasons WHERE is_active = 1");
      if (!season) return res.json([]);
      seasonId = season.id;
    }

    const standings = await db.query(`
      SELECT ds.*, d.deck_name, d.moxfield_url, d.cheapest_total_price, d.is_legal, p.store_nickname
      FROM deck_stats ds
      JOIN decks d ON ds.deck_id = d.id
      JOIN players p ON d.player_id = p.id
      WHERE ds.season_id = ?
      ORDER BY ds.total_points DESC, ds.total_wins DESC, ds.total_kills DESC
    `, [seasonId]);
    res.json(standings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single Player Profile & Decks Statistics lookup
app.get('/api/players/:playerId/profile', async (req, res) => {
  const { playerId } = req.params;
  try {
    const profile = await db.get(
      "SELECT id, store_nickname, username, email, avatar_url, profile_commander, profile_bio, profile_theme, featured_deck_id, discord_handle, moxfield_username, created_at FROM players WHERE id = ?",
      [playerId]
    );
    const stats = await db.query(`
      SELECT ps.*, s.name as season_name
      FROM player_stats ps
      JOIN seasons s ON ps.season_id = s.id
      WHERE ps.player_id = ?
    `, [playerId]);

    const publicDecks = await db.query(`
      SELECT id, deck_name, cheapest_total_price, featured_card_name, is_public
      FROM decks
      WHERE player_id = ? AND is_public = 1
    `, [playerId]);

    let featuredDeck = null;
    if (profile && profile.featured_deck_id) {
      featuredDeck = await db.get(`
        SELECT d.*, ds.total_points, ds.total_kills, ds.total_wins, ds.total_matches,
               (SELECT card_name FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 LIMIT 1) AS commander_name,
               (SELECT scryfall_id FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 LIMIT 1) AS commander_scryfall_id
        FROM decks d
        LEFT JOIN deck_stats ds ON d.id = ds.deck_id
        WHERE d.id = ?
      `, [profile.featured_deck_id]);
    }

    res.json({ profile, stats, publicDecks, featuredDeck });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/players/active-match', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Unauthorized" });
  const playerId = req.session.player.id;
  
  try {
    const season = await db.get("SELECT * FROM seasons WHERE is_active = 1");
    if (!season) return res.json({ hasActiveMatch: false });
    
    // Find max round num in pairings
    const maxRound = await db.get("SELECT MAX(round_num) as maxRound FROM pods WHERE season_id = ?", [season.id]);
    const roundNum = maxRound ? maxRound.maxRound : null;
    
    if (!roundNum) return res.json({ hasActiveMatch: false });
    
    // Find player's pod in this round
    const podPlayer = await db.get(`
      SELECT pr.pod_id 
      FROM pod_results pr
      JOIN pods p ON pr.pod_id = p.id
      WHERE p.season_id = ? AND p.round_num = ? AND pr.player_id = ?
    `, [season.id, roundNum, playerId]);
    
    if (!podPlayer) return res.json({ hasActiveMatch: false });
    
    const podId = podPlayer.pod_id;
    
    // Fetch all players in this pod
    const podDetails = await db.get("SELECT * FROM pods WHERE id = ?", [podId]);
    const players = await db.query(`
      SELECT pr.*, p.store_nickname, d.deck_name, d.cheapest_total_price
      FROM pod_results pr
      JOIN players p ON pr.player_id = p.id
      LEFT JOIN decks d ON pr.deck_id = d.id
      WHERE pr.pod_id = ?
    `, [podId]);
    
    res.json({
      hasActiveMatch: true,
      roundNum,
      completed: podDetails.completed === 1,
      podId,
      podLabel: podDetails.pod_label,
      players,
      pointsWin: season.points_win,
      pointsDraw: season.points_draw,
      pointsKill: season.points_kill,
      pointsEntry: season.points_entry
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update Player Profile Customization Fields
app.post('/api/players/profile/update', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { storeNickname, avatarUrl, profileCommander, profileBio, profileTheme, featuredDeckId, discordHandle, moxfieldUsername } = req.body;
  
  if (!storeNickname || !storeNickname.trim()) {
    return res.status(400).json({ error: "Nickname cannot be empty." });
  }
  
  // Enforce Light Moderation (Profanity Checks)
  if (isProfane(storeNickname)) {
    return res.status(400).json({ error: "Inappropriate content detected in nickname." });
  }
  if (profileCommander && isProfane(profileCommander)) {
    return res.status(400).json({ error: "Inappropriate content detected in signature commander." });
  }
  if (profileBio && isProfane(profileBio)) {
    return res.status(400).json({ error: "Inappropriate content detected in bio." });
  }
  if (discordHandle && isProfane(discordHandle)) {
    return res.status(400).json({ error: "Inappropriate content detected in Discord handle." });
  }
  if (moxfieldUsername && isProfane(moxfieldUsername)) {
    return res.status(400).json({ error: "Inappropriate content detected in Moxfield username." });
  }

  const playerId = req.session.player.id;
  try {
    if (featuredDeckId) {
      const deck = await db.get("SELECT id FROM decks WHERE id = ? AND player_id = ?", [featuredDeckId, playerId]);
      if (!deck) {
        return res.status(400).json({ error: "Selected featured deck does not belong to you." });
      }
    }

    await db.run(
      `UPDATE players 
       SET store_nickname = ?, avatar_url = ?, profile_commander = ?, profile_bio = ?, profile_theme = ?, featured_deck_id = ?, discord_handle = ?, moxfield_username = ? 
       WHERE id = ?`,
      [
        storeNickname.trim(), 
        avatarUrl ? avatarUrl.trim() : null, 
        profileCommander ? profileCommander.trim() : null, 
        profileBio ? profileBio.trim() : null, 
        profileTheme || 'default', 
        featuredDeckId || null, 
        discordHandle ? discordHandle.trim() : null, 
        moxfieldUsername ? moxfieldUsername.trim() : null, 
        playerId
      ]
    );
    
    // Update session data
    req.session.player.store_nickname = storeNickname.trim();
    req.session.player.avatarUrl = avatarUrl ? avatarUrl.trim() : '';
    req.session.player.profileCommander = profileCommander ? profileCommander.trim() : '';
    
    res.json({
      success: true,
      storeNickname: storeNickname.trim(),
      avatarUrl: avatarUrl ? avatarUrl.trim() : '',
      profileCommander: profileCommander ? profileCommander.trim() : ''
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update Account Credentials (Username, Password, Email)
app.post('/api/players/account/update', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { newUsername, newPassword, newEmail } = req.body;
  const playerId = req.session.player.id;

  try {
    if (newUsername && newUsername.trim()) {
      const trimmedUser = newUsername.trim();
      if (isProfane(trimmedUser)) {
        return res.status(400).json({ error: "Inappropriate content detected in username." });
      }
      // Check if username is taken
      const existing = await db.get("SELECT id FROM players WHERE username = ? AND id != ?", [trimmedUser, playerId]);
      if (existing) {
        return res.status(400).json({ error: "Username is already taken." });
      }
      await db.run("UPDATE players SET username = ? WHERE id = ?", [trimmedUser, playerId]);
      req.session.player.username = trimmedUser;
    }

    if (newEmail !== undefined) {
      const trimmedEmail = newEmail ? newEmail.trim() : "";
      if (!trimmedEmail) {
        return res.status(400).json({ error: "Email address cannot be empty." });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmedEmail)) {
        return res.status(400).json({ error: "Invalid email format." });
      }
      const existingEmail = await db.get("SELECT id FROM players WHERE LOWER(email) = LOWER(?) AND id != ?", [trimmedEmail, playerId]);
      if (existingEmail) {
        return res.status(400).json({ error: "Email address is already in use by another account." });
      }
      await db.run("UPDATE players SET email = ? WHERE id = ?", [trimmedEmail, playerId]);
      req.session.player.email = trimmedEmail;
    }

    if (newPassword && newPassword.trim()) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(newPassword, salt);
      await db.run("UPDATE players SET password_hash = ? WHERE id = ?", [hash, playerId]);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Forgot Password Recovery Endpoint
app.post('/api/auth/forgot-password', async (req, res) => {
  const { usernameOrEmail } = req.body;
  if (!usernameOrEmail || !usernameOrEmail.trim()) {
    return res.status(400).json({ error: "Username or email is required." });
  }

  try {
    const player = await db.get(
      "SELECT username, email FROM players WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)",
      [usernameOrEmail.trim(), usernameOrEmail.trim()]
    );

    if (!player) {
      return res.json({ success: true, message: "If this account exists, a recovery link has been generated." });
    }

    const token = 'tok_' + Math.random().toString(36).substr(2, 9) + Date.now();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();

    await db.run("INSERT OR REPLACE INTO password_resets (username, token, expires_at) VALUES (?, ?, ?)", [player.username, token, expiresAt]);

    const forwardedProto = req.get('x-forwarded-proto');
    const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
    const resetLink = `${protocol}://${req.get('host')}/?resetToken=${encodeURIComponent(token)}`;
    console.log("\n=======================================================");
    console.log(`[SMTP SIMULATOR] Password recovery email dispatched to player: ${player.username}`);
    console.log(`[SMTP SIMULATOR] Recovery Link: ${resetLink}`);
    console.log("=======================================================\n");

    res.json({ 
      success: true, 
      message: "If this account exists, a recovery link has been generated.",
      devResetLink: resetLink
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset Password Endpoint
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token) return res.status(400).json({ error: "Reset token is missing or invalid." });
  if (!newPassword || !newPassword.trim()) {
    return res.status(400).json({ error: "Password cannot be empty." });
  }

  try {
    const record = await db.get("SELECT * FROM password_resets WHERE token = ?", [token]);
    if (!record) {
      return res.status(400).json({ error: "Invalid or expired recovery link." });
    }

    if (new Date(record.expires_at) < new Date()) {
      await db.run("DELETE FROM password_resets WHERE token = ?", [token]);
      return res.status(400).json({ error: "Recovery link has expired. Please request a new one." });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(newPassword, salt);
    await db.run("UPDATE players SET password_hash = ? WHERE LOWER(username) = LOWER(?)", [hash, record.username]);
    await db.run("DELETE FROM password_resets WHERE token = ?", [token]);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/notifications', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    const list = await db.query(
      "SELECT * FROM notifications WHERE player_id = ? ORDER BY created_at DESC LIMIT 10",
      [req.session.player.id]
    );
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notifications/read', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { id } = req.body;
  try {
    await db.run("UPDATE notifications SET read_status = 1 WHERE id = ? AND player_id = ?", [id, req.session.player.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIRECT MESSAGING ─────────────────────────────────────────────────────────

// GET inbox
app.get('/api/messages/inbox', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    const rows = await db.query(`
      SELECT dm.*, p.store_nickname AS sender_name, p.username AS sender_username
      FROM direct_messages dm
      JOIN players p ON dm.sender_id = p.id
      WHERE dm.recipient_id = ?
      ORDER BY dm.created_at DESC
      LIMIT 50
    `, [req.session.player.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET sent
app.get('/api/messages/sent', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    const rows = await db.query(`
      SELECT dm.*, p.store_nickname AS recipient_name, p.username AS recipient_username
      FROM direct_messages dm
      JOIN players p ON dm.recipient_id = p.id
      WHERE dm.sender_id = ?
      ORDER BY dm.created_at DESC
      LIMIT 50
    `, [req.session.player.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET unread count
app.get('/api/messages/unread-count', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    const row = await db.get(
      "SELECT COUNT(*) AS cnt FROM direct_messages WHERE recipient_id = ? AND read_status = 0",
      [req.session.player.id]
    );
    res.json({ count: row.cnt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST send a message
app.post('/api/messages/send', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { recipientUsername, subject, body } = req.body;
  if (!recipientUsername || !body || body.trim().length === 0) {
    return res.status(400).json({ error: "Recipient and message body are required." });
  }
  try {
    const recipient = await db.get("SELECT id, store_nickname FROM players WHERE username = ?", [recipientUsername.toLowerCase()]);
    if (!recipient) return res.status(404).json({ error: "User not found." });
    if (recipient.id === req.session.player.id) return res.status(400).json({ error: "You cannot message yourself." });
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO direct_messages (id, sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?, ?)",
      [msgId, req.session.player.id, recipient.id, subject || '(no subject)', body.trim()]
    );
    // Also drop a notification into recipient's bell
    const notifId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
      [notifId, recipient.id, `📬 Message from ${req.session.player.storeNickname}`, `"${subject || '(no subject)'}": ${body.trim().substring(0, 120)}${body.trim().length > 120 ? '…' : ''}`]
    );
    res.json({ success: true, messageId: msgId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST send feedback (always goes to admin)
app.post('/api/messages/feedback', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { body } = req.body;
  if (!body || body.trim().length === 0) return res.status(400).json({ error: "Feedback body is required." });
  try {
    const admin = await db.get("SELECT id, store_nickname FROM players WHERE is_admin = 1 LIMIT 1");
    if (!admin) return res.status(500).json({ error: "No admin account found." });
    if (admin.id === req.session.player.id) return res.status(400).json({ error: "You are the admin." });
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO direct_messages (id, sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?, ?)",
      [msgId, req.session.player.id, admin.id, `Feedback from ${req.session.player.storeNickname}`, body.trim()]
    );
    // Notify admin
    const notifId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
      [notifId, admin.id, `💬 Feedback from ${req.session.player.storeNickname}`, body.trim().substring(0, 180)]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST mark message as read
app.post('/api/messages/:id/read', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    await db.run(
      "UPDATE direct_messages SET read_status = 1 WHERE id = ? AND recipient_id = ?",
      [req.params.id, req.session.player.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FRIENDS ───────────────────────────────────────────────────────────────────

// GET my accepted friends list
app.get('/api/friends', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const me = req.session.player.id;
  try {
    const rows = await db.query(`
      SELECT
        CASE WHEN fr.sender_id = ? THEN fr.recipient_id ELSE fr.sender_id END AS friend_id,
        CASE WHEN fr.sender_id = ? THEN rp.store_nickname ELSE sp.store_nickname END AS friend_name,
        CASE WHEN fr.sender_id = ? THEN rp.username ELSE sp.username END AS friend_username,
        CASE WHEN fr.sender_id = ? THEN rp.avatar_url ELSE sp.avatar_url END AS friend_avatar
      FROM friend_requests fr
      JOIN players sp ON fr.sender_id = sp.id
      JOIN players rp ON fr.recipient_id = rp.id
      WHERE fr.status = 'accepted' AND (fr.sender_id = ? OR fr.recipient_id = ?)
    `, [me, me, me, me, me, me]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET pending friend requests sent to me
app.get('/api/friends/requests', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    const rows = await db.query(`
      SELECT fr.id, fr.sender_id, fr.created_at, p.store_nickname AS sender_name, p.username AS sender_username
      FROM friend_requests fr
      JOIN players p ON fr.sender_id = p.id
      WHERE fr.recipient_id = ? AND fr.status = 'pending'
      ORDER BY fr.created_at DESC
    `, [req.session.player.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET friendship status with a specific player
app.get('/api/friends/status/:playerId', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const me = req.session.player.id;
  const other = req.params.playerId;
  try {
    const row = await db.get(`
      SELECT id, status, sender_id FROM friend_requests
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    `, [me, other, other, me]);
    if (!row) return res.json({ status: 'none' });
    res.json({ status: row.status, isSender: row.sender_id === me, requestId: row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST send a friend request
app.post('/api/friends/request/:playerId', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const me = req.session.player.id;
  const other = req.params.playerId;
  if (me === other) return res.status(400).json({ error: "You cannot friend yourself." });
  try {
    const existing = await db.get(
      "SELECT * FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)",
      [me, other, other, me]
    );
    if (existing) return res.status(400).json({ error: "Friend request already exists." });
    const id = 'fr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run("INSERT INTO friend_requests (id, sender_id, recipient_id) VALUES (?, ?, ?)", [id, me, other]);
    // Notify recipient
    const notifId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
      [notifId, other, `🤝 Friend Request from ${req.session.player.storeNickname}`,
       `${req.session.player.storeNickname} wants to be your friend. Check your Friends tab to accept.`]
    );
    res.json({ success: true, requestId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST accept a friend request
app.post('/api/friends/accept/:requestId', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    const fr = await db.get("SELECT * FROM friend_requests WHERE id = ? AND recipient_id = ?", [req.params.requestId, req.session.player.id]);
    if (!fr) return res.status(404).json({ error: "Request not found." });
    await db.run("UPDATE friend_requests SET status = 'accepted' WHERE id = ?", [req.params.requestId]);
    // Notify sender
    const notifId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await db.run(
      "INSERT INTO notifications (id, player_id, title, message) VALUES (?, ?, ?, ?)",
      [notifId, fr.sender_id, `✅ ${req.session.player.storeNickname} accepted your friend request!`,
       `You are now friends with ${req.session.player.storeNickname}. You can message them directly from your friends list.`]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST decline a friend request
app.post('/api/friends/decline/:requestId', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  try {
    await db.run(
      "UPDATE friend_requests SET status = 'declined' WHERE id = ? AND recipient_id = ?",
      [req.params.requestId, req.session.player.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE unfriend
app.delete('/api/friends/:playerId', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const me = req.session.player.id;
  const other = req.params.playerId;
  try {
    await db.run(
      "DELETE FROM friend_requests WHERE ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)) AND status='accepted'",
      [me, other, other, me]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/seasons/:seasonId/meta', async (req, res) => {
  const { seasonId } = req.params;
  try {
    const decks = await db.query(`
      SELECT d.deck_name, d.cheapest_total_price, p.store_nickname
      FROM deck_stats ds
      JOIN decks d ON ds.deck_id = d.id
      JOIN players p ON d.player_id = p.id
      WHERE ds.season_id = ?
    `, [seasonId]);
    
    let totalPriceSum = 0;
    let legalCount = 0;
    let archetypes = {};
    
    decks.forEach(d => {
      totalPriceSum += d.cheapest_total_price;
      if (d.cheapest_total_price <= 100) legalCount++;
      
      let arch = "Other";
      const nameLower = d.deck_name.toLowerCase();
      if (nameLower.includes("control")) arch = "Control";
      else if (nameLower.includes("aggro") || nameLower.includes("burn") || nameLower.includes("stompy")) arch = "Aggro";
      else if (nameLower.includes("combo") || nameLower.includes("storm")) arch = "Combo";
      else if (nameLower.includes("midrange")) arch = "Midrange";
      else if (nameLower.includes("stax") || nameLower.includes("hatebears")) arch = "Stax";
      else if (nameLower.includes("tribal") || nameLower.includes("kindred") || nameLower.includes("elves") || nameLower.includes("dragons")) arch = "Tribal";
      
      archetypes[arch] = (archetypes[arch] || 0) + 1;
    });
    
    const totalDecks = decks.length || 1;
    const breakdown = Object.keys(archetypes).map(name => ({
      name,
      count: archetypes[name],
      percentage: parseFloat(((archetypes[name] / totalDecks) * 100).toFixed(1))
    })).sort((a, b) => b.count - a.count);
    
    res.json({
      averagePrice: parseFloat((totalPriceSum / totalDecks).toFixed(2)),
      legalityRate: parseFloat(((legalCount / totalDecks) * 100).toFixed(1)),
      breakdown
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/seasons/:seasonId/matrix', async (req, res) => {
  const { seasonId } = req.params;
  try {
    const results = await db.query(`
      SELECT pr.pod_id, pr.player_id, pr.kills, pr.placed_first, pr.placed_draw, d.deck_name
      FROM pod_results pr
      JOIN pods p ON pr.pod_id = p.id
      LEFT JOIN decks d ON pr.deck_id = d.id
      WHERE p.season_id = ? AND p.completed = 1
    `, [seasonId]);
    
    const pods = {};
    results.forEach(r => {
      if (!pods[r.pod_id]) pods[r.pod_id] = [];
      
      let arch = "Other";
      const nameLower = (r.deck_name || "").toLowerCase();
      if (nameLower.includes("control")) arch = "Control";
      else if (nameLower.includes("aggro") || nameLower.includes("burn") || nameLower.includes("stompy")) arch = "Aggro";
      else if (nameLower.includes("combo") || nameLower.includes("storm")) arch = "Combo";
      else if (nameLower.includes("midrange")) arch = "Midrange";
      else if (nameLower.includes("stax") || nameLower.includes("hatebears")) arch = "Stax";
      else if (nameLower.includes("tribal") || nameLower.includes("kindred") || nameLower.includes("elves") || nameLower.includes("dragons")) arch = "Tribal";
      
      pods[r.pod_id].push({
        playerId: r.player_id,
        archetype: arch,
        win: r.placed_first === 1
      });
    });
    
    const archetypesList = ["Control", "Aggro", "Combo", "Midrange", "Stax", "Tribal", "Other"];
    const matrix = {};
    
    archetypesList.forEach(a1 => {
      matrix[a1] = {};
      archetypesList.forEach(a2 => {
        matrix[a1][a2] = { wins: 0, total: 0 };
      });
    });
    
    Object.values(pods).forEach(playersInPod => {
      playersInPod.forEach(p1 => {
        playersInPod.forEach(p2 => {
          if (p1.playerId !== p2.playerId) {
            matrix[p1.archetype][p2.archetype].total++;
            if (p1.win) {
              matrix[p1.archetype][p2.archetype].wins++;
            }
          }
        });
      });
    });
    
    res.json({ archetypes: archetypesList, matrix });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/artists/followed', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in to view followed illustrators." });
  try {
    const artists = await db.query(
      `SELECT artist_name AS name, created_at AS followedAt
       FROM artist_follows
       WHERE player_id = ?
       ORDER BY artist_name COLLATE NOCASE`,
      [req.session.player.id]
    );
    res.json(artists);
  } catch (_error) {
    res.status(500).json({ error: "Could not load followed illustrators." });
  }
});

app.post('/api/artists/follow', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in to follow illustrators." });

  const artist = typeof req.body.artist === "string" ? req.body.artist.normalize("NFKC").trim() : "";
  const following = req.body.following;
  if (!artist || artist.length > 160) return res.status(400).json({ error: "Invalid illustrator name." });
  if (typeof following !== "boolean") return res.status(400).json({ error: "Following must be true or false." });

  const artistKey = normalizeArtistKey(artist);
  try {
    if (following) {
      await db.run(
        `INSERT INTO artist_follows (player_id, artist_key, artist_name)
         VALUES (?, ?, ?)
         ON CONFLICT(player_id, artist_key) DO UPDATE SET artist_name = excluded.artist_name`,
        [req.session.player.id, artistKey, artist]
      );

      const printing = req.body.printing || {};
      const scryfallId = typeof printing.scryfallId === "string" ? printing.scryfallId : "";
      const cardName = typeof printing.cardName === "string" ? printing.cardName.trim() : "";
      const imageUri = typeof printing.imageUri === "string" ? printing.imageUri : "";
      const setName = typeof printing.setName === "string" ? printing.setName.slice(0, 200) : "";
      if (
        /^[a-zA-Z0-9-]{20,64}$/.test(scryfallId) &&
        cardName && cardName.length <= 250 &&
        /^https:\/\/cards\.scryfall\.io\//.test(imageUri)
      ) {
        await db.run(
          `INSERT INTO followed_artist_printings
           (card_name, scryfall_id, artist_key, artist_name, image_uri, set_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(card_name, scryfall_id) DO UPDATE SET
             artist_key = excluded.artist_key,
             artist_name = excluded.artist_name,
             image_uri = excluded.image_uri,
             set_name = excluded.set_name,
             updated_at = CURRENT_TIMESTAMP`,
          [cardName, scryfallId, artistKey, artist, imageUri, setName]
        );
      }
    } else {
      await db.run(
        "DELETE FROM artist_follows WHERE player_id = ? AND artist_key = ?",
        [req.session.player.id, artistKey]
      );
    }

    res.json({ success: true, artist, following });
  } catch (error) {
    console.error("Failed to update illustrator follow:", error);
    res.status(500).json({ error: "Could not update this illustrator." });
  }
});

app.get('/api/cards/versions', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Missing card name" });

  const trimmedName = name.trim();
  try {
    let result;
    try {
      const searchUrl = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(trimmedName)}%22+not:token+not:art+not:funny+is:paper&unique=prints`;
      result = await fetchJson(searchUrl);
    } catch (err) {
      // Fall back to fuzzy name search if exact match 404s
      const fallbackUrl = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(trimmedName)}+not:token+not:art+not:funny+is:paper&unique=prints`;
      result = await fetchJson(fallbackUrl);
    }
    
    let prints = (result.data || []).filter(card => {
      if (!isRealCard(card)) return false;
      if (card.digital) return false;
      if (["funny", "token", "memorabilia"].includes(card.set_type || "")) return false;
      if (["silver", "gold"].includes(card.border_color || "")) return false;
      return true;
    }).flatMap(card => {
      const pricesObj = card.prices || {};
      const price = (typeof getLowestUsdPrice === 'function') ? getLowestUsdPrice(pricesObj) : parseFloat(pricesObj.usd || pricesObj.usd_low || pricesObj.usd_foil || "0.15");
      if (price === null) return [];

      return [{
        id: card.id,
        name: card.name,
        set: card.set ? card.set.toUpperCase() : "???",
        set_name: card.set_name || "Unknown Set",
        collector_number: card.collector_number || "",
        rarity: card.rarity || "common",
        artist: card.artist || card.card_faces?.map(face => face.artist).find(Boolean) || "Unknown illustrator",
        price: price || 0.15,
        prices: {
          normal: pricesObj.usd ? Number.parseFloat(pricesObj.usd) : null,
          foil: pricesObj.usd_foil ? Number.parseFloat(pricesObj.usd_foil) : null,
          etched: pricesObj.usd_etched ? Number.parseFloat(pricesObj.usd_etched) : null
        },
        image_uri: card.image_uris ? (card.image_uris.normal || card.image_uris.small) : (card.card_faces && card.card_faces[0].image_uris ? card.card_faces[0].image_uris.normal : ""),
        foil: !!pricesObj.usd_foil && !pricesObj.usd
      }];
    });

    // Add community totals and this player's preference without an N+1 query.
    const printingIds = prints.map(print => print.id);
    if (printingIds.length > 0) {
      const placeholders = printingIds.map(() => "?").join(",");
      const aggregateRows = await db.query(
        `SELECT scryfall_id,
          SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS likes,
          SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS dislikes
         FROM card_art_votes
         WHERE scryfall_id IN (${placeholders})
         GROUP BY scryfall_id`,
        printingIds
      );
      const voteTotals = new Map(aggregateRows.map(row => [row.scryfall_id, row]));
      const playerVotes = new Map();

      if (req.session.player) {
        const playerRows = await db.query(
          `SELECT scryfall_id, vote
           FROM card_art_votes
           WHERE player_id = ? AND scryfall_id IN (${placeholders})`,
          [req.session.player.id, ...printingIds]
        );
        playerRows.forEach(row => playerVotes.set(row.scryfall_id, row.vote));
      }

      prints = prints.map(print => ({
        ...print,
        likes: Number(voteTotals.get(print.id)?.likes || 0),
        dislikes: Number(voteTotals.get(print.id)?.dislikes || 0),
        userVote: Number(playerVotes.get(print.id) || 0)
      }));
    }

    const followedArtists = await getFollowedArtistMap(req.session.player?.id);
    prints = prints.map(print => ({
      ...print,
      artistFollowed: followedArtists.has(normalizeArtistKey(print.artist))
    }));

    const followedPrintings = prints.filter(print => print.artistFollowed && print.image_uri);
    if (followedPrintings.length > 0) {
      await Promise.all(followedPrintings.map(print => db.run(
        `INSERT INTO followed_artist_printings
         (card_name, scryfall_id, artist_key, artist_name, image_uri, set_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(card_name, scryfall_id) DO UPDATE SET
           artist_key = excluded.artist_key,
           artist_name = excluded.artist_name,
           image_uri = excluded.image_uri,
           set_name = excluded.set_name,
           updated_at = CURRENT_TIMESTAMP`,
        [print.name, print.id, normalizeArtistKey(print.artist), print.artist, print.image_uri, print.set_name]
      )));
    }

    // Followed illustrators lead the gallery; price remains the tie-breaker.
    prints.sort((a, b) => Number(b.artistFollowed) - Number(a.artistFollowed) || a.price - b.price);

    // Cache the cheapest price and update the local database with it
    if (prints.length > 0) {
      const cheapest = prints[0];
      try {
        await db.run(
          "INSERT OR REPLACE INTO card_price_cache (card_name, price, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
          [cheapest.name, cheapest.price]
        );
        await db.run(
          "UPDATE scryfall_cards SET price = ?, scryfall_id = ? WHERE LOWER(card_name) = ?",
          [cheapest.price, cheapest.id, cheapest.name.toLowerCase()]
        );
      } catch (dbErr) {
        console.warn(`Failed to cache cheapest price for ${cheapest.name}:`, dbErr.message);
      }
    }

    res.json(prints);
  } catch (e) {
    console.error("Failed to fetch versions:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cards/versions/:scryfallId/vote', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in to rate card art." });

  const { scryfallId } = req.params;
  const cardName = typeof req.body.cardName === "string" ? req.body.cardName.trim() : "";
  const vote = Number(req.body.vote);

  if (!/^[a-zA-Z0-9-]{20,64}$/.test(scryfallId)) {
    return res.status(400).json({ error: "Invalid printing ID." });
  }
  if (!cardName || cardName.length > 250) {
    return res.status(400).json({ error: "Invalid card name." });
  }
  if (![ -1, 0, 1 ].includes(vote)) {
    return res.status(400).json({ error: "Vote must be like, dislike, or clear." });
  }

  try {
    if (vote === 0) {
      await db.run(
        "DELETE FROM card_art_votes WHERE player_id = ? AND scryfall_id = ?",
        [req.session.player.id, scryfallId]
      );
    } else {
      await db.run(
        `INSERT INTO card_art_votes (player_id, scryfall_id, card_name, vote)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(player_id, scryfall_id) DO UPDATE SET
           card_name = excluded.card_name,
           vote = excluded.vote,
           updated_at = CURRENT_TIMESTAMP`,
        [req.session.player.id, scryfallId, cardName, vote]
      );
    }

    const totals = await db.get(
      `SELECT
        SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS likes,
        SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS dislikes
       FROM card_art_votes
       WHERE scryfall_id = ?`,
      [scryfallId]
    );

    res.json({
      success: true,
      scryfallId,
      likes: Number(totals?.likes || 0),
      dislikes: Number(totals?.dislikes || 0),
      userVote: vote
    });
  } catch (error) {
    console.error("Failed to save card art vote:", error);
    res.status(500).json({ error: "Could not save your art preference." });
  }
});

app.get('/api/cards/rulings', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing card ID" });
  try {
    const rulingsUrl = `https://api.scryfall.com/cards/${id}/rulings`;
    const result = await fetchJson(rulingsUrl);
    res.json(result.data || []);
  } catch (e) {
    console.error("Failed to fetch rulings:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cards/search', async (req, res) => {
  const { q, sort, dir } = req.query;
  if (!q) return res.json({ cards: [], totalCards: 0, hasMore: false });
  
  const pageNum = parseInt(req.query.page) || 1;
  const limitNum = parseInt(req.query.limit) || 60;
  const offsetNum = (pageNum - 1) * limitNum;
  const isAdvanced = q.includes(':') || q.includes('=') || q.includes('<') || q.includes('>');

  try {
    if (isAdvanced) {
      throw new Error("Advanced search query - bypass local cache");
    }
    const queryTerm = `%${q.trim()}%`;
    
    // Count total local results
    const countRows = await db.query(
      "SELECT COUNT(*) as count FROM scryfall_cards WHERE card_name LIKE ?",
      [queryTerm]
    );
    const totalCards = countRows[0] ? countRows[0].count : 0;

    let orderClause = "CASE WHEN LOWER(c.card_name) = LOWER(?) THEN 0 ELSE 1 END, LENGTH(c.card_name) ASC";
    if (sort === 'name') {
      orderClause = `CASE WHEN LOWER(c.card_name) = LOWER(?) THEN 0 ELSE 1 END, c.card_name ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    } else if (sort === 'price') {
      orderClause = `CASE WHEN LOWER(c.card_name) = LOWER(?) THEN 0 ELSE 1 END, cached_cheapest_price ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    } else if (sort === 'cmc') {
      orderClause = `CASE WHEN LOWER(c.card_name) = LOWER(?) THEN 0 ELSE 1 END, c.cmc ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    } else if (sort === 'rarity') {
      const d = dir === 'desc' ? 'DESC' : 'ASC';
      orderClause = `CASE WHEN LOWER(c.card_name) = LOWER(?) THEN 0 ELSE 1 END, CASE c.rarity WHEN 'mythic' THEN 1 WHEN 'rare' THEN 2 WHEN 'uncommon' THEN 3 WHEN 'common' THEN 4 ELSE 5 END ${d}`;
    } else if (sort === 'subtype') {
      const d = dir === 'desc' ? 'DESC' : 'ASC';
      orderClause = `CASE WHEN LOWER(c.card_name) = LOWER(?) THEN 0 ELSE 1 END, CASE WHEN c.type_line LIKE '%—%' THEN SUBSTR(c.type_line, INSTR(c.type_line, '—') + 1) ELSE '' END ${d}`;
    }

    const rows = await db.query(
      `SELECT c.*, p.price as cached_cheapest_price 
       FROM scryfall_cards c 
       LEFT JOIN card_price_cache p ON c.card_name = p.card_name 
       WHERE c.card_name LIKE ? 
       ORDER BY ${orderClause} 
       LIMIT ? OFFSET ?`,
      [q.trim(), queryTerm, limitNum, offsetNum]
    );
    
    if (rows.length === 0) {
      // If no local results, try falling back to Scryfall API (could be a new card)
      throw new Error("No local matching cards");
    }

    let cards = rows.map(card => {
      let colors = [];
      try {
        colors = JSON.parse(card.colors || "[]");
      } catch (e) {}
      
      const finalPrice = card.cached_cheapest_price !== null && card.cached_cheapest_price !== undefined 
        ? card.cached_cheapest_price 
        : (card.price !== null && card.price !== undefined ? card.price : 0.05);

      return {
        name: card.card_name,
        price: finalPrice,
        scryfallId: card.scryfall_id,
        type_line: card.type_line || "",
        oracle_text: card.oracle_text || "",
        mana_cost: card.mana_cost || "",
        cmc: card.cmc !== undefined ? card.cmc : 0,
        colors: colors,
        rarity: card.rarity || "common",
        image_uri: card.scryfall_id 
          ? `https://cards.scryfall.io/normal/front/${card.scryfall_id[0]}/${card.scryfall_id[1]}/${card.scryfall_id}.jpg` 
          : ""
      };
    });
    cards = await applyFollowedArtistPreferences(cards, req.session.player?.id);
    
    const hasMore = (offsetNum + cards.length) < totalCards;
    res.json({ cards, totalCards, hasMore });
  } catch (e) {
    try {
      const scryfallPageSize = 175;
      const scryfallPage = Math.floor(offsetNum / scryfallPageSize) + 1;
      const scryfallOffset = offsetNum % scryfallPageSize;
      let searchUrl = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}+not:funny+not:token+not:art+is:paper&page=${scryfallPage}`;
      
      let scryfallOrder = 'name';
      if (sort === 'price') scryfallOrder = 'usd';
      else if (sort === 'cmc') scryfallOrder = 'cmc';
      else if (sort === 'rarity') scryfallOrder = 'rarity';
      
      if (sort !== 'subtype') {
        searchUrl += `&order=${encodeURIComponent(scryfallOrder)}`;
        if (dir === 'asc' || dir === 'desc') {
          searchUrl += `&dir=${encodeURIComponent(dir)}`;
        }
      } else {
        searchUrl += `&order=name`;
      }
      
      const result = await fetchJson(searchUrl);
      const filteredData = (result.data || []).filter(card => {
        const layout = card.layout || "";
        if (["token", "double_faced_token", "emblem", "art_series", "memorabilia"].includes(layout)) return false;

        const set_type = card.set_type || "";
        if (["funny", "token", "memorabilia"].includes(set_type)) return false;

        const border_color = card.border_color || "";
        if (border_color === "silver" || border_color === "gold") return false;

        if (card.digital) return false;

        const leg = card.legalities || {};
        const isLegalSomewhere = Object.values(leg).some(status => status === "legal" || status === "restricted");
        if (!isLegalSomewhere) return false;

        return true;
      });
      const followedArtists = await getFollowedArtistMap(req.session.player?.id);
      let cards = filteredData.map(card => {
        const price = getLowestUsdPrice(card.prices);
        const artist = card.artist || card.card_faces?.map(face => face.artist).find(Boolean) || "";
        return {
          name: card.name,
          price: price ?? 0.05,
          scryfallId: card.id,
          type_line: card.type_line || "",
          oracle_text: card.oracle_text || "",
          mana_cost: card.mana_cost || "",
          cmc: card.cmc !== undefined ? card.cmc : 0,
          colors: card.colors || [],
          rarity: card.rarity || "common",
          artist,
          artistFollowed: followedArtists.has(normalizeArtistKey(artist)),
          image_uri: card.image_uris ? (card.image_uris.normal || card.image_uris.small) : (card.card_faces && card.card_faces[0].image_uris ? card.card_faces[0].image_uris.normal : "")
        };
      });

      if (sort === 'subtype') {
        const getSubtype = (typeLine) => {
          if (!typeLine) return "";
          const parts = typeLine.split(/—/);
          return parts.length > 1 ? parts[1].trim() : "";
        };

        cards.sort((a, b) => {
          const subA = getSubtype(a.type_line);
          const subB = getSubtype(b.type_line);
          if (subA === subB) {
            return a.name.localeCompare(b.name);
          }
          return dir === 'desc' ? subB.localeCompare(subA) : subA.localeCompare(subB);
        });
      }

      cards = cards.slice(scryfallOffset, scryfallOffset + limitNum);
      cards = await applyFollowedArtistPreferences(cards, req.session.player?.id);
      
      const totalCards = result.total_cards || cards.length;
      const hasMore = (offsetNum + cards.length) < totalCards;
      res.json({ cards, totalCards, hasMore });
    } catch (fallbackErr) {
      res.json({ cards: [], totalCards: 0, hasMore: false });
    }
  }
});

app.get('/api/cards/details', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Missing card name" });
  
  // 1. Try Scryfall live lookup to get legalities, latest printings, etc.
  try {
    const liveData = await fetchJson(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);

    if (liveData) {
      // Extract face details for double faced cards
      let oracleText = liveData.oracle_text || "";
      let typeLine = liveData.type_line || "";
      let manaCost = liveData.mana_cost || "";
      
      if (liveData.card_faces && liveData.card_faces.length > 0) {
        // Double faced card
        const face1 = liveData.card_faces[0];
        oracleText = face1.oracle_text || "";
        typeLine = face1.type_line || "";
        manaCost = face1.mana_cost || "";
      }

      const livePrice = getLowestUsdPrice(liveData.prices);
      return res.json({
        name: liveData.name,
        price: livePrice ?? 0.10,
        scryfallId: liveData.id,
        type_line: typeLine,
        oracle_text: oracleText,
        mana_cost: manaCost,
        cmc: liveData.cmc !== undefined ? liveData.cmc : 0,
        colors: liveData.colors || [],
        rarity: liveData.rarity || "common",
        legalities: liveData.legalities || {}
      });
    }
  } catch (liveErr) {
    console.warn(`Scryfall live details lookup failed for '${name}':`, liveErr.message);
  }

  // 2. Fallback: query local database card cache
  try {
    const details = await getCheapestCardPrice(name);
    res.json({
      name,
      price: details.price,
      scryfallId: details.scryfallId,
      type_line: details.type_line || "",
      oracle_text: details.oracle_text || "",
      mana_cost: details.mana_cost || "",
      cmc: details.cmc !== undefined ? details.cmc : 0,
      colors: details.colors || [],
      rarity: details.rarity || "common",
      legalities: {
        commander: "legal",
        standard: "not_legal",
        modern: "not_legal",
        legacy: "not_legal",
        pioneer: "not_legal",
        pauper: "not_legal"
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cards/details-batch', async (req, res) => {
  const { names } = req.body;
  if (!names || !Array.isArray(names)) {
    return res.status(400).json({ error: "Missing or invalid names list" });
  }
  try {
    const results = await resolveCardDetailsBatch(names);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/decks/builder-save', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Not logged in." });
  const { deckId, deckName, commanderCards, mainboardCards, isPublic, featuredCardName, format, keepCheapest, customTags } = req.body;
  if (!deckName) return res.status(400).json({ error: "Deck name is required." });
  
  if (isProfane(deckName)) {
    return res.status(400).json({ error: "Inappropriate content detected. Please choose a different deck name." });
  }
  for (const c of (mainboardCards || [])) {
    if (c.custom_tag && isProfane(c.custom_tag)) {
      return res.status(400).json({ error: "Inappropriate content detected in tag names." });
    }
  }
  for (const c of (commanderCards || [])) {
    if (c.custom_tag && isProfane(c.custom_tag)) {
      return res.status(400).json({ error: "Inappropriate content detected in tag names." });
    }
  }
  if (customTags && Array.isArray(customTags)) {
    for (const tag of customTags) {
      if (typeof tag === 'string' && isProfane(tag)) {
        return res.status(400).json({ error: "Inappropriate content detected in deck tags." });
      }
    }
  }
  
  const playerId = req.session.player.id;
  const finalIsPublic = isPublic === 1 ? 1 : 0; // Default to private (0)
  const finalKeepCheapest = keepCheapest === 1 ? 1 : 0; // Default to 0 (disabled)
  
  try {
    let targetDeckId = deckId;
    let isEditing = false;
    if (targetDeckId) {
      const existing = await db.get("SELECT id FROM decks WHERE id = ? AND player_id = ?", [targetDeckId, playerId]);
      if (existing) {
        isEditing = true;
      } else {
        targetDeckId = null; // if deck ID doesn't belong to player, treat as new or error
      }
    }
    
    if (!targetDeckId) {
      targetDeckId = 'd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    
    let totalPrice = 0;
    const allCards = [];
    
    const cardNames = [
      ...(commanderCards || []).map(c => c.name),
      ...(mainboardCards || []).map(c => c.name)
    ];
    
    const resolvedBatch = await resolveCardDetailsBatch(cardNames);
    
    [
      ...(commanderCards || []).map(c => ({...c, isCommander: 1})),
      ...(mainboardCards || []).map(c => ({...c, isCommander: 0}))
    ].forEach(c => {
      const details = resolvedBatch[c.name] || {};
      const isBasic = isBasicLand(c.name);
      
      // Default to cheapest resolved details
      let finalPrice = isBasic ? 0.00 : (details.price !== null && details.price !== undefined ? details.price : 0.10);
      let finalScryfallId = details.scryfallId;

      // If keepCheapest is disabled, and client provides specific printing versions/prices, preserve them
      if (finalKeepCheapest !== 1 && c.scryfallId && c.price !== undefined) {
        finalPrice = isBasic ? 0.00 : parseFloat(c.price) || 0.10;
        finalScryfallId = c.scryfallId;
      }

      const qty = c.qty !== undefined ? (parseInt(c.qty, 10) || 1) : (c.quantity !== undefined ? (parseInt(c.quantity, 10) || 1) : 1);
      
      const cardObj = {
        name: c.name,
        price: finalPrice,
        qty,
        scryfallId: finalScryfallId,
        custom_tag: c.custom_tag,
        isCommander: c.isCommander
      };
      
      totalPrice += finalPrice * qty;
      allCards.push(cardObj);
    });
    
    const commObj = {};
    (commanderCards || []).forEach(c => { commObj[c.name] = c; });
    const finalFeaturedCardName = featuredCardName || computeFeaturedCard(commObj, allCards);
    
    if (isEditing) {
      await db.run(`
        UPDATE decks
        SET deck_name = ?, cheapest_total_price = ?, is_public = ?, featured_card_name = ?, format = ?, keep_cheapest = ?, custom_tags = ?, last_checked = CURRENT_TIMESTAMP
        WHERE id = ? AND player_id = ?
      `, [deckName, parseFloat(totalPrice.toFixed(2)), finalIsPublic, finalFeaturedCardName, format || 'commander', finalKeepCheapest, JSON.stringify(customTags || []), targetDeckId, playerId]);
      
      await db.run("DELETE FROM deck_cards WHERE deck_id = ?", [targetDeckId]);
    } else {
      await db.run(`
        INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, last_checked, is_public, featured_card_name, format, keep_cheapest, custom_tags)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
      `, [targetDeckId, playerId, 'visual-' + targetDeckId, deckName, parseFloat(totalPrice.toFixed(2)), finalIsPublic, finalFeaturedCardName, format || 'commander', finalKeepCheapest, JSON.stringify(customTags || [])]);
    }
    
    for (let card of allCards) {
      await db.run(
        "INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag, is_commander) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [targetDeckId, card.name, card.price, card.qty, card.scryfallId, card.custom_tag || null, card.isCommander]
      );
    }
    
    // Validate deck legality against all active rules (banlist, rarities, colors, budget)
    const validation = await validateDeckLegality(targetDeckId);
    const isLegal = validation.isLegal ? 1 : 0;
    const legalityReason = validation.reason || null;
    
    await db.run(
      "UPDATE decks SET is_legal = ?, legality_reason = ? WHERE id = ?",
      [isLegal, legalityReason, targetDeckId]
    );
    
    if (!isEditing) {
      const activeSeason = await db.get("SELECT id FROM seasons WHERE is_active = 1");
      if (activeSeason) {
        try {
          if (isPostgres) {
            await db.run("INSERT INTO deck_stats (deck_id, season_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [targetDeckId, activeSeason.id]);
          } else {
            await db.run("INSERT OR IGNORE INTO deck_stats (deck_id, season_id) VALUES (?, ?)", [targetDeckId, activeSeason.id]);
          }
        } catch (err) {
          // Ignore duplicate stats entry if already exists
        }
      }
    }
    
    res.json({ success: true, deckId: targetDeckId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// MTGJSON Database Sync Endpoints
app.post('/api/admin/sync-mtgjson', (req, res) => {
  if (!req.session.player || !req.session.player.username || req.session.player.username.toLowerCase() !== 'nickbuildsdecks') {
    return res.status(403).json({ error: "Access denied. Personal Administrator only." });
  }
  
  mtgjsonService.downloadAndUnzipMTGJSON().catch(err => {
    console.error("MTGJSON Sync Failed:", err);
  });
  
  res.json({ success: true, message: "Sync started in background." });
});

app.get('/api/admin/sync-mtgjson/status', (req, res) => {
  if (!req.session.player || !req.session.player.username || req.session.player.username.toLowerCase() !== 'nickbuildsdecks') {
    return res.status(403).json({ error: "Access denied. Personal Administrator only." });
  }
  res.json(global.mtgjsonSyncStatus || { status: 'idle', progress: 0, message: 'System ready.' });
});

// Auth alias: /api/auth/me — same as /api/auth/status
app.get('/api/auth/me', (req, res) => {
  if (req.session.player) {
    res.json({ loggedIn: true, player: req.session.player, user: req.session.player });
  } else {
    res.json({ loggedIn: false });
  }
});

// Delete a deck (owner only)
app.delete('/api/decks/:deckId', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: 'Not logged in.' });
  const { deckId } = req.params;
  const playerId = req.session.player.id;
  try {
    const deck = await db.get('SELECT * FROM decks WHERE id = ? AND player_id = ?', [deckId, playerId]);
    if (!deck) return res.status(403).json({ error: 'Deck not found or access denied.' });
    
    // Archive deck details and cards for soft-deletion recovery
    const cards = await db.query('SELECT * FROM deck_cards WHERE deck_id = ?', [deckId]);
    const recoveryId = 'rec_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    await db.run(
      "INSERT INTO deleted_items (id, item_type, item_id, player_id, name, data) VALUES (?, 'deck', ?, ?, ?, ?)",
      [recoveryId, deckId, playerId, deck.deck_name, JSON.stringify({ deck, cards })]
    );

    await db.run('DELETE FROM deck_cards WHERE deck_id = ?', [deckId]);
    await db.run('DELETE FROM deck_stats WHERE deck_id = ?', [deckId]);
    await db.run('DELETE FROM deck_likes WHERE deck_id = ?', [deckId]);
    await db.run('DELETE FROM deck_comments WHERE deck_id = ?', [deckId]);
    await db.run('DELETE FROM decks WHERE id = ?', [deckId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ⏰ Daily 6AM CDT Reset & Cheapest Auto-Repricing Cron
let lastDailyResetDate = '';

async function dailyResetAndCheapestUpdate() {
  console.log("[Daily Reset] Starting SQLite database health audit & optimization...");
  try {
    const integrity = await db.get("PRAGMA integrity_check");
    console.log("[Daily Reset] DB integrity check result:", integrity);
    
    await db.run("VACUUM");
    console.log("[Daily Reset] DB vacuuming complete.");
    
    // Purge cache entries older than 30 days
    await db.run("DELETE FROM card_price_cache WHERE last_updated < datetime('now', '-30 days')");
    console.log("[Daily Reset] Outdated price cache cleanup complete.");
  } catch (e) {
    console.error("[Daily Reset] DB audit error:", e);
  }

  try {
    console.log("[Daily Reset] Running auto-cheapest card updates for configured decks...");
    const decks = await db.query("SELECT * FROM decks WHERE keep_cheapest = 1");
    console.log(`[Daily Reset] Found ${decks.length} decks configured for automatic cheapest updates.`);

    for (const deck of decks) {
      console.log(`[Daily Reset] Repricing deck: ${deck.deck_name} (${deck.id})`);
      const cards = await db.query("SELECT card_name, quantity, is_commander, custom_tag FROM deck_cards WHERE deck_id = ?", [deck.id]);
      
      if (cards.length === 0) continue;
      
      let totalPrice = 0;
      const updatedCards = [];
      const delay = ms => new Promise(res => setTimeout(res, ms));

      for (const c of cards) {
        const cardName = c.card_name;
        const searchUrl = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints`;
        
        let price = 0.05;
        let scryfallId = null;

        try {
          const result = await fetchJson(searchUrl);
          const prints = result.data || [];
          
          const legalPrints = prints.filter(p => {
            if (p.digital) return false;
            if (p.funny) return false;
            if (p.border_color === 'gold' || p.border_color === 'silver') return false;
            const leg = p.legalities || {};
            if (deck.format && deck.format !== 'custom') {
              const formatStatus = leg[deck.format];
              if (formatStatus !== 'legal' && formatStatus !== 'restricted') {
                return false;
              }
            }
            return true;
          });

          let cheapestPrint = null;
          let minPrice = Infinity;
          const printsToEvaluate = legalPrints.length > 0 ? legalPrints : prints;

          printsToEvaluate.forEach(p => {
            if (p.prices) {
              const usd = parseFloat(p.prices.usd);
              const usdFoil = parseFloat(p.prices.usd_foil);
              const usdEtched = parseFloat(p.prices.usd_etched);
              
              let pVal = Infinity;
              if (usd && usd < pVal) pVal = usd;
              if (usdFoil && usdFoil < pVal) pVal = usdFoil;
              if (usdEtched && usdEtched < pVal) pVal = usdEtched;

              if (pVal < minPrice) {
                minPrice = pVal;
                cheapestPrint = p;
              }
            }
          });

          if (cheapestPrint) {
            price = minPrice === Infinity ? 0.05 : minPrice;
            scryfallId = cheapestPrint.id;
          }
        } catch (err) {
          console.error(`[Daily Reset] Failed to fetch cheapest print for ${cardName}:`, err.message);
          // Fallback to current database price if Scryfall search fails
          const current = await db.get("SELECT cheapest_card_price, scryfall_id FROM deck_cards WHERE deck_id = ? AND card_name = ?", [deck.id, cardName]);
          if (current) {
            price = current.cheapest_card_price;
            scryfallId = current.scryfall_id;
          }
        }

        await delay(100);

        if (isBasicLand(cardName) && deck.include_basic_lands_in_price !== 1) {
          price = 0.00;
        }

        totalPrice += price * c.quantity;
        
        updatedCards.push({
          name: cardName,
          price: price,
          scryfallId: scryfallId,
          qty: c.quantity,
          isCommander: c.is_commander,
          custom_tag: c.custom_tag
        });
      }

      await db.run(
        "UPDATE decks SET cheapest_total_price = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?",
        [parseFloat(totalPrice.toFixed(2)), deck.id]
      );

      await db.run("DELETE FROM deck_cards WHERE deck_id = ?", [deck.id]);
      for (const card of updatedCards) {
        await db.run(
          "INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag, is_commander) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [deck.id, card.name, card.price, card.qty, card.scryfallId, card.custom_tag || null, card.isCommander]
        );
      }

      const validation = await validateDeckLegality(deck.id);
      await db.run(
        "UPDATE decks SET is_legal = ?, legality_reason = ? WHERE id = ?",
        [validation.isLegal ? 1 : 0, validation.reason || null, deck.id]
      );
      
      console.log(`[Daily Reset] Deck "${deck.deck_name}" successfully updated.`);
    }
  } catch (err) {
    console.error("[Daily Reset] Cheapest deck updates failed:", err);
  }
}

// ==========================================
// MY COLLECTIONS & WISHLIST API ENDPOINTS
// ==========================================

// GET all collections for a player (including aggregate totals)
app.get('/api/collections', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  try {
    const rows = await db.query(
      `SELECT c.*, 
              COALESCE(SUM(cc.quantity), 0) as total_cards,
              COALESCE(SUM(cc.quantity * COALESCE(pc.price, sc.price, 0.15)), 0) as total_value
       FROM collections c
       LEFT JOIN collection_cards cc ON c.id = cc.collection_id
       LEFT JOIN card_price_cache pc ON cc.card_name = pc.card_name
       LEFT JOIN scryfall_cards sc ON cc.card_name = sc.card_name
       WHERE c.player_id = ?
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [playerId]
    );
    res.json({ success: true, collections: rows });
  } catch (e) {
    console.error("Failed to load collections:", e);
    res.status(500).json({ error: e.message });
  }
});

// CREATE a new collection
app.post('/api/collections', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { name, settings } = req.body;
  if (!name) return res.status(400).json({ error: "Collection name is required." });
  try {
    const id = 'col_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    await db.run(
      "INSERT INTO collections (id, player_id, name, settings) VALUES (?, ?, ?, ?)",
      [id, playerId, name, JSON.stringify(settings || {})]
    );
    res.json({ success: true, collectionId: id });
  } catch (e) {
    console.error("Failed to create collection:", e);
    res.status(500).json({ error: e.message });
  }
});

// UPDATE collection settings
app.put('/api/collections/:id', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { id } = req.params;
  const { name, settings } = req.body;
  try {
    const coll = await db.get("SELECT * FROM collections WHERE id = ? AND player_id = ?", [id, playerId]);
    if (!coll) return res.status(404).json({ error: "Collection not found." });
    if (name) {
      await db.run("UPDATE collections SET name = ? WHERE id = ?", [name, id]);
    }
    if (settings) {
      await db.run("UPDATE collections SET settings = ? WHERE id = ?", [JSON.stringify(settings), id]);
    }
    res.json({ success: true });
  } catch (e) {
    console.error("Failed to update collection:", e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE a collection
app.delete('/api/collections/:id', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { id } = req.params;
  try {
    const coll = await db.get("SELECT * FROM collections WHERE id = ? AND player_id = ?", [id, playerId]);
    if (!coll) return res.status(404).json({ error: "Collection not found." });
    
    // Archive collection data and cards for soft-deletion recovery
    const cards = await db.query("SELECT * FROM collection_cards WHERE collection_id = ?", [id]);
    const recoveryId = 'rec_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    await db.run(
      "INSERT INTO deleted_items (id, item_type, item_id, player_id, name, data) VALUES (?, 'collection', ?, ?, ?, ?)",
      [recoveryId, id, playerId, coll.name, JSON.stringify({ collection: coll, cards })]
    );

    await db.run("DELETE FROM collection_cards WHERE collection_id = ?", [id]);
    await db.run("DELETE FROM collections WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (e) {
    console.error("Failed to delete collection:", e);
    res.status(500).json({ error: e.message });
  }
});

// GET cards in a collection
app.get('/api/collections/:id/cards', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { id } = req.params;
  try {
    const coll = await db.get("SELECT * FROM collections WHERE id = ? AND player_id = ?", [id, playerId]);
    if (!coll) return res.status(404).json({ error: "Collection not found." });
    const cards = await db.query(
      `SELECT cc.*, 
              COALESCE(pc.price, sc.price, 0.15) as price,
              COALESCE(pc.type_line, sc.type_line, 'Card') as type_line,
              COALESCE(pc.oracle_text, sc.oracle_text, '') as oracle_text,
              COALESCE(pc.colors, sc.colors, '[]') as colors,
              COALESCE(pc.cmc, sc.cmc, 0) as cmc,
              COALESCE(cc.scryfall_id, sc.scryfall_id) as scryfall_id
       FROM collection_cards cc
       LEFT JOIN card_price_cache pc ON cc.card_name = pc.card_name
       LEFT JOIN scryfall_cards sc ON cc.card_name = sc.card_name
       WHERE cc.collection_id = ?
       ORDER BY cc.card_name ASC`,
      [id]
    );
    res.json({ success: true, cards });
  } catch (e) {
    console.error("Failed to get cards from collection:", e);
    res.status(500).json({ error: e.message });
  }
});

// ADD/INCREMENT card in a collection
app.post('/api/collections/:id/cards', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { id } = req.params;
  const { cardName, scryfallId, quantity, isFoil, condition, language, purchasePrice, isForTrade } = req.body;
  if (!cardName) return res.status(400).json({ error: "Card name is required." });

  try {
    const coll = await db.get("SELECT * FROM collections WHERE id = ? AND player_id = ?", [id, playerId]);
    if (!coll) return res.status(404).json({ error: "Collection not found." });

    const qty = quantity || 1;
    const foil = isFoil ? 1 : 0;
    const trade = isForTrade ? 1 : 0;
    const cond = condition || 'NM';
    const lang = language || 'EN';
    const price = purchasePrice || null;

    // Check if card matches database scryfall_cards or price cache to fetch scryfallId
    let resolvedScryfallId = scryfallId || null;
    if (!resolvedScryfallId) {
      const match = await db.get("SELECT scryfall_id FROM scryfall_cards WHERE card_name = ? COLLATE NOCASE", [cardName]);
      if (match) resolvedScryfallId = match.scryfall_id;
    }

    await db.run(
      `INSERT INTO collection_cards (collection_id, card_name, scryfall_id, quantity, is_foil, is_for_trade, condition, language, purchase_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection_id, card_name, scryfall_id, is_foil, condition, language) 
       DO UPDATE SET quantity = quantity + EXCLUDED.quantity`,
      [id, cardName, resolvedScryfallId, qty, foil, trade, cond, lang, price]
    );

    // Auto-remove or decrement from wishlist if it exists
    const wishlistCard = await db.get(
      "SELECT * FROM wishlist_cards WHERE player_id = ? AND card_name = ? COLLATE NOCASE",
      [playerId, cardName]
    );
    if (wishlistCard) {
      const newWishQty = wishlistCard.quantity - qty;
      if (newWishQty <= 0) {
        await db.run(
          "DELETE FROM wishlist_cards WHERE player_id = ? AND card_name = ? COLLATE NOCASE",
          [playerId, cardName]
        );
      } else {
        await db.run(
          "UPDATE wishlist_cards SET quantity = ? WHERE player_id = ? AND card_name = ? COLLATE NOCASE",
          [newWishQty, playerId, cardName]
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error("Failed to add card to collection:", e);
    res.status(500).json({ error: e.message });
  }
});

// UPDATE collection card properties
app.put('/api/collections/:id/cards', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { id } = req.params;
  const { 
    cardName, scryfallId, isFoil, condition, language,
    newQuantity, newIsFoil, newIsForTrade, newCondition, newLanguage, newPurchasePrice 
  } = req.body;

  try {
    const coll = await db.get("SELECT * FROM collections WHERE id = ? AND player_id = ?", [id, playerId]);
    if (!coll) return res.status(404).json({ error: "Collection not found." });

    const foil = isFoil ? 1 : 0;
    const cond = condition || 'NM';
    const lang = language || 'EN';
    
    // Perform update
    await db.run(
      `UPDATE collection_cards 
       SET quantity = ?, is_foil = ?, is_for_trade = ?, condition = ?, language = ?, purchase_price = ?
       WHERE collection_id = ? AND card_name = ? AND COALESCE(scryfall_id, '') = COALESCE(?, '') AND is_foil = ? AND condition = ? AND language = ?`,
      [
        newQuantity, newIsFoil ? 1 : 0, newIsForTrade ? 1 : 0, newCondition, newLanguage, newPurchasePrice || null,
        id, cardName, scryfallId || null, foil, cond, lang
      ]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Failed to update collection card:", e);
    res.status(500).json({ error: e.message });
  }
});

// REMOVE card from a collection
app.delete('/api/collections/:id/cards', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { id } = req.params;
  const { cardName, scryfallId, isFoil, condition, language } = req.body;

  try {
    const coll = await db.get("SELECT * FROM collections WHERE id = ? AND player_id = ?", [id, playerId]);
    if (!coll) return res.status(404).json({ error: "Collection not found." });

    const foil = isFoil ? 1 : 0;
    const cond = condition || 'NM';
    const lang = language || 'EN';

    await db.run(
      `DELETE FROM collection_cards 
       WHERE collection_id = ? AND card_name = ? AND COALESCE(scryfall_id, '') = COALESCE(?, '') AND is_foil = ? AND condition = ? AND language = ?`,
      [id, cardName, scryfallId || null, foil, cond, lang]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Failed to remove collection card:", e);
    res.status(500).json({ error: e.message });
  }
});

// GET wishlist cards
app.get('/api/wishlist', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  try {
    const wishlist = await db.query(
      `SELECT w.*, 
              COALESCE(pc.price, sc.price, 0.15) as price,
              COALESCE(pc.type_line, sc.type_line, 'Card') as type_line,
              COALESCE(pc.oracle_text, sc.oracle_text, '') as oracle_text,
              COALESCE(w.scryfall_id, sc.scryfall_id) as scryfall_id
       FROM wishlist_cards w
       LEFT JOIN card_price_cache pc ON w.card_name = pc.card_name
       LEFT JOIN scryfall_cards sc ON w.card_name = sc.card_name
       WHERE w.player_id = ?
       ORDER BY w.card_name ASC`,
      [playerId]
    );
    res.json({ success: true, wishlist });
  } catch (e) {
    console.error("Failed to load wishlist:", e);
    res.status(500).json({ error: e.message });
  }
});

// ADD card to wishlist
app.post('/api/wishlist', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { cardName, scryfallId, quantity } = req.body;
  if (!cardName) return res.status(400).json({ error: "Card name is required." });
  try {
    const qty = quantity || 1;
    let resolvedScryfallId = scryfallId || null;
    if (!resolvedScryfallId) {
      const match = await db.get("SELECT scryfall_id FROM scryfall_cards WHERE card_name = ? COLLATE NOCASE", [cardName]);
      if (match) resolvedScryfallId = match.scryfall_id;
    }
    await db.run(
      `INSERT INTO wishlist_cards (player_id, card_name, scryfall_id, quantity)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id, card_name, scryfall_id)
       DO UPDATE SET quantity = quantity + EXCLUDED.quantity`,
      [playerId, cardName, resolvedScryfallId, qty]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Failed to add to wishlist:", e);
    res.status(500).json({ error: e.message });
  }
});

// REMOVE card from wishlist
app.delete('/api/wishlist/:cardName', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { cardName } = req.params;
  try {
    await db.run(
      "DELETE FROM wishlist_cards WHERE player_id = ? AND card_name = ? COLLATE NOCASE",
      [playerId, cardName]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Failed to delete from wishlist:", e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// DELETED ITEMS RECOVERY (RECYCLE BIN) API
// ==========================================

// GET all deleted items for a player
app.get('/api/recovery/deleted-items', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  try {
    const items = await db.query(
      "SELECT id, item_type, item_id, name, deleted_at FROM deleted_items WHERE player_id = ? ORDER BY deleted_at DESC",
      [playerId]
    );
    res.json({ success: true, items });
  } catch (e) {
    console.error("Failed to load deleted items:", e);
    res.status(500).json({ error: e.message });
  }
});

// POST to restore a deleted item
app.post('/api/recovery/restore/:id', async (req, res) => {
  if (!req.session.player) return res.status(401).json({ error: "Please log in first." });
  const playerId = req.session.player.id;
  const { id } = req.params;
  try {
    const row = await db.get("SELECT * FROM deleted_items WHERE id = ? AND player_id = ?", [id, playerId]);
    if (!row) return res.status(404).json({ error: "Deleted item not found." });

    const payload = JSON.parse(row.data);
    if (row.item_type === 'collection') {
      const { collection, cards } = payload;
      // Insert collection metadata
      await db.run(
        "INSERT INTO collections (id, player_id, name, settings, created_at) VALUES (?, ?, ?, ?, ?)",
        [collection.id, playerId, collection.name, collection.settings, collection.created_at]
      );
      // Insert cards
      for (let c of cards) {
        await db.run(
          `INSERT INTO collection_cards 
           (collection_id, card_name, scryfall_id, quantity, is_foil, is_for_trade, condition, language, purchase_price, added_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [c.collection_id, c.card_name, c.scryfall_id, c.quantity, c.is_foil, c.is_for_trade, c.condition, c.language, c.purchase_price, c.added_at]
        );
      }
    } else if (row.item_type === 'deck') {
      const { deck, cards } = payload;
      // Insert deck metadata
      await db.run(
        `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, last_checked, is_legal, keep_cheapest) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [deck.id, playerId, deck.moxfield_url, deck.deck_name, deck.cheapest_total_price, deck.last_checked, deck.is_legal, deck.keep_cheapest]
      );
      // Insert cards
      for (let c of cards) {
        await db.run(
          "INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag) VALUES (?, ?, ?, ?, ?, ?)",
          [c.deck_id, c.card_name, c.cheapest_card_price, c.quantity, c.scryfall_id, c.custom_tag]
        );
      }
    }

    await db.run("DELETE FROM deleted_items WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (e) {
    console.error("Failed to restore item:", e);
    res.status(500).json({ error: e.message });
  }
});

// Serving Client SPA Router
app.get('*', (req, res) => {
  const reactIndexPath = path.join(__dirname, 'web', 'dist', 'index.html');
  if (fs.existsSync(reactIndexPath)) {
    res.sendFile(reactIndexPath);
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

function checkDailyResetCron() {
  const now = new Date();
  const cdtString = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const cdtDate = new Date(cdtString);
  
  const hour = cdtDate.getHours();
  const minutes = cdtDate.getMinutes();
  const dateStr = cdtDate.getFullYear() + '-' + (cdtDate.getMonth() + 1) + '-' + cdtDate.getDate();

  if (hour === 6 && minutes === 0 && lastDailyResetDate !== dateStr) {
    lastDailyResetDate = dateStr;
    console.log(`[Cron] Executing daily 6AM CDT reset loop for date: ${dateStr}`);
    dailyResetAndCheapestUpdate().catch(err => {
      console.error("[Cron] Daily reset execution error:", err);
    });
  }
}

// Poll once every 30 seconds
setInterval(checkDailyResetCron, 30000);

// Start Server
db.initDb().then(() => {
  console.log("Database initialized successfully.");
  app.listen(PORT, () => {
    console.log(`Grimore Server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Database initialization warning:", err);
  app.listen(PORT, () => {
    console.log(`Grimore Server running on http://localhost:${PORT}`);
  });
});
