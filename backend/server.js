const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { readDB, writeDB, init: initDB, flush: flushDB, usingPostgres, usingMongo, usingRemote } = require("./db");
const { lookupBarcode, CATEGORY_LIST } = require("./catalog");

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

// Allow the page to call this API even if it was opened from another address
// (e.g. VS Code Live Server on :5500). Auth uses a Bearer header, not cookies,
// so allowing any origin does not expose anyone's session.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// Open /api/health on any device to see WHERE the data is stored and whether it survives restarts.
app.get("/api/health", (req, res) => {
  const persistent = usingRemote || !!process.env.DB_PATH;
  res.json({
    ok: true,
    app: "smartshelf",
    storage: usingMongo ? "mongodb" : usingPostgres ? "postgres" : process.env.DB_PATH ? "disk" : "local-file",
    dataIsSaved: persistent,
    note: persistent
      ? "Data is stored permanently and will still be here after restarts."
      : "WARNING: data is stored in a temporary file and will be LOST when this server restarts. Set MONGODB_URI.",
  });
});

app.use(express.json({ limit: "8mb" })); // higher limit so a manual-entry item photo (base64) fits
app.use(express.static(FRONTEND_DIR));

/* ---------------------------- helpers ---------------------------- */

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}
function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}
function makeOtpToken() {
  return crypto.randomBytes(16).toString("hex");
}
function makeOtp() {
  return String(crypto.randomInt(100000, 999999));
}
function maskEmail(email) {
  return String(email).replace(/^(.{2}).*(@.*)$/, "$1***$2");
}
function maskPhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 2) return "*".repeat(digits.length);
  return "*".repeat(Math.max(0, digits.length - 2)) + digits.slice(-2);
}
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Discount tiers — same rules as the original smartshelf README.
function tierFor(days) {
  if (days < 0) return { pct: 0, ribbon: "Expired", status: "expired", label: "Expired — remove from shelf" };
  if (days === 0) return { pct: 30, ribbon: "Expires Today", status: "urgent", label: "Expires today — clearance" };
  if (days <= 2) return { pct: 30, ribbon: "Final Clearance", status: "urgent", label: "Use today / clearance" };
  if (days <= 7) return { pct: 20, ribbon: "Urgent", status: "urgent", label: "Urgent — use soon" };
  if (days <= 14) return { pct: 10, ribbon: "Selling fast", status: "soon", label: "Expiring soon" };
  if (days <= 30) return { pct: 5, ribbon: null, status: "soon", label: "Plan to use" };
  return { pct: 0, ribbon: null, status: "safe", label: "Fresh" };
}

function computeItem(item) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiryDate = new Date(item.expiry + "T00:00:00");
  const days = Math.round((expiryDate - today) / 86400000);
  const tier = tierFor(days);
  const price = Number(item.price) || 0;

  // A discount only reaches customers once a Sales Executive approves it for the
  // item's *current* tier — if the tier has moved since the last decision (e.g.
  // 10% -> 20% as it gets closer to expiry), it needs approval again.
  const offerPending = tier.pct > 0 && item.lastDecidedPct !== tier.pct;
  const approved = tier.pct > 0 && !offerPending && item.discountApproved === true;
  const discounted = +(price * (1 - tier.pct / 100)).toFixed(0);
  const price_now = approved ? discounted : price;

  return {
    ...item,
    days_remaining: days,
    status: tier.status,
    status_label: tier.label,
    ribbon: approved ? tier.ribbon : offerPending ? "Pending approval" : tier.ribbon,
    discount_pct: approved ? tier.pct : 0,
    potential_discount_pct: tier.pct,
    offer_pending: offerPending,
    price_now,
    price_was: approved ? price : null,
  };
}

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const db = readDB();
  const user = db.users.find((u) => u.token === token && token);
  if (!user) return res.status(401).json({ error: "Not logged in. Please sign in again." });
  req.user = user;
  req.db = db;
  // Safety net: every change made to req.db during this request gets written
  // to disk automatically the moment the response finishes — a route never
  // has to remember to call writeDB() itself for a change to be saved.
  res.on("finish", () => writeDB(req.db));
  next();
}

// Human-readable names for the three account types.
const ROLE_LABELS = { sales: "Admin", user: "Customer", executive: "Executive" };

// Accepts one or more allowed roles, e.g. requireRole("sales", "executive").
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      const labels = roles.map((r) => ROLE_LABELS[r] || r).join(" or ");
      return res.status(403).json({ error: `This action is only available to ${labels} accounts.` });
    }
    next();
  };
}

/* ---------------------------- auth routes ---------------------------- */

