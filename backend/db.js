const fs = require("fs");
const path = require("path");

// All accounts/items/orders live in this one JSON file on the SERVER's disk —
// never in the browser. That's what makes data show up the same way whether
// a customer opens the site on their phone or their PC: both devices just
// talk to this same backend/API, not to anything stored locally in the browser.
//
// By default this file sits next to server.js. When deploying somewhere with
// a persistent disk/volume (Render persistent disk, Railway volume, Fly.io
// volume, a VPS, etc.), set the DB_PATH env var to a path inside that mounted
// volume so the file survives restarts and redeploys instead of resetting.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "db.json");

// Make sure the parent folder exists (useful when DB_PATH points into a
// freshly-mounted, empty volume).
// ---------------------------------------------------------------------------
// STORAGE MODE
//   - MONGODB_URI set   -> data lives in MongoDB (e.g. Atlas' free M0 cluster):
//     one document per user / item / order, so photos never hit MongoDB's 16 MB
//     per-document limit.
//   - DATABASE_URL set  -> data lives in a Postgres database (e.g. Neon's free
//     tier). Survives restarts/redeploys/sleeps on hosts with no persistent disk,
//     like Render's free plan. Reads come from an in-memory copy; every change
//     is saved to Postgres a moment later (and flushed on shutdown).
//   - DATABASE_URL not set -> data lives in the db.json file (local use / a
//     paid host with a persistent disk + DB_PATH), exactly as before.
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || "";     // Postgres (Neon, Supabase, ...)
const MONGODB_URI = process.env.MONGODB_URI || "";       // MongoDB (Atlas, ...)
const USE_PG = !!DATABASE_URL;
const USE_MONGO = !USE_PG && !!MONGODB_URI;
const USE_REMOTE = USE_PG || USE_MONGO;                  // data kept in memory + saved to a cloud database

