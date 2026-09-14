# Grimore — API Reference

HTTP API served by `server.js`. Auth is a session cookie (set by the auth routes). "Auth" below
means a logged-in session is required; "Admin" means `role: admin`; "Public" means no session needed.
Realtime multiplayer uses Socket.IO (see `multiplayer.js`), not these HTTP routes.

## Health
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health`, `/api/health` | Public | Liveness — `{status:"ok",uptime}`. |

## Auth & account
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/register` | Public | Create an account (min 8-char password). |
| POST | `/api/auth/login` | Public | Log in (does NOT auto-create accounts). |
| POST | `/api/auth/guest` | Public | Guest session. |
| POST | `/api/auth/google` | Public | Google sign-in — verified ID-token `credential` OR OAuth `accessToken` (server-verified; never a client-supplied email). |
| POST | `/api/auth/logout` | Auth | Destroy session. |
| GET | `/api/auth/me`, `/api/auth/status` | Public | Current session / login status + `googleClientId`. |
| POST | `/api/auth/forgot-password` | Public | Generates a reset token (delivered via email; the dev link is only exposed outside production). |
| POST | `/api/auth/reset-password` | Public | Complete a password reset with a valid token. |
| POST | `/api/players/account/update` | Auth | Update credentials (current password required for changes). |
| POST | `/api/players/profile/update` | Auth | Update profile (nickname/avatar/commander/bio). |
| GET | `/api/players/:playerId/profile` | Public | Public profile (no email exposed). |
| GET | `/api/players/list` | Admin | All players. |
| POST | `/api/players/:playerId/role` | Admin | Set a player's role. |

## Cards (Scryfall-backed)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/cards/search` | Public | Card search (`q=`), returns cards with image + price. |
| GET | `/api/cards/autocomplete` | Public | Name autocomplete. |
| GET | `/api/cards/details` / POST `/api/cards/details-batch` | Public | Card detail(s). |
| GET | `/api/cards/versions` | Public | Printings of a card. |
| GET | `/api/cards/rulings` | Public | Rulings for a card. |
| GET | `/api/cards/recommendations` | Public | Recommendation candidates for a deck. |
| POST | `/api/cards/swipes`, `/api/cards/versions/:scryfallId/vote` | Auth | Swipe/art preferences. |

## Decks
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/decks`, `/api/decks/my-decks` | Auth | The user's decks. |
| GET | `/api/decks/discover`, `/api/decks/public` | Public | Community/discover feed. |
| GET | `/api/decks/:deckId`, `/:deckId/cards`, `/:deckId/social`, `/:deckId/suggestions` | Mixed | Deck detail/cards/social/suggestions. |
| POST | `/api/decks/builder-save` | Auth | Save the deck builder state (guarded against blank-overwrite). |
| POST | `/api/decks/register`, `/import-account`, `/moxfield/import-account` | Auth | Import decks (Moxfield). |
| POST | `/api/decks/:deckId/cards`, `/comment`, `/like`, `/clone`, `/share`, `/tags`, `/autotag` | Auth | Deck mutations (ownership-scoped where applicable). |
| GET/POST | `/api/decks/reprice-init/:deckId`, `/reprice-card`, `/reprice-finalize/:deckId`, `/:deckId/reprice-card-cheapest`, `/:deckId/reload-cheapest` | Auth + ownership | Re-price a deck (ownership-scoped — verified `WHERE id=? AND player_id=?`). |
| DELETE | `/api/decks/:deckId` | Auth + ownership | Soft-delete (recoverable via Recycle Bin). |

## Collections & wishlist
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET/POST | `/api/collections`, `/api/collections/:id/cards` | Auth | Collections + cards. |
| DELETE | `/api/collections/:id`, `/api/collections/:id/cards` | Auth | Remove collection/cards. |
| GET/DELETE | `/api/wishlist`, `/api/wishlist/:cardName` | Auth | Wishlist. |

## Social
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/friends`, `/friends/requests`, `/friends/status/:playerId` | Auth | Friends + requests. |
| POST | `/api/friends/request/:playerId`, `/accept/:requestId`, `/decline/:requestId` | Auth | Friend flow. |
| DELETE | `/api/friends/:playerId` | Auth | Unfriend. |
| POST | `/api/players/:playerId/follow`, GET `/:playerId/following`, `/api/artists/follow`, `/api/artists/followed` | Auth | Follow players/artists. |
| GET/POST | `/api/messages/inbox`, `/sent`, `/unread-count`, `/send`, `/:id/read`, `/feedback` | Auth | Direct messages. |
| GET/POST | `/api/notifications`, `/api/notifications/read` | Auth | Notifications. |

## Play Realm (sandbox) & drafting
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/sandbox/ai-advisor` | Auth + premium-gated¹ | Gemini rules advisor (rate-limited). |
| GET | `/api/sandbox/ai-meta-decks`, `/replays`, `/replays/:replayId`, `/room/:code` | Mixed | Sandbox data. |
| POST/GET | `/api/draft/create`, `/:draftId`, `/:draftId/pick` | Auth | Booster draft. |

¹ `premiumGate` is a pass-through unless `PREMIUM_GATING=on` — see Billing.

## Tournaments / seasons / roster
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/seasons`, `/seasons/active`, `/:seasonId/matrix`, `/:seasonId/meta` | Mixed | Seasons. |
| GET/POST | `/api/roster/*`, `/api/pairings/*` | Auth/Admin | Roster check-in + pairings/rounds/reports. |
| GET | `/api/leaderboards/decks`, `/leaderboards/season`, `/api/movers` | Public | Leaderboards + price movers. |

## Billing (premium — flag-dark; see billing.js)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/billing/status` | Auth | Current user's premium status + free-deck limit. |
| POST | `/api/billing/create-checkout-session` | Auth | Start a Stripe Checkout (test mode); `billing_unavailable` if not configured. |
| GET | `/api/billing/portal` | Auth | Stripe billing portal link. |
| POST | `/api/billing/webhook` | Stripe (signed) | Subscription lifecycle (raw body, signature-verified, idempotent). |

## Admin / dev
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST/GET | `/api/admin/sync-mtgjson`, `/sync-mtgjson/status` | Admin | MTGJSON import. |
| * | `/api/dev/git-*`, `/changes` | Local-dev only | Internal command center (guarded; blocked in production). |

> This reference is generated from the route table in `server.js`; parameter/response shapes live
> with each handler. Keep it in sync when adding routes.