// role must be "sales", "user", or "executive" — kept as separate signup/login flows
app.post("/api/register", (req, res) => {
  const { name, email, password, phone, role } = req.body || {};
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: "Enter your name, a valid email, and a password of at least 6 characters." });
  }
  if (!phone || !/^\+?[\d\s-]{7,15}$/.test(String(phone).trim())) {
    return res.status(400).json({ error: "Enter a valid mobile number — it's needed to send you a login OTP." });
  }
  if (!ROLE_LABELS[role]) {
    return res.status(400).json({ error: "Invalid account type." });
  }
  const db = readDB();
  const normEmail = email.trim().toLowerCase();
  if (db.users.some((u) => u.email === normEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  const user = {
    id: db.nextUserId++,
    name: name.trim(),
    email: normEmail,
    passwordHash: hashPassword(password),
    token: null,
    role,
    phone: String(phone).trim(),
    addresses: [],
  };
  db.users.push(user);
  writeDB(db);
  res.json({ message: "Account created. You can log in now." });
});

// Step 1 of login: verify the password, then issue a short-lived OTP challenge
// instead of a session token straight away. Admin accounts get an OTP on both
// email and mobile; Customer accounts get an OTP on mobile only.
app.post("/api/login", (req, res) => {
  const { email, password, role } = req.body || {};
  const db = readDB();
  const normEmail = (email || "").trim().toLowerCase();
  const user = db.users.find((u) => u.email === normEmail && u.passwordHash === hashPassword(password || ""));
  if (!user) return res.status(401).json({ error: "Invalid email or password." });
  if (role && user.role !== role) {
    return res.status(403).json({ error: `This account is registered as a${user.role === "sales" || user.role === "executive" ? "n" : ""} ${ROLE_LABELS[user.role]}. Please use that login instead.` });
  }
  if (!user.phone) {
    return res.status(400).json({ error: "Your account has no mobile number on file, so an OTP can't be sent. Please update your profile or contact support." });
  }

  db.otpSessions = (db.otpSessions || []).filter((s) => s.expiresAt > Date.now()); // sweep expired sessions
  // Sales (Admin) and Executive accounts are privileged — they get an OTP on
  // both email and mobile. Customer accounts get an OTP on mobile only.
  const isPrivileged = user.role === "sales" || user.role === "executive";
  const otpToken = makeOtpToken();
  const emailOtp = isPrivileged ? makeOtp() : null;
  const phoneOtp = makeOtp();
  db.otpSessions.push({
    otpToken,
    userId: user.id,
    emailOtp,
    phoneOtp,
    emailVerified: !emailOtp,
    phoneVerified: false,
    expiresAt: Date.now() + OTP_TTL_MS,
  });
  writeDB(db);

  res.json({
    requiresOtp: true,
    otpToken,
    channels: isPrivileged ? ["email", "phone"] : ["phone"],
    maskedEmail: maskEmail(user.email),
    maskedPhone: maskPhone(user.phone),
    // Demo mode only — no real email/SMS gateway is wired up, so the OTP is
    // returned here for testing instead of actually being sent.
    demoEmailOtp: emailOtp,
    demoPhoneOtp: phoneOtp,
  });
});

// Step 2 of login: verify the OTP(s) issued above, then finally hand out the
// real session token.
app.post("/api/verify-otp", (req, res) => {
  const { otpToken, emailOtp, phoneOtp } = req.body || {};
  const db = readDB();
  const session = (db.otpSessions || []).find((s) => s.otpToken === otpToken);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(400).json({ error: "This OTP has expired. Please log in again to get a new one." });
  }
  const user = db.users.find((u) => u.id === session.userId);
  if (!user) return res.status(404).json({ error: "Account not found." });

  if (session.emailOtp !== null) {
    if (!emailOtp) return res.status(400).json({ error: "Enter the OTP sent to your email." });
    if (String(emailOtp).trim() !== session.emailOtp) return res.status(400).json({ error: "Incorrect email OTP." });
    session.emailVerified = true;
  }
  if (!phoneOtp) return res.status(400).json({ error: "Enter the OTP sent to your mobile number." });
  if (String(phoneOtp).trim() !== session.phoneOtp) return res.status(400).json({ error: "Incorrect mobile OTP." });
  session.phoneVerified = true;

  if (!session.emailVerified || !session.phoneVerified) {
    writeDB(db);
    return res.status(400).json({ error: "Verification incomplete." });
  }

  user.token = makeToken();
  db.otpSessions = db.otpSessions.filter((s) => s.otpToken !== otpToken);
  writeDB(db);
  res.json({ token: user.token, name: user.name, email: user.email, role: user.role });
});

// Re-issues a fresh OTP pair against the same pending login challenge.
app.post("/api/resend-otp", (req, res) => {
  const { otpToken } = req.body || {};
  const db = readDB();
  const session = (db.otpSessions || []).find((s) => s.otpToken === otpToken);
  if (!session) return res.status(400).json({ error: "This OTP session has expired. Please log in again." });
  const user = db.users.find((u) => u.id === session.userId);
  if (!user) return res.status(404).json({ error: "Account not found." });

  session.emailOtp = session.emailOtp !== null ? makeOtp() : null;
  session.phoneOtp = makeOtp();
  session.emailVerified = !session.emailOtp;
  session.phoneVerified = false;
  session.expiresAt = Date.now() + OTP_TTL_MS;
  writeDB(db);
  res.json({ message: "A new OTP has been sent.", demoEmailOtp: session.emailOtp, demoPhoneOtp: session.phoneOtp });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.user.token = null;
  writeDB(req.db);
  res.json({ message: "Logged out." });
});

