import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import Stripe from "stripe";
import { nanoid } from "nanoid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import "dotenv/config";
import db from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET || "sk_test_dummy");

// --- Setup folders
const UPLOAD_DIR = path.join(__dirname, "uploads");
const COVER_DIR = path.join(UPLOAD_DIR, "covers");
const AUDIO_DIR = path.join(UPLOAD_DIR, "audio");
[UPLOAD_DIR, COVER_DIR, AUDIO_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// --- Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads/covers", express.static(COVER_DIR));

// --- Multer storage
const coverUpload = multer({
  storage: multer.diskStorage({
    destination: COVER_DIR,
    filename: (req, file, cb) => cb(null, nanoid() + path.extname(file.originalname))
  }),
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB covers
});

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (req, file, cb) => cb(null, nanoid() + path.extname(file.originalname))
  }),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB per audio file
});

// --- Auth helpers
const signToken = (userId) =>
  jwt.sign({ uid: userId }, process.env.JWT_SECRET || "dev-secret", { expiresIn: "30d" });

const authRequired = (req, res, next) => {
  const token = req.cookies.fas_token;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    const { uid } = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    req.userId = uid;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};

const getCurrentUser = (id) => db.prepare("SELECT id, email, display_name, role FROM users WHERE id = ?").get(id);

// =========================================================
// AUTH ROUTES
// =========================================================
app.post("/api/signup", (req, res) => {
  const { email, password, display_name, role } = req.body;
  if (!email || !password || !display_name) return res.status(400).json({ error: "Missing fields" });
  if (password.length < 6) return res.status(400).json({ error: "Password too short" });

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "Email already registered" });

  const hash = bcrypt.hashSync(password, 10);
  const safeRole = role === "artist" ? "artist" : "fan";
  const info = db.prepare(
    "INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)"
  ).run(email, hash, display_name, safeRole);

  const token = signToken(info.lastInsertRowid);
  res.cookie("fas_token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: getCurrentUser(info.lastInsertRowid) });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken(user.id);
  res.cookie("fas_token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: getCurrentUser(user.id) });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("fas_token");
  res.json({ ok: true });
});

app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: getCurrentUser(req.userId) });
});

