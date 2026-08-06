# 📱 Grimore Mobile Developer Guide & API Reference

Welcome to the **Grimore MTG Platform** mobile developer guide! This document provides everything you need to build, test, and integrate mobile clients (React Native, iOS, Android, or PWA) against the Grimore API.

> [!IMPORTANT]
> **Privacy & Security**: Never request or share personal user credentials or production passwords. When developing locally, register your own developer account via the sign-up flow or use the local registration API (`POST /api/auth/register`).

---

## 🛠️ 1. Quick Start & Local Setup

### 1. Requirements
- Node.js v20+ installed.
- Git.

### 2. Running the Server Locally
1. Clone the repository:
   ```bash
   git clone https://github.com/Nickbuildsdecks/grimore.git
   cd grimore
   ```
2. Install dependencies:
   ```bash
   npm install
   npm --prefix web install
   ```
3. Start local development server:
   ```bash
   npm start
   ```
   The backend API will run on `http://localhost:3000` (or `http://<YOUR_LOCAL_IP>:3000` for physical mobile devices on the same Wi-Fi network).

---

## 🔒 2. Developer Account Setup

Do **not** use owner or production credentials. Create your own isolated local account:

1. Open `http://localhost:3000` in your browser.
2. Click **Register** to create a fresh local account (e.g. username `mobile_dev`).
3. You can now log in via the app or via the API using your own local account credentials.

---

## 📡 3. Core REST API Reference

All requests accept and return standard `application/json`. Authentication is handled via session cookies or session headers.

### Authentication Endpoints

#### Register Local Account
- **`POST /api/auth/register`**
  - **Body**: `{ "username": "dev_user", "password": "your_local_password", "storeNickname": "DevUser" }`
  - **Response**: `{ "success": true, "player": { "id": "...", "username": "dev_user" } }`

#### Login
- **`POST /api/auth/login`**
  - **Body**: `{ "username": "dev_user", "password": "your_local_password" }`
  - **Response**: `{ "success": true, "user": { "id": "...", "username": "dev_user" } }`

#### Get Current Session User
- **`GET /api/auth/me`**
  - **Response**: `{ "loggedIn": true, "user": { "id": "...", "username": "dev_user" } }`

---

### Decks & Builder Endpoints

#### Discover Public Decks (Community Feed)
- **`GET /api/decks/discover`**
  - **Response**: Array of public deck objects with commander images, total prices, and stats.

#### Get My Decks (Requires Login)
- **`GET /api/decks/my-decks`**
  - **Response**: Array of decks owned by the logged-in session user.

#### Get Single Deck Details
- **`GET /api/decks/:deckId`**
  - **Response**: `{ "id": "...", "deck_name": "...", "format": "commander", "cheapest_total_price": 45.20 }`

#### Get Deck Card List
- **`GET /api/decks/:deckId/cards`**
  - **Response**: Array of card objects (`card_name`, `quantity`, `is_commander`, `custom_tag`, `cheapest_card_price`, `scryfall_id`).

#### Save / Update Deck (Builder)
- **`POST /api/decks/builder-save`**
  - **Body**:
    ```json
    {
      "deckId": "d_123456",
      "deckName": "My Commander Deck",
      "commanderCards": [{ "name": "Muldrotha, the Gravetide", "qty": 1, "scryfallId": "..." }],
      "mainboardCards": [{ "name": "Sol Ring", "qty": 1, "scryfallId": "..." }],
      "isPublic": 1,
      "format": "commander"
    }
    ```

---

### Card Search & Scryfall Integration

#### Instant Card Search (Pre-Warmed Cache)
- **`GET /api/cards/search?q=Sol+Ring&page=1&limit=12`**
  - **Response**: `{ "cards": [{ "name": "Sol Ring", "cmc": 1, "type_line": "Artifact", "price": 1.25, "scryfallId": "..." }] }`

---

### Recommendation & Taste Signals Engine

#### Get Card Recommendations for a Deck
- **`GET /api/recommendations?deckId=d_123456`**
  - **Response**: Candidate list of recommended synergy cards filtered by format color identity.

---

## 🖼️ 4. Image & Bandwidth Optimization

To save mobile network bandwidth, use standard Scryfall image URIs based on the card's `scryfallId`:

- **Small Thumbnail**: `https://cards.scryfall.io/small/front/<id[0]>/<id[1]>/<id>.jpg`
- **Normal Card**: `https://cards.scryfall.io/normal/front/<id[0]>/<id[1]>/<id>.jpg`
- **Art Crop**: `https://cards.scryfall.io/art_crop/front/<id[0]>/<id[1]>/<id>.jpg`

---

## 🎨 5. Mobile UI & Touch Target Guidelines

- **Minimum Tap Target**: All interactive controls, pills, and buttons must be at least **44px $\times$ 44px**.
- **Responsive Layout**: Single-column vertical stacking on screen widths $< 768\text{px}$.