// Demo-only "forgot password" flow — no email step, resets the password directly.
app.post("/api/forgot-password", (req, res) => {
  const { email, role, newPassword } = req.body || {};
  if (!email || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "Enter your account email and a new password of at least 6 characters." });
  }
  if (!ROLE_LABELS[role]) {
    return res.status(400).json({ error: "Invalid account type." });
  }
  const db = readDB();
  const normEmail = email.trim().toLowerCase();
  const user = db.users.find((u) => u.email === normEmail && u.role === role);
  if (!user) return res.status(404).json({ error: `No ${ROLE_LABELS[role]} account found with that email.` });
  user.passwordHash = hashPassword(newPassword);
  user.token = null;
  writeDB(db);
  res.json({ message: "Password updated. You can log in with your new password now." });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ name: req.user.name, email: req.user.email, role: req.user.role, phone: req.user.phone || "", addresses: req.user.addresses || [] });
});

app.put("/api/profile", requireAuth, (req, res) => {
  const { name, phone } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "Name can't be empty." });
    req.user.name = name.trim();
  }
  if (phone !== undefined) {
    if (!String(phone).trim()) return res.status(400).json({ error: "Mobile number can't be empty — it's required for OTP login." });
    req.user.phone = String(phone).trim();
  }
  writeDB(req.db);
  res.json({ name: req.user.name, email: req.user.email, role: req.user.role, phone: req.user.phone || "" });
});

/* ---------------------------- addresses (user only, one or more) ---------------------------- */

app.post("/api/addresses", requireAuth, requireRole("user"), (req, res) => {
  const { label, line1, city, state, pincode, phone } = req.body || {};
  if (!line1 || !city || !pincode) {
    return res.status(400).json({ error: "Address line, city, and pincode are required." });
  }
  const db = req.db;
  if (!Array.isArray(req.user.addresses)) req.user.addresses = [];
  const addr = {
    id: db.nextAddressId++,
    label: (label || "").trim() || "Address",
    line1: line1.trim(), city: city.trim(), state: (state || "").trim(),
    pincode: pincode.trim(), phone: (phone || "").trim(),
    isDefault: req.user.addresses.length === 0,
  };
  req.user.addresses.push(addr);
  writeDB(db);
  res.status(201).json({ addresses: req.user.addresses });
});

app.put("/api/addresses/:id", requireAuth, requireRole("user"), (req, res) => {
  const addr = (req.user.addresses || []).find((a) => a.id === Number(req.params.id));
  if (!addr) return res.status(404).json({ error: "Address not found." });
  const { label, line1, city, state, pincode, phone } = req.body || {};
  if (!line1 || !city || !pincode) {
    return res.status(400).json({ error: "Address line, city, and pincode are required." });
  }
  addr.label = (label || "").trim() || addr.label || "Address";
  addr.line1 = line1.trim(); addr.city = city.trim(); addr.state = (state || "").trim();
  addr.pincode = pincode.trim(); addr.phone = (phone || "").trim();
  writeDB(req.db);
  res.json({ addresses: req.user.addresses });
});

app.delete("/api/addresses/:id", requireAuth, requireRole("user"), (req, res) => {
  const list = req.user.addresses || [];
  const id = Number(req.params.id);
  const target = list.find((a) => a.id === id);
  if (!target) return res.status(404).json({ error: "Address not found." });
  req.user.addresses = list.filter((a) => a.id !== id);
  if (target.isDefault && req.user.addresses.length) req.user.addresses[0].isDefault = true;
  writeDB(req.db);
  res.json({ addresses: req.user.addresses });
});

app.post("/api/addresses/:id/default", requireAuth, requireRole("user"), (req, res) => {
  const id = Number(req.params.id);
  const list = req.user.addresses || [];
  const target = list.find((a) => a.id === id);
  if (!target) return res.status(404).json({ error: "Address not found." });
  list.forEach((a) => { a.isDefault = a.id === id; });
  writeDB(req.db);
  res.json({ addresses: req.user.addresses });
});

/* ---------------------------- barcode lookup (sales only) ---------------------------- */

app.get("/api/barcode/:code", requireAuth, requireRole("sales"), (req, res) => {
  const match = lookupBarcode(req.params.code);
  if (!match) return res.status(404).json({ error: "Barcode not recognized. You can still add this item manually." });
  res.json(match);
});

app.get("/api/categories", (req, res) => res.json(CATEGORY_LIST));

/* ---------------------------- item routes ---------------------------- */

// Customers see the combined catalog from every Admin. Each Admin only sees
// the stock THEY personally added — logging in as a different Admin email
// shows that Admin's own products, never another Admin's. An Executive
// oversees everyone, so they see everything from every Admin.
app.get("/api/items", requireAuth, (req, res) => {
  let items = req.db.items;
  if (req.user.role === "sales") items = items.filter((i) => i.addedByUserId === req.user.id);
  const computed = items.map(computeItem).sort((a, b) => a.days_remaining - b.days_remaining);
  res.json({ count: computed.length, items: computed });
});