// =========================================================
// CATALOG ROUTES
// =========================================================
app.get("/api/releases", (req, res) => {
  const { genre, letter, q, artist_id, sort } = req.query;
  let sql = `
    SELECT r.*, u.display_name AS artist_name
    FROM releases r JOIN users u ON u.id = r.artist_id
    WHERE 1=1
  `;
  const params = [];
  if (genre && genre !== "all") { sql += " AND r.genre = ?"; params.push(genre); }
  if (artist_id) { sql += " AND r.artist_id = ?"; params.push(artist_id); }
  if (letter && letter !== "all") {
    if (letter === "#") sql += " AND u.display_name NOT GLOB '[A-Za-z]*'";
    else { sql += " AND UPPER(SUBSTR(u.display_name, 1, 1)) = ?"; params.push(letter); }
  }
  if (q) {
    sql += " AND (r.title LIKE ? OR u.display_name LIKE ?)";
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += sort === "new" ? " ORDER BY r.created_at DESC" : " ORDER BY u.display_name, r.title";

  const releases = db.prepare(sql).all(...params);

  // Attach tracks
  const trackStmt = db.prepare("SELECT id, track_number, title, price FROM tracks WHERE release_id = ? ORDER BY track_number");
  releases.forEach(r => { r.tracks = trackStmt.all(r.id); });

  res.json({ releases });
});

app.get("/api/releases/:id", (req, res) => {
  const release = db.prepare(`
    SELECT r.*, u.display_name AS artist_name, u.id AS artist_id
    FROM releases r JOIN users u ON u.id = r.artist_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!release) return res.status(404).json({ error: "Not found" });
  release.tracks = db.prepare("SELECT * FROM tracks WHERE release_id = ? ORDER BY track_number").all(release.id);
  res.json({ release });
});

app.get("/api/genres", (req, res) => {
  const genres = db.prepare("SELECT DISTINCT genre FROM releases ORDER BY genre").all().map(r => r.genre);
  res.json({ genres });
});

// =========================================================
// ARTIST: UPLOAD RELEASE
// =========================================================
const releaseUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (file.fieldname === "cover") cb(null, COVER_DIR);
      else cb(null, AUDIO_DIR);
    },
    filename: (req, file, cb) => cb(null, nanoid() + path.extname(file.originalname))
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.post(
  "/api/artist/releases",
  authRequired,
  (req, res, next) => {
    const user = getCurrentUser(req.userId);
    if (user.role !== "artist") return res.status(403).json({ error: "Artists only" });
    next();
  },
  releaseUpload.fields([
    { name: "cover", maxCount: 1 },
    { name: "audio", maxCount: 30 }
  ]),
  (req, res) => {
    const { title, genre, subgenre, year, description, type, price, track_titles } = req.body;
    if (!title || !genre) return res.status(400).json({ error: "Title and genre required" });

    const coverFile = req.files?.cover?.[0];
    const audioFiles = req.files?.audio || [];
    if (audioFiles.length === 0) return res.status(400).json({ error: "At least one audio file required" });

    // Parse track titles (JSON array sent from client)
    let titles = [];
    try { titles = JSON.parse(track_titles || "[]"); } catch {}

    const insertRelease = db.prepare(`
      INSERT INTO releases (artist_id, title, genre, subgenre, year, description, cover_path, type, price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertRelease.run(
      req.userId, title, genre, subgenre || null,
      year ? parseInt(year) : new Date().getFullYear(),
      description || "", coverFile ? coverFile.filename : null,
      type || "album", parseFloat(price) || 8.00
    );

    const releaseId = result.lastInsertRowid;
    const insertTrack = db.prepare(
      "INSERT INTO tracks (release_id, track_number, title, audio_path, price) VALUES (?, ?, ?, ?, ?)"
    );

    audioFiles.forEach((file, i) => {
      insertTrack.run(
        releaseId, i + 1,
        titles[i] || path.basename(file.originalname, path.extname(file.originalname)),
        file.filename,
        (parseFloat(price) || 8.00) / audioFiles.length
      );
    });

    res.json({ id: releaseId });
  }
);

app.get("/api/artist/releases", authRequired, (req, res) => {
  const releases = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM purchases p WHERE p.release_id = r.id) AS sales
    FROM releases r WHERE r.artist_id = ? ORDER BY r.created_at DESC
  `).all(req.userId);
  res.json({ releases });
});

// =========================================================
// CHECKOUT / PURCHASES
// =========================================================
app.post("/api/checkout", authRequired, async (req, res) => {
  const { releaseId } = req.body;
  const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseId);
  if (!release) return res.status(404).json({ error: "Not found" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: Math.round(release.price * 100),
          product_data: {
            name: release.title,
            description: `FAS Record Store — ${release.genre}`
          }
        },
        quantity: 1
      }],
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/?canceled=1`,
      metadata: { releaseId: String(releaseId), buyerId: String(req.userId) }
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Checkout failed", detail: e.message });
  }
});

// Stripe webhook — records the purchase
app.post("/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const releaseId = parseInt(s.metadata.releaseId);
      const buyerId = parseInt(s.metadata.buyerId);
      const token = nanoid(32);

      db.prepare(`
        INSERT INTO purchases (buyer_id, release_id, amount, stripe_session_id, download_token)
        VALUES (?, ?, ?, ?, ?)
      `).run(buyerId, releaseId, s.amount_total / 100, s.id, token);
    }

    res.json({ received: true });
  }
);

