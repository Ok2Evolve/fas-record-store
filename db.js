import Database from "better-sqlite3";
const db = new Database("fas.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'fan',      -- 'fan' or 'artist'
    stripe_account_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    genre TEXT NOT NULL,
    subgenre TEXT,
    year INTEGER,
    description TEXT,
    cover_path TEXT,
    type TEXT NOT NULL DEFAULT 'album',    -- 'album' or 'single'
    price REAL NOT NULL DEFAULT 8.00,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (artist_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id INTEGER NOT NULL,
    track_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    audio_path TEXT NOT NULL,
    preview_path TEXT,
    price REAL NOT NULL DEFAULT 1.00,
    FOREIGN KEY (release_id) REFERENCES releases(id)
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id INTEGER NOT NULL,
    release_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    stripe_session_id TEXT,
    download_token TEXT NOT NULL,
    download_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (buyer_id) REFERENCES users(id),
    FOREIGN KEY (release_id) REFERENCES releases(id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    artist_id INTEGER NOT NULL,
    PRIMARY KEY (follower_id, artist_id)
  );
`);

export default db;