// Only Admins (sales role) can add items — by barcode or manually. Whoever is
// logged in when the item is added becomes that item's owner (addedByUserId),
// which is what keeps each Admin's uploads separate from every other Admin's.
app.post("/api/items", requireAuth, requireRole("sales"), (req, res) => {
  const { name, brand, category, barcode, mfd, expiry, price, quantity, source, photo } = req.body || {};
  if (!name || !expiry) {
    return res.status(400).json({ error: "At minimum, a product name and expiry date are required." });
  }
  if (photo && typeof photo === "string" && photo.length > 6_000_000) {
    return res.status(400).json({ error: "That photo is too large. Try a smaller image." });
  }
  const db = req.db;
  const item = {
    id: db.nextItemId++,
    addedByUserId: req.user.id,
    addedByName: req.user.name,
    name: name.trim(),
    brand: (brand || "").trim() || "Unbranded",
    category: category || "Other",
    barcode: barcode || null,
    mfd: mfd || null,
    expiry,
    price: Number(price) || 0,
    quantity: Number(quantity) || 1,
    source: source === "barcode" ? "barcode" : "manual",
    photo: typeof photo === "string" && photo.startsWith("data:image/") ? photo : null,
    discountApproved: null,
    lastDecidedPct: null,
    addedAt: new Date().toISOString(),
  };
  db.items.push(item);
  writeDB(db);
  res.status(201).json(computeItem(item));
});

// Executives can edit/remove ANY item (oversight across every Admin). An
// Admin can only edit/remove items that they themselves added.
app.put("/api/items/:id", requireAuth, requireRole("sales", "executive"), (req, res) => {
  const db = req.db;
  const item = db.items.find((i) => i.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (req.user.role === "sales" && item.addedByUserId !== req.user.id) {
    return res.status(403).json({ error: "You can only edit items you added yourself." });
  }
  const fields = ["name", "brand", "category", "mfd", "expiry", "price", "quantity", "photo"];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) item[f] = f === "price" || f === "quantity" ? Number(req.body[f]) : req.body[f];
  });
  writeDB(db);
  res.json(computeItem(item));
});

