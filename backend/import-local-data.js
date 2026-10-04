#!/usr/bin/env node
/*
 * Copy your OLD data (a db.json from your PC) into the online database
 * (MongoDB Atlas, or Postgres) that your Render site uses.
 *
 *   cd backend
 *   npm install
 *   node import-local-data.js            (asks for everything it needs)
 *   node import-local-data.js "C:\path\to\old\db.json"
 *
 * It first saves a backup of whatever is online right now, then replaces the
 * online data with the contents of your db.json.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// --- tiny prompt helper (works with typed AND piped input) -------------------
const rl = readline.createInterface({ input: process.stdin });
const queue = [];
const waiters = [];
rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
rl.on("close", () => { while (waiters.length) waiters.shift()(""); });
function ask(q) {
  process.stdout.write(q);
  return new Promise((res) => (queue.length ? res(queue.shift()) : waiters.push(res))).then((a) => a.trim());
}
const unquote = (v) => v.replace(/^["']|["']$/g, "");
const count = (a) => (Array.isArray(a) ? a.length : 0);
const roleCount = (db, r) => (db.users || []).filter((u) => u.role === r).length;
const summary = (db) =>
  `${count(db.users)} accounts (${roleCount(db, "user")} customers, ${roleCount(db, "sales")} admins, ${roleCount(db, "executive")} executives), ` +
  `${count(db.items)} stock items, ${count(db.orders)} orders`;

(async () => {
  console.log("\n=== SmartShelf: import old data into the online database ===\n");

  // 1) the old data file
  let file = process.argv[2] ? unquote(process.argv[2]) : path.join(__dirname, "db.json");
  while (!fs.existsSync(file)) {
    console.log(`Could not find: ${file}`);
    file = unquote(await ask("Full path to your OLD db.json (or press Enter to quit): "));
    if (!file) process.exit(1);
  }
  let oldData;
  try {
    oldData = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!oldData || typeof oldData !== "object" || Array.isArray(oldData)) throw new Error("not a database file");
  } catch (e) {
    console.error(`\n❌ That file couldn't be read as JSON (${e.message}).`);
    process.exit(1);
  }
  console.log(`Old data in ${file}:\n  ${summary(oldData)}\n`);
  if (!count(oldData.users) && !count(oldData.items)) {
    console.log("That file is empty — nothing to import. Make sure you picked the db.json from the folder where you ENTERED your data.");
    process.exit(1);
  }

  // 2) the online database
  let uri = process.env.MONGODB_URI || process.env.DATABASE_URL || "";
  if (!uri) uri = unquote(await ask("Paste your MongoDB connection string (mongodb+srv://...): "));
  if (/^postgres(ql)?:\/\//i.test(uri)) { process.env.DATABASE_URL = uri; delete process.env.MONGODB_URI; }
  else if (/^mongodb(\+srv)?:\/\//i.test(uri)) { process.env.MONGODB_URI = uri; delete process.env.DATABASE_URL; }
  else { console.error("\n❌ That doesn't look like a MongoDB (mongodb+srv://...) or Postgres (postgresql://...) address."); process.exit(1); }
  // Don't let db.js auto-import a different db.json before we do it deliberately.
  process.env.DB_PATH = path.join(require("os").tmpdir(), `smartshelf-no-import-${Date.now()}.json`);

  const db = require("./db");
  console.log("\nConnecting to the online database...");
  try { await db.init(); }
  catch (e) {
    console.error(`\n❌ Could not connect: ${e.message}\n   Check the password, that <password> was replaced, and that Atlas "Network Access" allows 0.0.0.0/0.`);
    process.exit(1);
  }

  const online = db.readDB();
  console.log(`Online right now:\n  ${summary(online)}\n`);

  // 3) back up what is online, then confirm
  if (count(online.users) || count(online.items) || count(online.orders)) {
    const backup = path.join(__dirname, `online-backup-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify(online, null, 2));
    console.log(`Saved a backup of the current online data to:\n  ${backup}\n`);
    console.log("⚠️  Importing REPLACES the online data with your old data.");
    console.log("   Accounts created online since then will need to register again.\n");
  }
  const ok = (await ask("Type YES to import now: ")).toUpperCase();
  if (ok !== "YES") { console.log("Cancelled. Nothing was changed."); await db.flush(); process.exit(0); }

  await db.replaceAll(oldData);
  await db.flush();
  console.log(`\n✅ Done. The online database now has:\n  ${summary(oldData)}`);
  console.log("\nNEXT (important): in Render open your service → Manual Deploy → \"Restart service\"");
  console.log("(or Deploy latest commit) and don't use the site until it's back. Then log in with your OLD accounts.\n");
  process.exit(0);
})().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
