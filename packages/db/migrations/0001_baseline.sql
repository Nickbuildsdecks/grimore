
CREATE TABLE public.artist_follows (
    player_id text NOT NULL,
    artist_key text NOT NULL,
    artist_name text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.billing_events (
    id integer NOT NULL,
    stripe_event_id text NOT NULL,
    type text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.billing_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.billing_events_id_seq OWNED BY public.billing_events.id;

CREATE TABLE public.card_art_votes (
    player_id text NOT NULL,
    scryfall_id text NOT NULL,
    card_name text NOT NULL,
    artist text,
    vote integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT card_art_votes_vote_check CHECK ((vote = ANY (ARRAY['-1'::integer, 1])))
);

CREATE TABLE public.card_price_cache (
    id integer NOT NULL,
    scryfall_id text,
    card_name text NOT NULL,
    set_code text DEFAULT 'unk'::text,
    collector_number text DEFAULT '1'::text,
    price real NOT NULL,
    foil_price real,
    image_uri text,
    scryfall_uri text,
    type_line text,
    mana_cost text,
    cmc real,
    rarity text,
    cached_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.card_price_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.card_price_cache_id_seq OWNED BY public.card_price_cache.id;

CREATE TABLE public.card_swipes (
    player_id text NOT NULL,
    card_key text NOT NULL,
    card_name text NOT NULL,
    scryfall_id text,
    context_key text DEFAULT 'explore'::text NOT NULL,
    vote integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT card_swipes_vote_check CHECK ((vote = ANY (ARRAY['-1'::integer, 1])))
);

CREATE TABLE public.collection_cards (
    id integer NOT NULL,
    collection_id integer NOT NULL,
    card_name text NOT NULL,
    quantity integer DEFAULT 1,
    set_code text,
    collector_number text,
    scryfall_id text,
    foil integer DEFAULT 0,
    purchase_price real DEFAULT 0.0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.collection_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.collection_cards_id_seq OWNED BY public.collection_cards.id;

CREATE TABLE public.collections (
    id integer NOT NULL,
    player_id text NOT NULL,
    name text NOT NULL,
    description text,
    is_public integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.collections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.collections_id_seq OWNED BY public.collections.id;

CREATE TABLE public.deck_cards (
    id integer NOT NULL,
    deck_id text NOT NULL,
    card_name text NOT NULL,
    quantity integer DEFAULT 1,
    purchase_price real DEFAULT 0.0,
    cheapest_price real DEFAULT 0.0,
    cheapest_card_price real DEFAULT 0.0,
    set_code text,
    collector_number text,
    is_commander integer DEFAULT 0,
    is_partner integer DEFAULT 0,
    scryfall_id text,
    manual_target_price real,
    keep_cheapest integer DEFAULT 0,
    mana_cost text,
    cmc real DEFAULT 0,
    type_line text,
    rarity text,
    image_uris text,
    custom_tag text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.deck_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deck_cards_id_seq OWNED BY public.deck_cards.id;

CREATE TABLE public.deck_comments (
    id integer NOT NULL,
    deck_id text NOT NULL,
    player_id text NOT NULL,
    comment_text text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.deck_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deck_comments_id_seq OWNED BY public.deck_comments.id;

CREATE TABLE public.deck_likes (
    id integer NOT NULL,
    deck_id text NOT NULL,
    player_id text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.deck_likes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deck_likes_id_seq OWNED BY public.deck_likes.id;

CREATE TABLE public.deck_stats (
    deck_id text NOT NULL,
    total_wins integer DEFAULT 0,
    total_kills integer DEFAULT 0,
    total_points integer DEFAULT 0,
    total_matches integer DEFAULT 0,
    games_played integer DEFAULT 0,
    win_rate real DEFAULT 0.0,
    season_id text
);

CREATE TABLE public.decks (
    id text NOT NULL,
    player_id text NOT NULL,
    moxfield_url text NOT NULL,
    deck_name text NOT NULL,
    cheapest_total_price real DEFAULT 0,
    last_checked timestamp without time zone,
    is_legal integer DEFAULT 1,
    keep_cheapest integer DEFAULT 0,
    is_public integer DEFAULT 0,
    custom_tags text,
    featured_card_name text,
    format text DEFAULT 'commander'::text,
    cloned_from_deck_id text,
    original_creator_name text,
    legality_reason text,
    likes_count integer DEFAULT 0
);

CREATE TABLE public.followed_artist_printings (
    card_name text NOT NULL,
    scryfall_id text NOT NULL,
    artist_key text NOT NULL,
    artist_name text NOT NULL,
    image_uri text NOT NULL,
    set_name text DEFAULT ''::text,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.follows (
    id integer NOT NULL,
    follower_id text NOT NULL,
    following_id text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.follows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.follows_id_seq OWNED BY public.follows.id;

CREATE TABLE public.match_reports (
    id integer NOT NULL,
    match_id text NOT NULL,
    reporter_id text NOT NULL,
    winner_id text,
    kills_json text,
    submitted_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.match_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.match_reports_id_seq OWNED BY public.match_reports.id;

CREATE TABLE public.matches (
    id text NOT NULL,
    tournament_id text NOT NULL,
    round_number integer NOT NULL,
    pod_number integer NOT NULL,
    player1_id text,
    player2_id text,
    player3_id text,
    player4_id text,
    winner_id text,
    is_draw integer DEFAULT 0,
    status text DEFAULT 'pending'::text,
    scores_submitted integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.messages (
    id text NOT NULL,
    sender_id text,
    recipient_id text,
    subject text NOT NULL,
    body text NOT NULL,
    is_read integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.notifications (
    id integer NOT NULL,
    player_id text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    link_url text,
    is_read integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;

CREATE TABLE public.player_collection (
    id integer NOT NULL,
    player_id text NOT NULL,
    card_name text NOT NULL,
    quantity integer DEFAULT 1,
    set_code text,
    collector_number text,
    scryfall_id text,
    foil integer DEFAULT 0,
    purchase_price real DEFAULT 0.0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.player_collection_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.player_collection_id_seq OWNED BY public.player_collection.id;

CREATE TABLE public.player_stats (
    player_id text NOT NULL,
    total_games integer DEFAULT 0,
    total_wins integer DEFAULT 0,
    total_kills integer DEFAULT 0,
    total_points integer DEFAULT 0,
    win_rate real DEFAULT 0.0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.players (
    id text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    store_nickname text NOT NULL,
    is_admin integer DEFAULT 0,
    email text,
    google_id text,
    role text DEFAULT 'player'::text,
    avatar_url text,
    profile_commander text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    profile_bio text,
    premium_status text DEFAULT 'free'::text,
    stripe_customer_id text,
    stripe_subscription_id text,
    premium_until timestamp without time zone
);

CREATE TABLE public.preference_events (
    id bigint NOT NULL,
    player_id text NOT NULL,
    event_type text NOT NULL,
    entity_type text NOT NULL,
    entity_key text NOT NULL,
    source text DEFAULT 'app'::text NOT NULL,
    signal real DEFAULT 0,
    context_json text,
    occurrences integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_seen_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.preference_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.preference_events_id_seq OWNED BY public.preference_events.id;

CREATE TABLE public.price_overrides (
    id integer NOT NULL,
    card_name text NOT NULL,
    price real NOT NULL,
    notes text,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.price_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.price_overrides_id_seq OWNED BY public.price_overrides.id;

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.scryfall_card_tags (
    card_name text NOT NULL,
    tags text,
    last_updated timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.scryfall_cards (
    id text NOT NULL,
    name text NOT NULL,
    set_code text DEFAULT 'unk'::text,
    set_name text,
    collector_number text DEFAULT '1'::text,
    rarity text,
    price real,
    foil_price real,
    image_uri text,
    scryfall_uri text,
    type_line text,
    mana_cost text,
    cmc real,
    oracle_text text,
    colors text,
    color_identity text,
    legalities text,
    edhrec_rank integer,
    keywords text,
    card_faces text,
    last_updated timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    card_name text
);

CREATE TABLE public.seasons (
    id text NOT NULL,
    name text NOT NULL,
    points_entry integer DEFAULT 1,
    points_kill integer DEFAULT 1,
    points_win integer DEFAULT 2,
    points_draw integer DEFAULT 1,
    remainder_pref text DEFAULT '3'::text,
    use_point_pairing integer DEFAULT 1,
    checkin_enabled integer DEFAULT 1,
    is_active integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    schedule_mode text
);

CREATE TABLE public.tournament_players (
    tournament_id text NOT NULL,
    player_id text NOT NULL,
    deck_id text,
    registered_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_checked_in integer DEFAULT 0,
    dropped integer DEFAULT 0,
    score integer DEFAULT 0,
    wins integer DEFAULT 0,
    draws integer DEFAULT 0,
    losses integer DEFAULT 0,
    kills integer DEFAULT 0
);

CREATE TABLE public.tournament_rounds (
    id integer NOT NULL,
    tournament_id text NOT NULL,
    round_number integer NOT NULL,
    status text DEFAULT 'in_progress'::text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.tournament_rounds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tournament_rounds_id_seq OWNED BY public.tournament_rounds.id;

CREATE TABLE public.tournaments (
    id text NOT NULL,
    season_id text,
    name text NOT NULL,
    date timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    format text DEFAULT 'commander'::text,
    status text DEFAULT 'setup'::text,
    current_round integer DEFAULT 0,
    pairing_strategy text DEFAULT 'swiss'::text,
    deck_lock integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ONLY public.billing_events ALTER COLUMN id SET DEFAULT nextval('public.billing_events_id_seq'::regclass);

ALTER TABLE ONLY public.card_price_cache ALTER COLUMN id SET DEFAULT nextval('public.card_price_cache_id_seq'::regclass);

ALTER TABLE ONLY public.collection_cards ALTER COLUMN id SET DEFAULT nextval('public.collection_cards_id_seq'::regclass);

ALTER TABLE ONLY public.collections ALTER COLUMN id SET DEFAULT nextval('public.collections_id_seq'::regclass);

ALTER TABLE ONLY public.deck_cards ALTER COLUMN id SET DEFAULT nextval('public.deck_cards_id_seq'::regclass);

ALTER TABLE ONLY public.deck_comments ALTER COLUMN id SET DEFAULT nextval('public.deck_comments_id_seq'::regclass);

ALTER TABLE ONLY public.deck_likes ALTER COLUMN id SET DEFAULT nextval('public.deck_likes_id_seq'::regclass);

ALTER TABLE ONLY public.follows ALTER COLUMN id SET DEFAULT nextval('public.follows_id_seq'::regclass);

ALTER TABLE ONLY public.match_reports ALTER COLUMN id SET DEFAULT nextval('public.match_reports_id_seq'::regclass);

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);

ALTER TABLE ONLY public.player_collection ALTER COLUMN id SET DEFAULT nextval('public.player_collection_id_seq'::regclass);

ALTER TABLE ONLY public.preference_events ALTER COLUMN id SET DEFAULT nextval('public.preference_events_id_seq'::regclass);

ALTER TABLE ONLY public.price_overrides ALTER COLUMN id SET DEFAULT nextval('public.price_overrides_id_seq'::regclass);

ALTER TABLE ONLY public.tournament_rounds ALTER COLUMN id SET DEFAULT nextval('public.tournament_rounds_id_seq'::regclass);

ALTER TABLE ONLY public.artist_follows
    ADD CONSTRAINT artist_follows_pkey PRIMARY KEY (player_id, artist_key);

ALTER TABLE ONLY public.billing_events
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.billing_events
    ADD CONSTRAINT billing_events_stripe_event_id_key UNIQUE (stripe_event_id);

ALTER TABLE ONLY public.card_art_votes
    ADD CONSTRAINT card_art_votes_pkey PRIMARY KEY (player_id, scryfall_id);

ALTER TABLE ONLY public.card_price_cache
    ADD CONSTRAINT card_price_cache_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.card_swipes
    ADD CONSTRAINT card_swipes_pkey PRIMARY KEY (player_id, card_key, context_key);

ALTER TABLE ONLY public.collection_cards
    ADD CONSTRAINT collection_cards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deck_cards
    ADD CONSTRAINT deck_cards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deck_comments
    ADD CONSTRAINT deck_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deck_likes
    ADD CONSTRAINT deck_likes_deck_id_player_id_key UNIQUE (deck_id, player_id);

ALTER TABLE ONLY public.deck_likes
    ADD CONSTRAINT deck_likes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deck_stats
    ADD CONSTRAINT deck_stats_pkey PRIMARY KEY (deck_id);

ALTER TABLE ONLY public.decks
    ADD CONSTRAINT decks_moxfield_url_key UNIQUE (moxfield_url);

ALTER TABLE ONLY public.decks
    ADD CONSTRAINT decks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.followed_artist_printings
    ADD CONSTRAINT followed_artist_printings_pkey PRIMARY KEY (card_name, scryfall_id);

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_following_id_key UNIQUE (follower_id, following_id);

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.match_reports
    ADD CONSTRAINT match_reports_match_id_reporter_id_key UNIQUE (match_id, reporter_id);

ALTER TABLE ONLY public.match_reports
    ADD CONSTRAINT match_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.player_collection
    ADD CONSTRAINT player_collection_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.player_collection
    ADD CONSTRAINT player_collection_player_id_card_name_set_code_collector_nu_key UNIQUE (player_id, card_name, set_code, collector_number, foil);

ALTER TABLE ONLY public.player_stats
    ADD CONSTRAINT player_stats_pkey PRIMARY KEY (player_id);

ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_google_id_key UNIQUE (google_id);

ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_username_key UNIQUE (username);

ALTER TABLE ONLY public.preference_events
    ADD CONSTRAINT preference_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.preference_events
    ADD CONSTRAINT preference_events_player_id_entity_type_entity_key_source_key UNIQUE (player_id, entity_type, entity_key, source);

ALTER TABLE ONLY public.price_overrides
    ADD CONSTRAINT price_overrides_card_name_key UNIQUE (card_name);

ALTER TABLE ONLY public.price_overrides
    ADD CONSTRAINT price_overrides_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.scryfall_card_tags
    ADD CONSTRAINT scryfall_card_tags_pkey PRIMARY KEY (card_name);

ALTER TABLE ONLY public.scryfall_cards
    ADD CONSTRAINT scryfall_cards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT seasons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tournament_players
    ADD CONSTRAINT tournament_players_pkey PRIMARY KEY (tournament_id, player_id);

ALTER TABLE ONLY public.tournament_rounds
    ADD CONSTRAINT tournament_rounds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tournaments
    ADD CONSTRAINT tournaments_pkey PRIMARY KEY (id);

CREATE INDEX idx_card_price_cache_lower_card_name ON public.card_price_cache USING btree (lower(card_name));

CREATE INDEX idx_card_swipes_player ON public.card_swipes USING btree (player_id, updated_at DESC);

CREATE INDEX idx_deck_cards_commander ON public.deck_cards USING btree (deck_id, is_commander);

CREATE INDEX idx_deck_cards_deck_id ON public.deck_cards USING btree (deck_id);

CREATE INDEX idx_deck_comments_deck ON public.deck_comments USING btree (deck_id);

CREATE INDEX idx_deck_likes_deck_player ON public.deck_likes USING btree (deck_id, player_id);

CREATE INDEX idx_decks_player ON public.decks USING btree (player_id);

CREATE INDEX idx_players_stripe_customer ON public.players USING btree (stripe_customer_id);

CREATE INDEX idx_preference_events_player ON public.preference_events USING btree (player_id, last_seen_at DESC);

CREATE INDEX idx_scryfall_cards_card_name ON public.scryfall_cards USING btree (card_name);

CREATE INDEX idx_scryfall_cards_lower_card_name ON public.scryfall_cards USING btree (lower(card_name));

CREATE INDEX idx_scryfall_cards_lower_name ON public.scryfall_cards USING btree (lower(name));

ALTER TABLE ONLY public.artist_follows
    ADD CONSTRAINT artist_follows_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.card_art_votes
    ADD CONSTRAINT card_art_votes_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.card_swipes
    ADD CONSTRAINT card_swipes_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.collection_cards
    ADD CONSTRAINT collection_cards_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deck_cards
    ADD CONSTRAINT deck_cards_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deck_comments
    ADD CONSTRAINT deck_comments_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deck_comments
    ADD CONSTRAINT deck_comments_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deck_likes
    ADD CONSTRAINT deck_likes_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deck_likes
    ADD CONSTRAINT deck_likes_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deck_stats
    ADD CONSTRAINT deck_stats_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id);

ALTER TABLE ONLY public.decks
    ADD CONSTRAINT decks_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.match_reports
    ADD CONSTRAINT match_reports_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.match_reports
    ADD CONSTRAINT match_reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.match_reports
    ADD CONSTRAINT match_reports_winner_id_fkey FOREIGN KEY (winner_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_player1_id_fkey FOREIGN KEY (player1_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_player2_id_fkey FOREIGN KEY (player2_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_player3_id_fkey FOREIGN KEY (player3_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_player4_id_fkey FOREIGN KEY (player4_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_winner_id_fkey FOREIGN KEY (winner_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.players(id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.player_collection
    ADD CONSTRAINT player_collection_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.player_stats
    ADD CONSTRAINT player_stats_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.preference_events
    ADD CONSTRAINT preference_events_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tournament_players
    ADD CONSTRAINT tournament_players_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id);

ALTER TABLE ONLY public.tournament_players
    ADD CONSTRAINT tournament_players_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tournament_players
    ADD CONSTRAINT tournament_players_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tournament_rounds
    ADD CONSTRAINT tournament_rounds_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tournaments
    ADD CONSTRAINT tournaments_season_id_fkey FOREIGN KEY (season_id) REFERENCES public.seasons(id);