const DB_DIR = path.dirname(DB_PATH);
if (!USE_REMOTE && !fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

function emptyDB() {
  return {
    nextUserId: 1,
    nextItemId: 1,
    nextOrderId: 1,
    nextAddressId: 1,
    users: [], // { id, name, email, passwordHash, token, role: 'sales'|'user'|'executive', phone, addresses: [...] }
    items: [], // { id, addedByUserId, addedByName, name, brand, category, barcode, mfd, expiry, price, quantity, source, photo, discountApproved, lastDecidedPct, addedAt }
    orders: [], // { id, userId, userName, items: [...], paymentMethod, paymentSummary, total, placedAt }
    otpSessions: [], // short-lived login OTP challenges
  };
}

/* ----------------------------- Postgres mode ----------------------------- */
let pool = null;
let cache = null;          // the whole database, held in memory in Postgres mode
let persistTimer = null;
let persisting = false;
let dirty = false;

function makePool() {
  const { Pool } = require("pg");
  // Strip sslmode/channel_binding from the URL and set SSL ourselves so the same
  // connection string works for Neon, Supabase, Render, etc.
  const url = new URL(DATABASE_URL);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  url.searchParams.delete("channel_binding");
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const ssl = isLocal || sslmode === "disable" ? false : { rejectUnauthorized: false };
  return new Pool({ connectionString: url.toString(), ssl, max: 3, connectionTimeoutMillis: 15000 });
}

async function saveToPg() {
  await pool.query(
    `INSERT INTO smartshelf_state (id, data, updated_at) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [JSON.stringify(cache)]
  );
}

// Save soon after a change; bursts of changes are merged into one save, and a
// change that arrives mid-save triggers one more save right after.
function schedulePersist() {
  dirty = true;
  if (persistTimer || persisting) return;
  persistTimer = setTimeout(runPersist, 200);
}
async function runPersist() {
  persistTimer = null;
  if (persisting || !dirty) return;
  persisting = true;
  dirty = false;
  try {
    await saveRemote();
  } catch (err) {
    dirty = true; // try again on the next change / flush
    console.error(`[db] Could not save to ${USE_MONGO ? "MongoDB" : "Postgres"}:`, err.message);
  } finally {
    persisting = false;
    if (dirty && !persistTimer) persistTimer = setTimeout(runPersist, 2000);
  }
}

/* ----------------------------- MongoDB mode ------------------------------ */
let mclient = null;
let mdb = null;
const MONGO_COLLECTIONS = { users: "id", items: "id", orders: "id", otpSessions: "otpToken" };
const COUNTER_KEYS = ["nextUserId", "nextItemId", "nextOrderId", "nextAddressId"];
// What is currently stored in MongoDB: collection -> Map(_id -> JSON string).
// Used to write only what changed (new/edited/removed documents).
let mongoSeen = {};

function mongoDbName() {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  try { const p = new URL(MONGODB_URI).pathname.replace(/^\//, ""); if (p) return decodeURIComponent(p); } catch { /* fall through */ }
  return "smartshelf";
}

function mongoDocKey(coll, doc) {
  const k = doc && doc[MONGO_COLLECTIONS[coll]];
  return k === undefined || k === null ? null : String(k);
}

async function saveToMongo() {
  const ops = {}; // collection -> bulk operations
  const nextSeen = {};
  for (const coll of Object.keys(MONGO_COLLECTIONS)) {
    const now = new Map();
    for (const doc of cache[coll] || []) {
      const key = mongoDocKey(coll, doc);
      if (key === null) { console.warn(`[db] Skipped a ${coll} record with no ${MONGO_COLLECTIONS[coll]}.`); continue; }
      now.set(key, JSON.stringify(doc));
    }
    const before = mongoSeen[coll] || new Map();
    const list = [];
    for (const [key, json] of now) {
      if (before.get(key) !== json) {
        list.push({ replaceOne: { filter: { _id: key }, replacement: JSON.parse(json), upsert: true } });
      }
    }
    for (const key of before.keys()) {
      if (!now.has(key)) list.push({ deleteOne: { filter: { _id: key } } });
    }
    if (list.length) ops[coll] = list;
    nextSeen[coll] = now;
  }
  const counters = {};
  for (const k of COUNTER_KEYS) counters[k] = cache[k];
  const countersJson = JSON.stringify(counters);

  for (const [coll, list] of Object.entries(ops)) {
    await mdb.collection(coll).bulkWrite(list, { ordered: false });
  }
  if (mongoSeen.__counters !== countersJson) {
    await mdb.collection("meta").replaceOne({ _id: "counters" }, counters, { upsert: true });
  }
  nextSeen.__counters = countersJson;
  mongoSeen = nextSeen; // only after everything was written successfully
}

async function loadFromMongo() {
  const meta = await mdb.collection("meta").findOne({ _id: "counters" });
  const out = emptyDB();
  mongoSeen = {};
  if (!meta) return null; // brand-new, empty database
  for (const k of COUNTER_KEYS) if (Number.isFinite(meta[k])) out[k] = meta[k];
  for (const coll of Object.keys(MONGO_COLLECTIONS)) {
    const docs = await mdb.collection(coll).find({}).toArray();
    const seen = new Map();
    out[coll] = docs.map((d) => {
      const { _id, ...rest } = d;
      seen.set(String(_id), JSON.stringify(rest));
      return rest;
    });
    // keep the original order (ids only ever count up)
    const idKey = MONGO_COLLECTIONS[coll];
    if (coll !== "otpSessions") out[coll].sort((a, b) => (a[idKey] || 0) - (b[idKey] || 0));
    mongoSeen[coll] = seen;
  }
  const c = {};
  for (const k of COUNTER_KEYS) c[k] = out[k];
  mongoSeen.__counters = JSON.stringify(c);
  return out;
}

function saveRemote() { return USE_MONGO ? saveToMongo() : saveToPg(); }

function importLocalFile() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const imported = JSON.parse(fs.readFileSync(DB_PATH, "utf8").replace(/^\uFEFF/, ""));
      if (imported && typeof imported === "object") return imported;
    }
  } catch { /* start empty */ }
  return null;
}

async function initMongo() {
  const { MongoClient } = require("mongodb");
  mclient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 5 });
  await mclient.connect();
  mdb = mclient.db(mongoDbName());
  const loaded = await loadFromMongo();
  if (loaded) {
    cache = loaded;
    console.log(`[db] Loaded existing data from MongoDB (${cache.users.length} users, ${cache.items.length} items, ${cache.orders.length} orders).`);
  } else {
    const imported = importLocalFile();
    cache = imported || emptyDB();
    if (imported) console.log("[db] Imported existing db.json into MongoDB.");
    mongoSeen = {};
    await saveToMongo();
    console.log("[db] MongoDB database ready (new).");
  }
}

// Call once at startup, BEFORE the server starts listening.
async function init() {
  if (!USE_REMOTE) return;
  if (USE_MONGO) return initMongo();
  pool = makePool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS smartshelf_state (
       id INT PRIMARY KEY,
       data JSONB NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const r = await pool.query("SELECT data FROM smartshelf_state WHERE id = 1");
  if (r.rows[0] && r.rows[0].data && typeof r.rows[0].data === "object") {
    cache = r.rows[0].data;
    console.log(`[db] Loaded existing data from Postgres (${(cache.users || []).length} users, ${(cache.items || []).length} items, ${(cache.orders || []).length} orders).`);
  } else {
    // First run against an empty database. If a local db.json is sitting next to
    // the server (e.g. you migrated), import it so nothing is lost.
    cache = emptyDB();
    try {
      if (fs.existsSync(DB_PATH)) {
        const imported = JSON.parse(fs.readFileSync(DB_PATH, "utf8").replace(/^\uFEFF/, ""));
        if (imported && typeof imported === "object") { cache = imported; console.log("[db] Imported existing db.json into Postgres."); }
      }
    } catch { /* start empty */ }
    await saveToPg();
    console.log("[db] Postgres database ready (new).");
  }
}

// Replace EVERYTHING in the cloud database with `data` (used by import-local-data.js).
async function replaceAll(data) {
  if (!USE_REMOTE || !cache) throw new Error("replaceAll() only works with a cloud database.");
  cache = data;
  dirty = false;
  await saveRemote();
}

// Call on shutdown so the last change is never lost.
async function flush() {
  if (!USE_REMOTE || !(pool || mclient)) return;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  for (let i = 0; i < 3 && (dirty || persisting); i++) {
    if (persisting) { await new Promise((r) => setTimeout(r, 300)); continue; }
    await runPersist();
  }
  try { if (pool) await pool.end(); if (mclient) await mclient.close(); } catch { /* ignore */ }
}

// Read + parse db.json. A missing, empty, or corrupted file (e.g. the server was
// killed in the middle of a write) must NEVER take the whole app down: a broken
// file is moved aside as db.json.corrupt-<time> and a fresh database is started.
function loadRaw() {
  if (USE_REMOTE) {
    if (!cache) throw new Error("Database not ready yet — init() must finish before reading.");
    return structuredClone(cache); // callers edit their copy, then call writeDB(copy)
  }
  if (!fs.existsSync(DB_PATH)) {
    const fresh = emptyDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  let text = "";
  try {
    text = fs.readFileSync(DB_PATH, "utf8").replace(/^\uFEFF/, ""); // strip a BOM if an editor added one
    if (!text.trim()) throw new Error("db.json is empty");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("db.json has the wrong shape");
    return parsed;
  } catch (err) {
    const backup = `${DB_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(DB_PATH, backup); } catch { /* ignore */ }
    console.warn(`\n⚠️  ${path.basename(DB_PATH)} could not be read (${err.message}). ` +
      `Moved it to ${path.basename(backup)} and started a fresh database.`);
    const fresh = emptyDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function readDB() {
  const db = loadRaw();
  // fill in anything missing, and migrate older db.json files
  const base = emptyDB();
  for (const k of ["nextUserId", "nextItemId", "nextOrderId", "nextAddressId"]) {
    if (!Number.isFinite(db[k]) || db[k] < 1) db[k] = base[k];
  }
  for (const k of ["users", "items", "orders", "otpSessions"]) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
  db.users.forEach((u) => {
    if (u.phone === undefined) u.phone = "";
    if (!Array.isArray(u.addresses)) {
      // migrate the old single-address shape into the new addresses list
      u.addresses = u.address ? [{ id: db.nextAddressId++, label: "Home", ...u.address, isDefault: true }] : [];
    }
    delete u.address;
  });
  db.items.forEach((i) => {
    if (i.discountApproved === undefined) i.discountApproved = null;
    if (i.lastDecidedPct === undefined) i.lastDecidedPct = null;
  });
  return db;
}

// Write to a temp file first, then swap it in, so a crash mid-write can never
// leave a half-written (corrupt) db.json behind.
function writeDB(db) {
  if (USE_REMOTE) { cache = db; schedulePersist(); return; }
  const data = JSON.stringify(db, null, 2);
  const tmp = `${DB_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, DB_PATH);
  } catch (err) {
    // Some Windows setups (antivirus / file locked) refuse the rename — fall back to a direct write.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    fs.writeFileSync(DB_PATH, data);
  }
}

module.exports = { readDB, writeDB, init, flush, replaceAll, usingPostgres: USE_PG, usingMongo: USE_MONGO, usingRemote: USE_REMOTE };
