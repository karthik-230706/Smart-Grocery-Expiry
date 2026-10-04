#!/usr/bin/env node
/*
 * Download a full copy of the ONLINE data (accounts, stock, orders) to your PC.
 *
 *   cd backend && node export-backup.js
 *
 * Creates backend/backups/smartshelf-backup-<date>.json. That file can be put
 * back online any time with import-local-data.js, so your data can never be
 * lost even if a database provider changes its free plan.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });
const queue = [], waiters = [];
rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
rl.on("close", () => { while (waiters.length) waiters.shift()(""); });
const ask = (q) => { process.stdout.write(q); return new Promise((r) => (queue.length ? r(queue.shift()) : waiters.push(r))).then((a) => a.trim().replace(/^["']|["']$/g, "")); };

(async () => {
  console.log("\n=== SmartShelf: back up your online data to this PC ===\n");
  let uri = process.env.MONGODB_URI || process.env.DATABASE_URL || "";
  if (!uri) uri = await ask("Paste your database connection string (postgresql://... or mongodb+srv://...): ");
  if (/^postgres(ql)?:\/\//i.test(uri)) { process.env.DATABASE_URL = uri; delete process.env.MONGODB_URI; }
  else if (/^mongodb(\+srv)?:\/\//i.test(uri)) { process.env.MONGODB_URI = uri; delete process.env.DATABASE_URL; }
  else { console.error("\n❌ That doesn't look like a database connection string."); process.exit(1); }
  process.env.DB_PATH = path.join(require("os").tmpdir(), `smartshelf-no-import-${Date.now()}.json`);

  const db = require("./db");
  try { await db.init(); }
  catch (e) { console.error(`\n❌ Could not connect: ${e.message}`); process.exit(1); }

  const data = db.readDB();
  const dir = path.join(__dirname, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = path.join(dir, `smartshelf-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\n✅ Saved: ${file}`);
  console.log(`   ${data.users.length} accounts, ${data.items.length} stock items, ${data.orders.length} orders`);
  console.log("\nKeep this file safe (copy it to a USB drive / Google Drive). It contains account details — do NOT upload it to GitHub.\n");
  await db.flush();
  process.exit(0);
})().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