// --- Dev-only: simulate a purchase (for testing without Stripe live keys)
app.post("/api/dev/purchase", authRequired, (req, res) => {
  const { releaseId } = req.body;
  const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseId);
  if (!release) return res.status(404).json({ error: "Not found" });
  const token = nanoid(32);
  db.prepare(`
    INSERT INTO purchases (buyer_id, release_id, amount, download_token)
    VALUES (?, ?, ?, ?)
  `).run(req.userId, releaseId, release.price, token);
  res.json({ ok: true, download_token: token });
});

app.get("/api/library", authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, r.title, r.genre, r.cover_path, u.display_name AS artist_name
    FROM purchases p
    JOIN releases r ON r.id = p.release_id
    JOIN users u ON u.id = r.artist_id
    WHERE p.buyer_id = ?
    ORDER BY p.created_at DESC
  `).all(req.userId);
  res.json({ purchases: rows });
});

// =========================================================
// DOWNLOAD DELIVERY
// =========================================================
app.get("/api/download/:token", (req, res) => {
  const p = db.prepare(`
    SELECT p.*, r.title FROM purchases p
    JOIN releases r ON r.id = p.release_id
    WHERE p.download_token = ?
  `).get(req.params.token);
  if (!p) return res.status(404).send("Invalid download link");
  if (p.download_count >= 10) return res.status(410).send("Download limit reached (10). Contact us.");

  const tracks = db.prepare("SELECT * FROM tracks WHERE release_id = ? ORDER BY track_number").all(p.release_id);

  db.prepare("UPDATE purchases SET download_count = download_count + 1 WHERE id = ?").run(p.id);

  // Simple track-list page with download links
  const html = `
    <!DOCTYPE html><html><head><title>Download — ${p.title}</title>
    <style>body{font-family:Georgia,serif;background:#f8f8f8;color:#1a1a1a;padding:3rem;max-width:640px;margin:0 auto;}
    h1{font-style:italic;font-weight:normal;border-bottom:3px double #1a1a1a;padding-bottom:.5rem;}
    a{display:block;padding:.8rem;background:#fff;border:1px solid #ddd;margin:.5rem 0;text-decoration:none;color:#1a1a1a;font-family:'Courier New',monospace;}
    a:hover{background:#c1440e;color:#fff;}</style></head>
    <body>
      <h1>${p.title}</h1>
      <p style="font-style:italic;color:#6b6259;">Downloads remaining: ${10 - p.download_count - 1}</p>
      ${tracks.map(t => `<a href="/api/download/${req.params.token}/track/${t.id}" download>${String(t.track_number).padStart(2,"0")} — ${t.title}</a>`).join("")}
      <p style="font-size:.8rem;color:#6b6259;margin-top:2rem;font-style:italic;">Thank you for supporting independent music.<br>Fuc A Stream.</p>
    </body></html>
  `;
  res.send(html);
});

app.get("/api/download/:token/track/:trackId", (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE download_token = ?").get(req.params.token);
  if (!p) return res.status(404).send("Invalid token");
  const track = db.prepare("SELECT * FROM tracks WHERE id = ? AND release_id = ?").get(req.params.trackId, p.release_id);
  if (!track) return res.status(404).send("Track not found");
  const filePath = path.join(AUDIO_DIR, track.audio_path);
  if (!fs.existsSync(filePath)) return res.status(404).send("File missing");
  res.download(filePath, `${track.title}${path.extname(track.audio_path)}`);
});

// =========================================================
// ARTIST DASHBOARD STATS
// =========================================================
app.get("/api/artist/stats", authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.title, COUNT(p.id) AS sales, COALESCE(SUM(p.amount),0) AS revenue
    FROM releases r LEFT JOIN purchases p ON p.release_id = r.id
    WHERE r.artist_id = ? GROUP BY r.id ORDER BY revenue DESC
  `).all(req.userId);
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  res.json({ rows, total_revenue: total, artist_share: total * 0.9 });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`FAS Record Store running at ${process.env.BASE_URL || "http://localhost:3000"}`);
});