app.delete("/api/items/:id", requireAuth, requireRole("sales", "executive"), (req, res) => {
  const db = req.db;
  const item = db.items.find((i) => i.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (req.user.role === "sales" && item.addedByUserId !== req.user.id) {
    return res.status(403).json({ error: "You can only remove items you added yourself." });
  }
  db.items = db.items.filter((i) => i.id !== item.id);
  writeDB(db);
  res.json({ message: "Removed." });
});

app.get("/api/summary", requireAuth, (req, res) => {
  let items = req.db.items;
  if (req.user.role === "sales") items = items.filter((i) => i.addedByUserId === req.user.id);
  const computed = items.map(computeItem);
  const summary = { safe: 0, soon: 0, urgent: 0, expired: 0, total: computed.length };
  computed.forEach((i) => summary[i.status]++);
  res.json(summary);
});

// Admin/Executive alarm feed: items that need attention right now (expiring soon / urgent).
// An Admin only sees alerts for their own stock; an Executive sees every Admin's.
app.get("/api/alerts", requireAuth, requireRole("sales", "executive"), (req, res) => {
  let source = req.db.items;
  if (req.user.role === "sales") source = source.filter((i) => i.addedByUserId === req.user.id);
  const items = source
    .map(computeItem)
    .filter((i) => i.status === "soon" || i.status === "urgent")
    .sort((a, b) => a.days_remaining - b.days_remaining);
  res.json({ count: items.length, items });
});

/* ---------------------------- offer approvals (sales & executive) ---------------------------- */

// Discounts computed from the expiry tiers don't reach customers until an
// Admin (or an Executive, for any Admin's stock) reviews and accepts (or
// keeps the full price on) each one.
app.get("/api/offers/pending", requireAuth, requireRole("sales", "executive"), (req, res) => {
  let source = req.db.items;
  if (req.user.role === "sales") source = source.filter((i) => i.addedByUserId === req.user.id);
  const items = source
    .map(computeItem)
    .filter((i) => i.offer_pending)
    .sort((a, b) => a.days_remaining - b.days_remaining);
  res.json({ count: items.length, items });
});

app.post("/api/offers/:id/decision", requireAuth, requireRole("sales", "executive"), (req, res) => {
  const db = req.db;
  const item = db.items.find((i) => i.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (req.user.role === "sales" && item.addedByUserId !== req.user.id) {
    return res.status(403).json({ error: "You can only decide on offers for items you added yourself." });
  }
  const { approve } = req.body || {};
  if (typeof approve !== "boolean") return res.status(400).json({ error: "Specify approve: true (accept the discount) or false (keep full price)." });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiryDate = new Date(item.expiry + "T00:00:00");
  const days = Math.round((expiryDate - today) / 86400000);
  const tier = tierFor(days);

  item.discountApproved = approve;
  item.lastDecidedPct = tier.pct;
  writeDB(db);
  res.json(computeItem(item));
});

/* ---------------------------- cart / checkout (user only) ---------------------------- */

app.post("/api/checkout", requireAuth, requireRole("user"), (req, res) => {
  const { items, paymentMethod, paymentDetails, addressId } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Your cart is empty." });
  }
  if (!["upi", "card", "cod"].includes(paymentMethod)) {
    return res.status(400).json({ error: "Choose a valid payment method (UPI, Card, or Cash on Delivery)." });
  }
  // A delivery address is required at order time (asked during checkout, not just saved in a profile tab).
  const deliveryAddress = (req.user.addresses || []).find((a) => a.id === Number(addressId));
  if (!deliveryAddress) {
    return res.status(400).json({ error: "Please add and select a delivery address before placing your order." });
  }

  const db = req.db;
  // Validate every line first — all-or-nothing so a checkout never partially applies.
  const resolved = [];
  for (const line of items) {
    const qty = Math.max(1, Number(line.qty) || 0);
    const stockItem = db.items.find((i) => i.id === Number(line.id));
    if (!stockItem) return res.status(404).json({ error: `An item in your cart is no longer in stock.` });
    if (qty > stockItem.quantity) {
      return res.status(400).json({ error: `Only ${stockItem.quantity} of "${stockItem.name}" left in stock.` });
    }
    resolved.push({ stockItem, qty, priceEach: computeItem(stockItem).price_now });
  }

  const orderItems = resolved.map(({ stockItem, qty, priceEach }) => ({
    itemId: stockItem.id,
    name: stockItem.name,
    category: stockItem.category,
    qty,
    priceEach,
    originalPriceEach: Number(stockItem.price) || 0,
    lineTotal: +(priceEach * qty).toFixed(0),
    // Which Admin's stock this line came from — lets each Admin (and an
    // Executive) see only the part of an order that belongs to them.
    addedByUserId: stockItem.addedByUserId,
    addedByName: stockItem.addedByName,
  }));
  const total = orderItems.reduce((sum, l) => sum + l.lineTotal, 0);

  // Apply stock changes — remove the item entirely once it hits zero.
  resolved.forEach(({ stockItem, qty }) => {
    stockItem.quantity -= qty;
  });
  db.items = db.items.filter((i) => i.quantity > 0);

  // Never persist raw card/UPI credentials — keep only a display-safe hint.
  let paymentSummary = null;
  if (paymentMethod === "upi" && paymentDetails && paymentDetails.upiId) {
    paymentSummary = String(paymentDetails.upiId).replace(/^(.{2}).*(@.*)$/, "$1***$2");
  } else if (paymentMethod === "card" && paymentDetails && paymentDetails.last4) {
    paymentSummary = `Card ending ${String(paymentDetails.last4).slice(-4)}`;
  } else if (paymentMethod === "cod") {
    paymentSummary = "Cash on delivery";
  }

  const order = {
    id: db.nextOrderId++,
    userId: req.user.id,
    userName: req.user.name,
    items: orderItems,
    paymentMethod,
    paymentSummary,
    total,
    deliveryAddress: {
      label: deliveryAddress.label || "",
      line1: deliveryAddress.line1,
      city: deliveryAddress.city,
      state: deliveryAddress.state || "",
      pincode: deliveryAddress.pincode || "",
      phone: deliveryAddress.phone || "",
    },
    placedAt: new Date().toISOString(),
  };
  db.orders.push(order);
  writeDB(db);
  res.status(201).json(order);
});

app.get("/api/orders", requireAuth, requireRole("user"), (req, res) => {
  const orders = req.db.orders
    .filter((o) => o.userId === req.user.id)
    .sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
  res.json({ count: orders.length, orders });
});

// An Executive sees every order placed by every customer, in full. An Admin
// only sees the orders that include at least one of THEIR items — and only
// the lines (and totals) that came from their own stock, not another
// Admin's, so two Admins never see each other's sales figures.
app.get("/api/orders/all", requireAuth, requireRole("sales", "executive"), (req, res) => {
  let orders = [...req.db.orders].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
  if (req.user.role === "sales") {
    orders = orders
      .map((o) => {
        const mine = o.items.filter((l) => l.addedByUserId === req.user.id);
        if (mine.length === 0) return null;
        return { ...o, items: mine, total: +mine.reduce((s, l) => s + l.lineTotal, 0).toFixed(0) };
      })
      .filter(Boolean);
  }
  res.json({ count: orders.length, orders });
});

/* ---------------------------- dashboards / overview ---------------------------- */

// An Admin's overview is scoped to only the stock and order-lines THEY added —
// two different Admin logins never see each other's numbers.
app.get("/api/overview/sales", requireAuth, requireRole("sales"), (req, res) => {
  const db = req.db;
  const myItems = db.items.filter((i) => i.addedByUserId === req.user.id);
  const computed = myItems.map(computeItem);

  const myLines = [];
  db.orders.forEach((o) => o.items.forEach((l) => { if (l.addedByUserId === req.user.id) myLines.push(l); }));
  const ordersWithMine = new Set();
  db.orders.forEach((o) => { if (o.items.some((l) => l.addedByUserId === req.user.id)) ordersWithMine.add(o.id); });

  const totalOrders = ordersWithMine.size;
  const revenue = +myLines.reduce((sum, l) => sum + l.lineTotal, 0).toFixed(0);
  const moneySaved = +myLines.reduce((sum, l) => sum + (l.originalPriceEach - l.priceEach) * l.qty, 0).toFixed(0);
  const pendingApprovals = computed.filter((i) => i.offer_pending).length;

  const expiryRisk = { safe: 0, soon: 0, urgent: 0, expiresToday: 0, expired: 0 };
  computed.forEach((i) => {
    if (i.status === "expired") expiryRisk.expired++;
    else if (i.days_remaining === 0) expiryRisk.expiresToday++;
    else if (i.status === "urgent") expiryRisk.urgent++;
    else if (i.status === "soon") expiryRisk.soon++;
    else expiryRisk.safe++;
  });

  const lowStock = myItems
    .filter((i) => i.quantity > 0 && i.quantity <= 3)
    .map((i) => ({ id: i.id, name: i.name, quantity: i.quantity }))
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 8);

  const categoryTotals = {};
  myLines.forEach((l) => { categoryTotals[l.category || "Other"] = (categoryTotals[l.category || "Other"] || 0) + l.qty; });
  const topCategories = Object.entries(categoryTotals)
    .map(([category, sold]) => ({ category, sold }))
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 6);

  res.json({ totalOrders, revenue, moneySaved, pendingApprovals, expiryRisk, lowStock, topCategories });
});

// An Executive's overview is the same shape, but aggregated across every
// Admin's stock and every order, plus a headcount of the accounts they oversee.
app.get("/api/overview/executive", requireAuth, requireRole("executive"), (req, res) => {
  const db = req.db;
  const computed = db.items.map(computeItem);

  const totalOrders = db.orders.length;
  const revenue = +db.orders.reduce((sum, o) => sum + o.total, 0).toFixed(0);
  const moneySaved = +db.orders.reduce(
    (sum, o) => sum + o.items.reduce((s, l) => s + (l.originalPriceEach - l.priceEach) * l.qty, 0),
    0
  ).toFixed(0);
  const pendingApprovals = computed.filter((i) => i.offer_pending).length;

  const expiryRisk = { safe: 0, soon: 0, urgent: 0, expiresToday: 0, expired: 0 };
  computed.forEach((i) => {
    if (i.status === "expired") expiryRisk.expired++;
    else if (i.days_remaining === 0) expiryRisk.expiresToday++;
    else if (i.status === "urgent") expiryRisk.urgent++;
    else if (i.status === "soon") expiryRisk.soon++;
    else expiryRisk.safe++;
  });

  const lowStock = db.items
    .filter((i) => i.quantity > 0 && i.quantity <= 3)
    .map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, addedByName: i.addedByName }))
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 8);

  const categoryTotals = {};
  db.orders.forEach((o) => o.items.forEach((l) => {
    categoryTotals[l.category || "Other"] = (categoryTotals[l.category || "Other"] || 0) + l.qty;
  }));
  const topCategories = Object.entries(categoryTotals)
    .map(([category, sold]) => ({ category, sold }))
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 6);

  const totalAdmins = db.users.filter((u) => u.role === "sales").length;
  const totalCustomers = db.users.filter((u) => u.role === "user").length;

  res.json({ totalOrders, revenue, moneySaved, pendingApprovals, expiryRisk, lowStock, topCategories, totalAdmins, totalCustomers });
});

// Executive-only account oversight: every Admin, with how much stock they've
// personally added and how many of their offers are awaiting a decision.
app.get("/api/admins", requireAuth, requireRole("executive"), (req, res) => {
  const db = req.db;
  const admins = db.users
    .filter((u) => u.role === "sales")
    .map((u) => {
      const items = db.items.filter((i) => i.addedByUserId === u.id);
      const pendingApprovals = items.map(computeItem).filter((i) => i.offer_pending).length;
      return { id: u.id, name: u.name, email: u.email, phone: u.phone || "", itemCount: items.length, pendingApprovals };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ count: admins.length, admins });
});

// Executive-only account oversight: every Customer, with their order history at a glance.
app.get("/api/customers", requireAuth, requireRole("executive"), (req, res) => {
  const db = req.db;
  const customers = db.users
    .filter((u) => u.role === "user")
    .map((u) => {
      const orders = db.orders.filter((o) => o.userId === u.id);
      const totalSpent = +orders.reduce((sum, o) => sum + o.total, 0).toFixed(0);
      return { id: u.id, name: u.name, email: u.email, phone: u.phone || "", orderCount: orders.length, totalSpent };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ count: customers.length, customers });
});

// Executive creates the login for a new Admin or Customer directly — this is
// how an Executive "handles" onboarding instead of people self-registering.
app.post("/api/accounts", requireAuth, requireRole("executive"), (req, res) => {
  const { name, email, password, phone, role } = req.body || {};
  if (role !== "sales" && role !== "user") {
    return res.status(400).json({ error: "An Executive can only create Admin or Customer accounts." });
  }
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: "Enter a name, a valid email, and a password of at least 6 characters." });
  }
  if (!phone || !/^\+?[\d\s-]{7,15}$/.test(String(phone).trim())) {
    return res.status(400).json({ error: "Enter a valid mobile number — it's needed for the account's login OTP." });
  }
  const db = req.db;
  const normEmail = email.trim().toLowerCase();
  if (db.users.some((u) => u.email === normEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  const user = {
    id: db.nextUserId++,
    name: name.trim(),
    email: normEmail,
    passwordHash: hashPassword(password),
    token: null,
    role,
    phone: String(phone).trim(),
    addresses: [],
  };
  db.users.push(user);
  writeDB(db);
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone });
});

// Executive resets the password for any Admin or Customer login (e.g. if they
// forgot it and don't want to use the self-serve "forgot password" flow).
// This signs the account out everywhere by clearing its session token.
app.post("/api/accounts/:id/reset-password", requireAuth, requireRole("executive"), (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "Enter a new password of at least 6 characters." });
  }
  const db = req.db;
  const account = db.users.find((u) => u.id === Number(req.params.id) && (u.role === "sales" || u.role === "user"));
  if (!account) return res.status(404).json({ error: "Account not found." });
  account.passwordHash = hashPassword(newPassword);
  account.token = null;
  writeDB(db);
  res.json({ message: `Password reset for ${account.name} (${account.email}).` });
});

// Executive removes an Admin or Customer login entirely. An Admin's own stock
// stays in the catalog (so Customers don't lose access to it), just orphaned.
app.delete("/api/accounts/:id", requireAuth, requireRole("executive"), (req, res) => {
  const db = req.db;
  const account = db.users.find((u) => u.id === Number(req.params.id) && (u.role === "sales" || u.role === "user"));
  if (!account) return res.status(404).json({ error: "Account not found." });
  db.users = db.users.filter((u) => u.id !== account.id);
  writeDB(db);
  res.json({ message: `${ROLE_LABELS[account.role]} account removed.` });
});

app.get("/api/overview/user", requireAuth, requireRole("user"), (req, res) => {
  const myOrders = req.db.orders.filter((o) => o.userId === req.user.id);
  const totalOrders = myOrders.length;
  const totalSpent = +myOrders.reduce((sum, o) => sum + o.total, 0).toFixed(0);
  const totalSaved = +myOrders.reduce(
    (sum, o) => sum + o.items.reduce((s, l) => s + (l.originalPriceEach - l.priceEach) * l.qty, 0),
    0
  ).toFixed(0);
  const recentOrders = [...myOrders].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt)).slice(0, 5);
  res.json({ totalOrders, totalSpent, totalSaved, recentOrders });
});

// Anything else falling through to here is either an unknown API route, or a
// page request that express.static above didn't already serve (which means
// frontend/index.html wasn't found next to backend/ — usually a deploy
// mis-configuration). Explain that clearly instead of a bare "Cannot GET /".
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found." });
  }
  const indexPath = path.join(FRONTEND_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.status(500).type("text/plain").send(
    "SmartShelf couldn't find the frontend to serve.\n\n" +
    `Looked for: ${indexPath}\n\n` +
    "This almost always means only the \"backend\" folder was deployed, not " +
    "both \"frontend\" and \"backend\" as sibling folders. Check that your " +
    "Git repository has both folders at the same level, and that your host's " +
    "\"Root Directory\" setting (if any) is the folder that CONTAINS both " +
    "\"backend\" and \"frontend\" (leave it blank for the repo root) — NOT " +
    "\"backend\" alone."
  );
});

// Last-resort error handler: ALWAYS answer API errors with JSON (never an
// HTML error page or an empty body), so the browser can show a real message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`\n[error] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  const status = err && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 600 ? (err.status || err.statusCode) : 500;
  const message = err && err.type === "entity.parse.failed"
    ? "The request body wasn't valid JSON."
    : err && err.type === "entity.too.large"
    ? "That upload is too large (max 8 MB)."
    : "Something went wrong on the server. Check the terminal running `npm start` for details.";
  res.status(status).json({ error: message });
});

// Everything below runs inside startServer() so the database (Postgres, if
// DATABASE_URL is set) is loaded BEFORE the first request is accepted.
async function startServer() {
  await initDB();
  console.log(usingMongo ? "[db] Storage: MongoDB (MONGODB_URI)" : usingPostgres ? "[db] Storage: Postgres (DATABASE_URL)" : "[db] Storage: local db.json file");

  if (process.env.PORT && !usingRemote && !process.env.DB_PATH) {
    console.warn("\n⚠️  =====================================================================");
    console.warn("⚠️  Data is NOT being saved permanently: no MONGODB_URI / DATABASE_URL is set.");
    console.warn("⚠️  Everything will be erased the next time this server restarts or redeploys.");
    console.warn("⚠️  Add MONGODB_URI in the Render Environment tab (see README).");
    console.warn("⚠️  =====================================================================\n");
  }

  // Save the last change before the host stops/restarts this process.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => { await flushDB(); process.exit(0); });
  }

  // HTTP + HTTPS both start automatically when running on your own computer,
  // bound to 0.0.0.0 (every network interface, not just localhost) — this is
  // what lets your phone reach the server at all, and lets it be opened
  // securely (needed for the Admin camera barcode scanner; mobile browsers
  // block camera access on plain http:// from anything other than localhost).
  // The HTTPS certificate is generated fresh on every startup (certs.js).
  //
  // On a real host (Render, Railway, Heroku, etc.) none of that applies: the
  // platform assigns PORT itself, already terminates real HTTPS for you at
  // its own edge, and "LAN IP" is meaningless inside its container — so this
  // is skipped there and a normal, single HTTP server is started instead.
  const IS_HOSTED = !!process.env.PORT; // hosting platforms set PORT for you; local `npm start` doesn't

  let qrcode = null;
  try { qrcode = require("qrcode-terminal"); } catch { /* optional — QR code just won't print */ }

  let httpsReady = false;
  let getLanIPs = () => [];
  let HTTPS_PORT;

  if (!IS_HOSTED) {
    const https = require("https");
    const certs = require("./certs");
    getLanIPs = certs.lanIPs;
    HTTPS_PORT = process.env.HTTPS_PORT || 4443;
    try {
      const { key, cert } = certs.ensureCert();
      const httpsServer = https.createServer({ key, cert }, app);
      httpsServer.on("error", (err) => console.warn(`\nHTTPS server couldn't start (${err.message}) — HTTP still works fine below.`));
      httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => { httpsReady = true; });
    } catch (err) {
      console.warn(`\nCouldn't generate an HTTPS certificate (${err.message}) — HTTP still works fine below.`);
    }
  }

  const mainServer = app.listen(PORT, "0.0.0.0", () => {
    const frontendFound = fs.existsSync(path.join(FRONTEND_DIR, "index.html"));

    if (IS_HOSTED) {
      const publicUrl = process.env.RENDER_EXTERNAL_URL || null;
      console.log(`\nSmartShelf backend is running on port ${PORT}.`);
      if (publicUrl) console.log(`Public URL: ${publicUrl}`);
    } else {
      const lanIPs = getLanIPs();
      const primaryIP = lanIPs[0];

      console.log(`\nSmartShelf backend is running — reachable from this computer AND from`);
      console.log(`any phone/tablet on the same WiFi network (no "localhost" needed on those):\n`);
      console.log(`  This computer only:   http://localhost:${PORT}`);
      if (lanIPs.length) {
        lanIPs.forEach((ip) => console.log(`  PC or phone (WiFi):    http://${ip}:${PORT}`));
        if (httpsReady) {
          lanIPs.forEach((ip) => console.log(`  PC or phone, HTTPS:    https://${ip}:${HTTPS_PORT}  ← use this one for the camera scanner`));
        }
      } else {
        console.log(`  Couldn't detect a LAN IP automatically — run "ipconfig" (Windows) or`);
        console.log(`  "ifconfig"/"ip addr" (Mac/Linux) and use that IP instead of "localhost".`);
      }

      if (httpsReady) {
        console.log(`\n  Your browser will warn the HTTPS certificate isn't "trusted" — that's`);
        console.log(`  expected for a self-signed one made just for your network. Tap`);
        console.log(`  Advanced → Proceed (wording varies by browser) to continue.`);
        if (qrcode && primaryIP) {
          console.log(`\n  Scan this on your phone to open it instantly:\n`);
          qrcode.generate(`https://${primaryIP}:${HTTPS_PORT}`, { small: true });
        }
      }
    }

    if (frontendFound) {
      console.log(`\n  ✅ Frontend found at ${FRONTEND_DIR} — the app will load normally.`);
    } else {
      console.log(`\n  ⚠️  Frontend NOT found at ${FRONTEND_DIR} — visiting the site will show`);
      console.log(`      an error page. Make sure "frontend" and "backend" were deployed as`);
      console.log(`      sibling folders (not just "backend" on its own).`);
    }
    console.log("");
  });

  mainServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ Port ${PORT} is already in use — something else (often an earlier`);
      console.error(`   background copy of this same app) is already listening there.\n`);
      console.error(`   Run:  npm run stop`);
      console.error(`   ...then try again. If that doesn't help, another program on this`);
      console.error(`   computer is using port ${PORT} — close it, or set a different port:`);
      console.error(`   Windows (PowerShell):  $env:PORT=4001; npm start`);
      console.error(`   Mac/Linux:              PORT=4001 npm start\n`);
    } else {
      console.error(`\n❌ Server failed to start: ${err.message}\n`);
    }
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error("\n❌ SmartShelf could not start:", err.message);
  if (usingMongo) console.error("   Check that MONGODB_URI is correct, the password is URL-encoded, and Atlas Network Access allows 0.0.0.0/0.");
  else if (usingPostgres) console.error("   Check that DATABASE_URL is correct and the database is reachable.");
  process.exit(1);
});
