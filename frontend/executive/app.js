// The SmartShelf Node server serves this page AND the API from one origin, so
// API calls are same-origin by default. If the page is opened some other way
// (VS Code "Live Server" on :5500, a plain file:// double-click, a stale tab, ...)
// there is no API at that address and POSTs come back empty — which used to
// crash with "Unexpected end of JSON input". So we probe /api/health once at
// startup and, if it isn't answered with JSON, fall back to the local backend.
// To deploy the frontend separately from the backend, set
// window.SMARTSHELF_API_BASE = "https://api.example.com" before this script loads.
const BACKEND_FALLBACK = "http://localhost:4000";
function detectApiBase() {
  if (window.SMARTSHELF_API_BASE) return window.SMARTSHELF_API_BASE;
  if (location.protocol === "file:") return BACKEND_FALLBACK;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/health", false);
    xhr.send();
    if (xhr.status === 200 && /json/i.test(xhr.getResponseHeader("Content-Type") || "")) return "";
  } catch { /* fall through to the fallback */ }
  return BACKEND_FALLBACK;
}
let API = detectApiBase();

const SERVER_HINT = "Make sure the SmartShelf server is running (run `npm start` in the backend folder) and open http://localhost:4000";

// Turn "Failed to fetch" / connection-refused into a message people can act on.
const _nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  try {
    return await _nativeFetch(...args);
  } catch (err) {
    throw new Error(`Can't reach the SmartShelf server. ${SERVER_HINT}`);
  }
};

// Safe replacement for res.json(): never throws on an empty or non-JSON body.
// A failed request with no usable body becomes { error: "<helpful message>" }.
async function readJson(res) {
  let text = "";
  try { text = await res.text(); } catch { /* treat as empty */ }
  if (text.trim()) {
    try { return JSON.parse(text); } catch { /* not JSON — handled below */ }
  }
  if (res.ok && !text.trim()) return {};
  return { error: `The server sent an empty or unexpected reply (HTTP ${res.status}). ${SERVER_HINT}` };
}
// Each page (/admin/, /customer/, /executive/) keeps its OWN login in the browser,
// so logging in on one never shows up on — or logs you out of — another.
const PAGE_ROLE = window.SMARTSHELF_PRESET_ROLE || null;
const KEY_PREFIX = PAGE_ROLE ? `smartshelf_${PAGE_ROLE}_` : "smartshelf_";
let TOKEN = localStorage.getItem(KEY_PREFIX + "token") || null;
let USER_NAME = localStorage.getItem(KEY_PREFIX + "name") || "";
let ROLE = localStorage.getItem(KEY_PREFIX + "role") || null; // "sales" | "user"
let selectedRole = null; // role chosen on the role-picker screen (pre-login)
let ITEMS = [];
let statusFilter = "all";
let viewMode = "all"; // "all" | "offers" — the User-side offer-zone taskbar
let categoryFilter = "all"; // category chip filter on the Customer shop dashboard
let shopSearchQuery = ""; // free-text search on the Customer shop dashboard
let barcodeMatch = null;
let zxingReader = null;
let cameraStream = null;
let manualPhotoData = null; // base64 photo attached in the manual "Add item" tab
let pendingOtp = null; // { otpToken, channels, maskedEmail, maskedPhone, demoEmailOtp, demoPhoneOtp }

/* -------- sales expiry alarm -------- */
let alarmPollTimer = null;
let alarmMuted = localStorage.getItem(KEY_PREFIX + "alarm_muted") === "1";
let alarmDismissed = false;
let previousAlarmCount = 0;

/* -------- user cart -------- */
let CART = JSON.parse(localStorage.getItem(KEY_PREFIX + "cart") || "[]");

/* -------- profile / dashboards -------- */
let ME = null;

const el = (id) => document.getElementById(id);
// "sales" (Admin) and "executive" both use the salesScreen dashboard shell —
// this just distinguishes that shared UI from the Customer ("user") screen.
function isAdminLike() { return ROLE === "sales" || ROLE === "executive"; }
const CATEGORY_ICON = {
  Fruits: "🍎", Vegetables: "🥦",
  Dairy: "🥛", Bakery: "🍞", Staples: "🌾", Beverages: "🧃", Biscuits: "🍪",
  "Cooking Oil": "🫒", "Instant Food": "🍜", Breakfast: "🥣", Snacks: "🥔",
  Confectionery: "🍫", Spreads: "🍯", Other: "🛒",
};

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ======================= ROLE PICKER ======================= */
// Admin, Customer, and Executive each get their own real, bookmarkable login
// page — /admin, /customer, /executive — rather than three buttons toggling
// one shared screen. The links in the HTML navigate there directly; this map
// is what lets each of those URLs land straight on its own login form
// instead of the role-picker.
const PATH_ROLE = { "/admin": "sales", "/customer": "user", "/executive": "executive" };

const ROLE_META = {
  sales: { emoji: "🧑‍💼", title: "Admin", sub: "Add stock via barcode or manual entry" },
  user: { emoji: "🛒", title: "Customer", sub: "Browse items & freshness status" },
  executive: { emoji: "🧑‍💻", title: "Executive", sub: "Oversee every Admin & Customer account" },
};

function showAuth(role) {
  selectedRole = role;
  el("roleScreen").classList.add("hidden");
  el("authScreen").classList.remove("hidden");
  const meta = ROLE_META[role] || ROLE_META.user;
  el("authRoleEmoji").textContent = meta.emoji;
  el("authRoleTitle").textContent = meta.title;
  el("authRoleSub").textContent = meta.sub;
}

/* ======================= AUTH TAB SWITCH ======================= */
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const isLogin = tab.dataset.tab === "login";
    el("loginForm").classList.toggle("hidden", !isLogin);
    el("registerForm").classList.toggle("hidden", isLogin);
  };
});

/* ======================= LOGIN / REGISTER ======================= */
function completeLogin(data) {
  TOKEN = data.token; USER_NAME = data.name; ROLE = data.role;
  localStorage.setItem(KEY_PREFIX + "token", TOKEN);
  localStorage.setItem(KEY_PREFIX + "name", USER_NAME);
  localStorage.setItem(KEY_PREFIX + "role", ROLE);
  enterApp();
}

el("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  el("loginError").textContent = "";
  try {
    const res = await fetch(`${API}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: el("loginEmail").value, password: el("loginPassword").value, role: selectedRole }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Login failed.");
    if (data.requiresOtp) {
      pendingOtp = {
        otpToken: data.otpToken, channels: data.channels,
        maskedEmail: data.maskedEmail, maskedPhone: data.maskedPhone,
        demoEmailOtp: data.demoEmailOtp, demoPhoneOtp: data.demoPhoneOtp,
      };
      showOtpScreen();
      return;
    }
    completeLogin(data);
  } catch (err) {
    el("loginError").textContent = err.message;
  }
};

el("registerForm").onsubmit = async (e) => {
  e.preventDefault();
  el("registerError").textContent = ""; el("registerSuccess").textContent = "";
  try {
    const res = await fetch(`${API}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: el("regName").value, email: el("regEmail").value, phone: el("regPhone").value, password: el("regPassword").value, role: selectedRole }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not create account.");
    el("registerSuccess").textContent = "Account created! Switching to login…";
    setTimeout(() => document.querySelector('.auth-tab[data-tab="login"]').click(), 900);
    e.target.reset();
  } catch (err) {
    el("registerError").textContent = err.message;
  }
};

/* ======================= OTP VERIFICATION (login step 2) ======================= */
function otpDemoHintText() {
  return pendingOtp.channels.includes("email")
    ? `Demo mode — no real email/SMS gateway is connected. Email OTP: ${pendingOtp.demoEmailOtp} · Mobile OTP: ${pendingOtp.demoPhoneOtp}`
    : `Demo mode — no real SMS gateway is connected. Mobile OTP: ${pendingOtp.demoPhoneOtp}`;
}

function showOtpScreen() {
  el("authScreen").classList.add("hidden");
  el("otpScreen").classList.remove("hidden");
  el("otpForm").reset();
  el("otpError").textContent = ""; el("otpSuccess").textContent = "";
  const needsEmail = pendingOtp.channels.includes("email");
  el("otpEmailLabel").classList.toggle("hidden", !needsEmail);
  el("otpEmailInput").required = needsEmail;
  el("otpRoleEmoji").textContent = (ROLE_META[selectedRole] || ROLE_META.user).emoji;
  el("otpSub").textContent = needsEmail
    ? `Enter the OTP sent to ${pendingOtp.maskedEmail} and to ${pendingOtp.maskedPhone}.`
    : `Enter the OTP sent to ${pendingOtp.maskedPhone}.`;
  el("otpDemoHint").textContent = otpDemoHintText();
}

el("otpBackBtn").onclick = () => {
  pendingOtp = null;
  el("otpScreen").classList.add("hidden");
  el("authScreen").classList.remove("hidden");
};

el("otpForm").onsubmit = async (e) => {
  e.preventDefault();
  el("otpError").textContent = "";
  if (!pendingOtp) return;
  try {
    const body = { otpToken: pendingOtp.otpToken, phoneOtp: el("otpPhoneInput").value.trim() };
    if (pendingOtp.channels.includes("email")) body.emailOtp = el("otpEmailInput").value.trim();
    const res = await fetch(`${API}/api/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not verify OTP.");
    const finish = data;
    pendingOtp = null;
    el("otpScreen").classList.add("hidden");
    completeLogin(finish);
  } catch (err) {
    el("otpError").textContent = err.message;
  }
};

el("resendOtpBtn").onclick = async () => {
  if (!pendingOtp) return;
  el("otpError").textContent = ""; el("otpSuccess").textContent = "";
  try {
    const res = await fetch(`${API}/api/resend-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otpToken: pendingOtp.otpToken }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not resend OTP.");
    pendingOtp.demoEmailOtp = data.demoEmailOtp;
    pendingOtp.demoPhoneOtp = data.demoPhoneOtp;
    el("otpDemoHint").textContent = otpDemoHintText();
    el("otpSuccess").textContent = "A new OTP has been sent.";
  } catch (err) {
    el("otpError").textContent = err.message;
  }
};

/* ======================= FORGOT PASSWORD ======================= */
el("forgotPasswordLink").onclick = () => {
  el("forgotForm").reset();
  el("forgotError").textContent = ""; el("forgotSuccess").textContent = "";
  el("forgotRoleHint").textContent = `Resetting the password for your ${(ROLE_META[selectedRole] || ROLE_META.user).title} account.`;
  el("forgotOverlay").classList.remove("hidden");
};
el("closeForgotModal").onclick = () => el("forgotOverlay").classList.add("hidden");
el("forgotOverlay").addEventListener("click", (e) => { if (e.target === el("forgotOverlay")) el("forgotOverlay").classList.add("hidden"); });

el("forgotForm").onsubmit = async (e) => {
  e.preventDefault();
  el("forgotError").textContent = ""; el("forgotSuccess").textContent = "";
  try {
    const res = await fetch(`${API}/api/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: el("forgotEmail").value, newPassword: el("forgotNewPassword").value, role: selectedRole }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not reset password.");
    el("forgotSuccess").textContent = "Password updated! You can log in now.";
    setTimeout(() => el("forgotOverlay").classList.add("hidden"), 1200);
  } catch (err) {
    el("forgotError").textContent = err.message;
  }
};

// After logging out (or if a session expires) while on a role-specific URL
// like /admin, go back to THAT role's own login page rather than the generic
// picker — each role's login lives at its own page, so this just reopens it.
function backToLoginForThisPage() {
  const presetRole = window.SMARTSHELF_PRESET_ROLE || PATH_ROLE[location.pathname];
  if (presetRole) {
    showAuth(presetRole);
  } else {
    el("roleScreen").classList.remove("hidden");
  }
}

function doLogout() {
  fetch(`${API}/api/logout`, { method: "POST", headers: authHeaders() }).catch(() => {});
  TOKEN = null; ROLE = null; ME = null; pendingOtp = null;
  localStorage.removeItem(KEY_PREFIX + "token");
  localStorage.removeItem(KEY_PREFIX + "name");
  localStorage.removeItem(KEY_PREFIX + "role");
  stopAlarmPolling();
  el("salesScreen").classList.add("hidden");
  el("userScreen").classList.add("hidden");
  el("authScreen").classList.add("hidden");
  el("otpScreen").classList.add("hidden");
  backToLoginForThisPage();
}
el("salesLogoutBtn").onclick = doLogout;
el("userLogoutBtn").onclick = doLogout;

/* ======================= ENTER APP ======================= */
async function enterApp() {
  el("roleScreen").classList.add("hidden");
  el("authScreen").classList.add("hidden");
  await loadMe();
  if (isAdminLike()) {
    el("salesScreen").classList.remove("hidden");
    el("salesGreeting").textContent = `Hi, ${USER_NAME} 👋`;
    const meta = ROLE_META[ROLE] || ROLE_META.sales;
    el("salesRoleEmoji").textContent = meta.emoji;
    el("salesRoleFlag").textContent = meta.title;
    el("salesProfileRole").textContent = meta.title;
    const isExecutive = ROLE === "executive";
    // Only Admins add stock — an Executive oversees, but doesn't upload items.
    el("sidebarAddItemBtn").classList.toggle("hidden", isExecutive);
    el("openAddModal").classList.toggle("hidden", isExecutive);
    el("accountsNavBtn").classList.toggle("hidden", !isExecutive);
    el("stockPanelSub").textContent = isExecutive
      ? "Stock from every Admin, in one place. Editing or removing an item here affects that Admin's shelf."
      : "Items you add here become visible to all Customers automatically. Other Admins can't see or edit your stock.";
    await loadCategories();
    await refreshAll();
    startAlarmPolling();
    switchSalesTab("overview");
  } else {
    el("userScreen").classList.remove("hidden");
    el("userGreeting").textContent = `Hi, ${USER_NAME} 👋`;
    await refreshAll();
    updateCartBadge();
    switchUserTab("shop");
  }
}

async function loadMe() {
  try {
    const res = await fetch(`${API}/api/me`, { headers: authHeaders() });
    if (res.status === 401) return handleAuthExpired();
    ME = await readJson(res);
  } catch {}
}

async function loadCategories() {
  try {
    const res = await fetch(`${API}/api/categories`);
    const cats = await readJson(res);
    el("fCategory").innerHTML = cats.map((c) => `<option value="${c}">${c}</option>`).join("");
    buildCategoryChips(cats);
  } catch {}
}

function buildCategoryChips(cats) {
  const container = el("userCategoryChips");
  if (!container) return;
  const chips = [{ key: "all", label: "🛒 All categories" }].concat(
    cats.map((c) => ({ key: c, label: `${CATEGORY_ICON[c] || "🛒"} ${c}` }))
  );
  container.innerHTML = chips
    .map((c) => `<button class="category-chip ${categoryFilter === c.key ? "active" : ""}" data-cat="${escapeHtml(c.key)}">${c.label}</button>`)
    .join("");
  container.querySelectorAll(".category-chip").forEach((btn) => {
    btn.onclick = () => {
      categoryFilter = btn.dataset.cat;
      buildCategoryChips(cats);
      renderGrid();
    };
  });
}

async function refreshAll() {
  await Promise.all([loadItems(), loadSummary()]);
}

function handleAuthExpired() {
  stopAlarmPolling();
  el("salesScreen").classList.add("hidden");
  el("userScreen").classList.add("hidden");
  backToLoginForThisPage();
}

async function loadSummary() {
  const res = await fetch(`${API}/api/summary`, { headers: authHeaders() });
  if (res.status === 401) return handleAuthExpired();
  const s = await readJson(res);
  const chipsHtml = `
    <span class="chip">🟢 ${s.safe} fresh</span>
    <span class="chip">🟠 ${s.soon} soon</span>
    <span class="chip">🔴 ${s.urgent} urgent</span>
    ${s.expired ? `<span class="chip">⚪ ${s.expired} expired</span>` : ""}`;
  if (isAdminLike()) { el("salesSummaryChips").innerHTML = chipsHtml; buildStatusFilters(s, "salesStatusFilters"); }
  else { el("userSummaryChips").innerHTML = chipsHtml; buildStatusFilters(s, "userStatusFilters"); }
}

function buildStatusFilters(s, targetId) {
  const defs = [
    { key: "all", label: `All (${s.total})` },
    { key: "safe", label: `Fresh (${s.safe})` },
    { key: "soon", label: `Expiring soon (${s.soon})` },
    { key: "urgent", label: `Urgent (${s.urgent})` },
  ];
  if (s.expired) defs.push({ key: "expired", label: `Expired (${s.expired})` });
  const container = el(targetId);
  container.innerHTML = defs.map((d) => `<button class="status-filter-chip ${statusFilter === d.key ? "active" : ""}" data-status="${d.key}">${d.label}</button>`).join("");
  container.querySelectorAll(".status-filter-chip").forEach((btn) => {
    btn.onclick = () => { statusFilter = btn.dataset.status; renderGrid(); buildStatusFilters(s, targetId); };
  });
}

async function loadItems() {
  const res = await fetch(`${API}/api/items`, { headers: authHeaders() });
  if (res.status === 401) return handleAuthExpired();
  const data = await readJson(res);
  ITEMS = data.items;
  renderGrid();
}

function renderCard(p) {
  const icon = CATEGORY_ICON[p.category] || "🛒";
  const ribbon = p.ribbon ? `<span class="ribbon-tag ${p.status}">${p.ribbon}</span>` : "";
  const discountBadge = p.discount_pct ? `<span class="sale-badge">${p.discount_pct}% OFF</span>` : "";
  const priceLine = p.price_was
    ? `<span class="price-now">₹${p.price_now}</span><span class="price-was">₹${p.price_was}</span>${discountBadge}`
    : `<span class="price-now">₹${p.price_now || 0}</span>`;
  const daysLabel = p.status === "expired" ? "expired" : p.days_remaining <= 0 ? "expires today" : `${p.days_remaining}d left`;
  const photoBlock = p.photo ? `<img class="card-photo" src="${p.photo}" alt="${escapeHtml(p.name)}">` : "";
  const topRow = `<div class="card-top">${p.photo ? "" : `<span class="card-icon">${icon}</span>`}${ribbon}</div>`;

  let actions = "";
  if (isAdminLike()) {
    actions = `<div class="card-actions"><button class="icon-btn" data-edit="${p.id}">✏️ Edit</button><button class="icon-btn danger" data-delete="${p.id}">Remove</button></div>`;
  } else {
    const disabled = p.status === "expired" || p.quantity < 1;
    const cartLine = CART.find((c) => c.id === p.id);
    if (cartLine && cartLine.qty > 0) {
      const atMax = cartLine.qty >= p.quantity;
      actions = `<div class="card-actions">
        <div class="qty-stepper card-qty-stepper">
          <button data-cardqtydec="${p.id}">−</button>
          <span>${cartLine.qty}</span>
          <button data-cardqtyinc="${p.id}" ${atMax ? "disabled" : ""}>+</button>
        </div>
      </div>`;
    } else {
      actions = `<div class="card-actions"><button class="icon-btn primary ${disabled ? "disabled" : ""}" data-addcart="${p.id}">🛍️ Add to cart</button></div>`;
    }
  }

  // Executive's flat grid mixes every Admin's stock together, so each card is
  // labelled inline. Customers instead see items grouped into sections by
  // Admin (see renderCardsOrGroups), so the per-card label isn't needed there.
  const ownerLine = ROLE === "executive" && p.addedByName ? ` · by ${escapeHtml(p.addedByName)}` : "";

  return `
    <div class="card status-${p.status}">
      ${photoBlock}
      ${topRow}
      <div class="card-body">
        <h4>${escapeHtml(p.name)}</h4>
        <div class="meta">${escapeHtml(p.brand)} · ${escapeHtml(p.category)} · Qty ${p.quantity}${ownerLine}</div>
        <div class="price-line">${priceLine}</div>
        <div class="pill-row">
          <span class="pill days-${p.status}">${daysLabel}</span>
          <span class="pill">exp ${p.expiry}</span>
          <span class="pill">${p.source === "barcode" ? "📷 scanned" : "✏️ manual"}</span>
        </div>
        ${actions}
      </div>
    </div>`;
}

// Customers see stock grouped into a separate section per Admin (with that
// Admin's name as the section heading), so it's clear whose shelf each item
// comes from. Admins and the Executive keep a single flat grid.
function renderCardsOrGroups(list) {
  if (ROLE !== "user") return list.map(renderCard).join("");

  const groups = new Map();
  list.forEach((p) => {
    const key = p.addedByName || "Store";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  return names.map((name) => `
    <div class="admin-group">
      <h3 class="admin-group-title">🧑‍💼 ${escapeHtml(name)}<span class="admin-group-count">${groups.get(name).length} item${groups.get(name).length === 1 ? "" : "s"}</span></h3>
      <div class="admin-group-grid">${groups.get(name).map(renderCard).join("")}</div>
    </div>`).join("");
}

function renderGrid() {
  const gridId = isAdminLike() ? "salesGrid" : "userGrid";
  const grid = el(gridId);
  let list = ITEMS;
  if (ROLE === "user" && viewMode === "offers") list = list.filter((i) => i.discount_pct > 0);
  if (statusFilter !== "all") list = list.filter((i) => i.status === statusFilter);
  if (ROLE === "user" && categoryFilter !== "all") list = list.filter((i) => i.category === categoryFilter);
  if (ROLE === "user" && shopSearchQuery) {
    const q = shopSearchQuery.toLowerCase();
    list = list.filter((i) =>
      (i.name || "").toLowerCase().includes(q) ||
      (i.brand || "").toLowerCase().includes(q) ||
      (i.category || "").toLowerCase().includes(q)
    );
  }

  if (list.length === 0) {
    const offerEmpty = ROLE === "user" && viewMode === "offers";
    const searchEmpty = ROLE === "user" && (shopSearchQuery || categoryFilter !== "all");
    grid.innerHTML = `
      <div class="empty-state">
        <span class="emoji">${searchEmpty ? "🔍" : offerEmpty ? "🔥" : "🧺"}</span>
        <h3>${searchEmpty ? "No matching items" : offerEmpty ? "No offers right now" : ITEMS.length === 0 ? "No stock added yet" : "Nothing matches this filter"}</h3>
        <p>${searchEmpty
          ? "Try a different search term or category."
          : offerEmpty
          ? "Discounted items show up here automatically as they get close to expiry."
          : ITEMS.length === 0
            ? (ROLE === "sales" ? "Add your first item by scanning a barcode or entering it manually." : ROLE === "executive" ? "No Admin has added any stock yet." : "Check back once an Admin adds stock.")
            : "Try a different status filter."}</p>
      </div>`;
    return;
  }

  grid.innerHTML = renderCardsOrGroups(list);

  if (isAdminLike()) {
    grid.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Remove this item from stock?")) return;
        await fetch(`${API}/api/items/${btn.dataset.delete}`, { method: "DELETE", headers: authHeaders() });
        refreshAll();
      };
    });
    grid.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.onclick = () => {
        const item = ITEMS.find((i) => i.id === Number(btn.dataset.edit));
        if (item) openAddItemModal(item);
      };
    });
  } else {
    grid.querySelectorAll("[data-addcart]").forEach((btn) => {
      btn.onclick = () => addToCart(Number(btn.dataset.addcart));
    });
    grid.querySelectorAll("[data-cardqtyinc]").forEach((btn) => {
      btn.onclick = () => changeCartQty(Number(btn.dataset.cardqtyinc), 1);
    });
    grid.querySelectorAll("[data-cardqtydec]").forEach((btn) => {
      btn.onclick = () => changeCartQty(Number(btn.dataset.cardqtydec), -1);
    });
  }
}

/* ======================= USER — SEARCH BAR ======================= */
if (el("shopSearchInput")) {
  el("shopSearchInput").addEventListener("input", (e) => {
    shopSearchQuery = e.target.value.trim();
    renderGrid();
  });
}

/* ======================= USER — OFFER ZONE TASKBAR ======================= */
document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    viewMode = tab.dataset.view;
    renderGrid();
  };
});

/* ======================= ADD / EDIT ITEM MODAL (sales only) ======================= */
let editingItemId = null; // null = adding a new item, otherwise the id of the item being edited

function openAddItemModal(item) {
  editingItemId = item ? item.id : null;
  el("addModal").classList.remove("hidden");
  el("barcodeInput").value = "";
  el("barcodeResult").innerHTML = "";
  el("cameraResult").innerHTML = "";
  barcodeMatch = null;
  el("itemForm").reset();
  resetPhotoField();

  // Editing an existing item only makes sense via the manual-entry fields —
  // camera / barcode scanning is for adding brand-new stock.
  el("addModalTitle").textContent = item ? "Edit item" : "Add an item";
  el("addTabsRow").classList.toggle("hidden", !!item);
  el("cameraPane").classList.toggle("hidden", !!item);
  el("barcodePane").classList.toggle("hidden", !!item);
  el("manualPane").classList.remove("hidden");
  document.querySelectorAll(".add-tab").forEach((t) => t.classList.toggle("active", t.dataset.addtab === "manual"));
  el("itemFormSubmitBtn").textContent = item ? "Save changes" : "Add to stock";

  if (item) {
    stopCamera();
    el("fName").value = item.name || "";
    el("fBrand").value = item.brand || "";
    el("fCategory").value = item.category || "";
    el("fPrice").value = item.price || "";
    el("fQuantity").value = item.quantity || 1;
    el("fMfd").value = item.mfd || "";
    el("fExpiry").value = item.expiry || "";
    if (item.photo) {
      manualPhotoData = item.photo;
      el("fPhotoPreview").src = item.photo;
      el("fPhotoPreviewWrap").classList.remove("hidden");
    }
  } else {
    el("fQuantity").value = 1;
  }
}
el("openAddModal").onclick = () => openAddItemModal(null);
if (el("sidebarAddItemBtn")) el("sidebarAddItemBtn").onclick = () => openAddItemModal(null);

/* ---------- manual-entry item photo ---------- */
function resetPhotoField() {
  manualPhotoData = null;
  el("fPhoto").value = "";
  el("fPhotoPreview").src = "";
  el("fPhotoPreviewWrap").classList.add("hidden");
}
el("fPhoto").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) { alert("Please choose an image file."); resetPhotoField(); return; }
  if (file.size > 5 * 1024 * 1024) { alert("That photo is too large — please pick one under 5MB."); resetPhotoField(); return; }
  const reader = new FileReader();
  reader.onload = () => {
    manualPhotoData = reader.result;
    el("fPhotoPreview").src = manualPhotoData;
    el("fPhotoPreviewWrap").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});
el("fPhotoRemove").onclick = resetPhotoField;
el("closeAddModal").onclick = () => { stopCamera(); el("addModal").classList.add("hidden"); };
el("addModal").addEventListener("click", (e) => { if (e.target === el("addModal")) { stopCamera(); el("addModal").classList.add("hidden"); } });

document.querySelectorAll(".add-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".add-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.addtab;
    el("cameraPane").classList.toggle("hidden", target !== "camera");
    el("barcodePane").classList.toggle("hidden", target !== "barcode");
    el("manualPane").classList.toggle("hidden", target !== "manual");
    if (target !== "camera") stopCamera();
  };
});

/* ---------- camera barcode scanning (ZXing) ---------- */
el("startCameraBtn").onclick = async () => {
  el("cameraHint").textContent = "Requesting camera access…";
  // Mobile (and most desktop) browsers only allow camera access on a secure
  // origin — https://, or http://localhost on the same machine. Opened from
  // a phone via a plain http://<lan-ip> address, the camera is silently
  // blocked, which looks like a permission problem but isn't one — flag that
  // clearly instead of just saying "permission denied".
  if (!window.isSecureContext) {
    el("cameraHint").textContent = "This page isn't loaded over a secure connection (HTTPS), so phone browsers won't allow camera access here. Use ⌨️ Type barcode or ✏️ Manual entry instead — or see the README for a one-time step to enable HTTPS.";
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    el("cameraHint").textContent = "This browser doesn't support camera access. Use ⌨️ Type barcode or ✏️ Manual entry instead.";
    return;
  }
  try {
    if (!zxingReader) zxingReader = new ZXing.BrowserMultiFormatReader();
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    el("cameraVideo").srcObject = cameraStream;
    await el("cameraVideo").play();
    el("cameraHint").textContent = "Scanning… hold the barcode steady inside the frame.";
    zxingReader.decodeFromVideoElement(el("cameraVideo"), (result, err) => {
      if (result) handleScannedCode(result.getText());
    });
  } catch (err) {
    el("cameraHint").textContent = "Couldn't access the camera (permission denied or unsupported browser). Use ⌨️ Type barcode or ✏️ Manual entry instead.";
  }
};

function stopCamera() {
  if (zxingReader) { try { zxingReader.reset(); } catch {} }
  if (cameraStream) { cameraStream.getTracks().forEach((t) => t.stop()); cameraStream = null; }
}

async function handleScannedCode(code) {
  stopCamera();
  el("cameraHint").textContent = `Scanned: ${code}`;
  await lookupAndShow(code, "cameraResult");
}

/* ---------- typed barcode ---------- */
el("barcodeInput").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const code = el("barcodeInput").value.trim();
  if (code) await lookupAndShow(code, "barcodeResult");
});

async function lookupAndShow(code, resultElId) {
  const res = await fetch(`${API}/api/barcode/${encodeURIComponent(code)}`, { headers: authHeaders() });
  if (res.status === 401) return handleAuthExpired();
  const data = await readJson(res);
  const target = el(resultElId);

  if (res.ok) {
    barcodeMatch = { ...data, barcode: code };
    target.innerHTML = `
      <div class="barcode-hit">
        <h4>${escapeHtml(data.name)}</h4>
        <div class="meta" style="margin-bottom:10px;">${escapeHtml(data.brand)} · ${escapeHtml(data.category)} · ₹${data.price}</div>
        <label>Expiry date <span class="req">*</span><input type="date" id="${resultElId}_expiry" required></label>
        <label style="margin-top:8px;display:block;">Quantity<input type="number" id="${resultElId}_qty" min="1" value="1"></label>
        <button class="btn btn-primary btn-full" style="margin-top:12px;" id="${resultElId}_confirm">Add to stock</button>
      </div>`;
    el(`${resultElId}_confirm`).onclick = async () => {
      const expiry = el(`${resultElId}_expiry`).value;
      if (!expiry) { alert("Please set an expiry date."); return; }
      await addItem({
        name: barcodeMatch.name, brand: barcodeMatch.brand, category: barcodeMatch.category,
        barcode: barcodeMatch.barcode, price: barcodeMatch.price,
        quantity: el(`${resultElId}_qty`).value, expiry, source: "barcode",
      });
    };
  } else {
    barcodeMatch = null;
    target.innerHTML = `<div class="barcode-miss">${escapeHtml(data.error)} Switch to the "Manual entry" tab to add it.</div>`;
  }
}

/* ---------- manual entry (also used to save edits) ---------- */
el("itemForm").onsubmit = async (e) => {
  e.preventDefault();
  el("itemFormError").textContent = "";
  await addItem({
    name: el("fName").value, brand: el("fBrand").value, category: el("fCategory").value,
    price: el("fPrice").value, quantity: el("fQuantity").value, mfd: el("fMfd").value,
    expiry: el("fExpiry").value, source: "manual", photo: manualPhotoData,
  });
};

async function addItem(payload) {
  try {
    const url = editingItemId ? `${API}/api/items/${editingItemId}` : `${API}/api/items`;
    const method = editingItemId ? "PUT" : "POST";
    const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(payload) });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || (editingItemId ? "Could not save changes." : "Could not add item."));
    stopCamera();
    resetPhotoField();
    editingItemId = null;
    el("addModal").classList.add("hidden");
    refreshAll();
  } catch (err) {
    alert(err.message);
  }
}

/* ======================= SALES — EXPIRY ALARM ======================= */
function startAlarmPolling() {
  loadAlerts();
  if (alarmPollTimer) clearInterval(alarmPollTimer);
  alarmPollTimer = setInterval(loadAlerts, 45000);
  updateMuteIcon();
}
function stopAlarmPolling() {
  if (alarmPollTimer) clearInterval(alarmPollTimer);
  alarmPollTimer = null;
  previousAlarmCount = 0;
  alarmDismissed = false;
}

async function loadAlerts() {
  try {
    const res = await fetch(`${API}/api/alerts`, { headers: authHeaders() });
    if (res.status === 401) return handleAuthExpired();
    const data = await readJson(res);
    updateAlarmBanner(data.items || []);
  } catch {}
}

function updateAlarmBanner(items) {
  const banner = el("salesAlarmBanner");
  const stockBadge = el("stockNavBadge");
  stockBadge.textContent = items.length;
  stockBadge.classList.toggle("hidden", items.length === 0);
  if (items.length !== previousAlarmCount) alarmDismissed = false; // new situation — re-surface the banner
  if (items.length === 0) {
    banner.classList.add("hidden");
    previousAlarmCount = 0;
    return;
  }
  if (items.length > previousAlarmCount && !alarmMuted) playAlarmBeep();

  const names = items.slice(0, 3).map((i) => `${i.name} (${i.status === "expired" ? "expired" : i.days_remaining <= 0 ? "today" : i.days_remaining + "d left"})`);
  el("salesAlarmTitle").textContent = `${items.length} item${items.length > 1 ? "s" : ""} expiring soon — take action!`;
  el("salesAlarmDetail").textContent = names.join(", ") + (items.length > 3 ? ` +${items.length - 3} more` : "");

  previousAlarmCount = items.length;
  if (!alarmDismissed) banner.classList.remove("hidden");
}

function playAlarmBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [0, 220].forEach((delay) => {
      setTimeout(() => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
        o.start();
        o.stop(ctx.currentTime + 0.32);
      }, delay);
    });
  } catch {}
}

function updateMuteIcon() {
  el("alarmMuteBtn").textContent = alarmMuted ? "🔇" : "🔊";
}
el("alarmMuteBtn").onclick = () => {
  alarmMuted = !alarmMuted;
  localStorage.setItem(KEY_PREFIX + "alarm_muted", alarmMuted ? "1" : "0");
  updateMuteIcon();
};
el("alarmDismissBtn").onclick = () => {
  alarmDismissed = true;
  el("salesAlarmBanner").classList.add("hidden");
};

/* ======================= USER — CART ======================= */
function saveCart() {
  localStorage.setItem(KEY_PREFIX + "cart", JSON.stringify(CART));
  updateCartBadge();
}
function updateCartBadge() {
  const count = CART.reduce((sum, c) => sum + c.qty, 0);
  const badge = el("cartBadge");
  badge.textContent = count;
  badge.classList.toggle("hidden", count === 0);
}

function addToCart(id) {
  const item = ITEMS.find((i) => i.id === id);
  if (!item || item.quantity < 1 || item.status === "expired") return;
  const line = CART.find((c) => c.id === id);
  const have = line ? line.qty : 0;
  if (have >= item.quantity) { alert(`Only ${item.quantity} left in stock.`); return; }
  if (line) line.qty += 1; else CART.push({ id, qty: 1 });
  saveCart();
  renderGrid(); // swap the "Add to cart" button for the +/- stepper right away
}

function renderCart() {
  const body = el("cartBody");
  const footer = el("cartFooter");

  if (CART.length === 0) {
    body.innerHTML = `<div class="cart-empty"><span class="emoji">🛍️</span><h3>Your cart is empty</h3><p>Add items from the shop to see them here.</p></div>`;
    footer.classList.add("hidden");
    return;
  }

  let total = 0;
  body.innerHTML = CART.map((c) => {
    const item = ITEMS.find((i) => i.id === c.id);
    if (!item) {
      return `
        <div class="cart-line">
          <div class="cart-line-icon">⚠️</div>
          <div class="cart-line-info"><h5>No longer available</h5><div class="cart-line-price">This item was removed from stock.</div></div>
          <button class="cart-line-remove" data-cartremove="${c.id}">✕</button>
        </div>`;
    }
    const qty = Math.min(c.qty, item.quantity);
    total += item.price_now * qty;
    const thumb = item.photo
      ? `<img src="${item.photo}" alt="">`
      : `<div class="cart-line-icon">${CATEGORY_ICON[item.category] || "🛒"}</div>`;
    return `
      <div class="cart-line">
        ${thumb}
        <div class="cart-line-info">
          <h5>${escapeHtml(item.name)}</h5>
          <div class="cart-line-price">₹${item.price_now} × ${qty}</div>
        </div>
        <div class="qty-stepper">
          <button data-cartdec="${c.id}">−</button>
          <span>${qty}</span>
          <button data-cartinc="${c.id}" ${qty >= item.quantity ? "disabled" : ""}>+</button>
        </div>
        <button class="cart-line-remove" data-cartremove="${c.id}">✕</button>
      </div>`;
  }).join("");

  footer.classList.remove("hidden");
  el("cartTotalAmount").textContent = `₹${total.toFixed(0)}`;

  body.querySelectorAll("[data-cartinc]").forEach((b) => { b.onclick = () => changeCartQty(Number(b.dataset.cartinc), 1); });
  body.querySelectorAll("[data-cartdec]").forEach((b) => { b.onclick = () => changeCartQty(Number(b.dataset.cartdec), -1); });
  body.querySelectorAll("[data-cartremove]").forEach((b) => {
    b.onclick = () => { CART = CART.filter((c) => c.id !== Number(b.dataset.cartremove)); saveCart(); renderCart(); };
  });
}

function changeCartQty(id, delta) {
  const line = CART.find((c) => c.id === id);
  if (!line) return;
  const item = ITEMS.find((i) => i.id === id);
  line.qty += delta;
  if (item) line.qty = Math.min(line.qty, item.quantity);
  if (line.qty <= 0) CART = CART.filter((c) => c.id !== id);
  saveCart();
  renderCart();
  renderGrid(); // keep the shop grid's +/- stepper in sync with the cart drawer
}

el("openCartBtn").onclick = () => { renderCart(); el("cartOverlay").classList.remove("hidden"); };
el("closeCartBtn").onclick = () => el("cartOverlay").classList.add("hidden");
el("cartOverlay").addEventListener("click", (e) => { if (e.target === el("cartOverlay")) el("cartOverlay").classList.add("hidden"); });

/* ======================= USER — CHECKOUT ======================= */
function cartTotal() {
  return CART.reduce((sum, c) => {
    const item = ITEMS.find((i) => i.id === c.id);
    return item ? sum + item.price_now * Math.min(c.qty, item.quantity) : sum;
  }, 0);
}

function renderPayQr() {
  const total = cartTotal().toFixed(0);
  const upiPayload = `upi://pay?pa=smartshelf@upi&pn=SmartShelf&am=${total}&cu=INR&tn=Order%20Payment`;
  // Generated locally in the browser (QRCodeLib, bundled in vendor/qrcode.min.js)
  // instead of sending the payment details to an outside QR-image service.
  QRCodeLib.toDataURL(upiPayload, { width: 180, margin: 1 })
    .then((dataUrl) => { el("qrPayImage").src = dataUrl; })
    .catch(() => {});
  el("qrPayAmount").textContent = `₹${total}`;
}

// Step 1: ask for the delivery address (this is the order-time prompt — no more digging into a sidebar tab).
function showCheckoutAddressStep() {
  el("checkoutHeadTitle").textContent = "Delivery address";
  el("checkoutAddressError").textContent = "";
  el("checkoutAddressArea").classList.remove("hidden");
  el("checkoutPayArea").classList.add("hidden");
  el("checkoutSuccess").classList.add("hidden");
  renderCheckoutAddresses();
}

el("goToCheckoutBtn").onclick = () => {
  if (CART.length === 0) return;
  el("cartOverlay").classList.add("hidden");
  el("checkoutOverlay").classList.remove("hidden");
  showCheckoutAddressStep();
};

el("continueToPaymentBtn").onclick = () => {
  const list = (ME && ME.addresses) || [];
  if (list.length === 0 || !selectedCheckoutAddressId) {
    el("checkoutAddressError").textContent = "Please add and select a delivery address to continue.";
    return;
  }
  showCheckoutPaymentStep();
};

function showCheckoutPaymentStep() {
  const addr = ((ME && ME.addresses) || []).find((a) => a.id === selectedCheckoutAddressId);
  el("checkoutHeadTitle").textContent = "Choose payment method";
  el("checkoutSelectedAddressText").textContent = addr
    ? `${addr.label ? addr.label + " — " : ""}${addr.line1}, ${[addr.city, addr.pincode].filter(Boolean).join(" ")}`
    : "";
  el("checkoutTotalAmount").textContent = `₹${cartTotal().toFixed(0)}`;
  el("checkoutError").textContent = "";
  el("checkoutAddressArea").classList.add("hidden");
  el("checkoutPayArea").classList.remove("hidden");
  el("checkoutSuccess").classList.add("hidden");
  document.querySelectorAll(".pay-tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.pay-tab[data-paytab="upi"]').classList.add("active");
  el("upiPane").classList.remove("hidden");
  el("cardPane").classList.add("hidden");
  el("codPane").classList.add("hidden");
  el("upiId").value = ""; el("cardNumber").value = ""; el("cardExpiry").value = ""; el("cardCvv").value = "";
  renderPayQr();
}

el("changeAddressBtn").onclick = () => showCheckoutAddressStep();
el("closeCheckoutBtn").onclick = () => el("checkoutOverlay").classList.add("hidden");
el("checkoutOverlay").addEventListener("click", (e) => { if (e.target === el("checkoutOverlay")) el("checkoutOverlay").classList.add("hidden"); });

document.querySelectorAll(".pay-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".pay-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.paytab;
    el("upiPane").classList.toggle("hidden", target !== "upi");
    el("cardPane").classList.toggle("hidden", target !== "card");
    el("codPane").classList.toggle("hidden", target !== "cod");
  };
});

el("payUpiBtn").onclick = () => {
  const upiId = el("upiId").value.trim();
  if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiId)) { el("checkoutError").textContent = "Enter a valid UPI ID, e.g. yourname@upi."; return; }
  doCheckout("upi", { upiId });
};
el("payCardBtn").onclick = () => {
  const num = el("cardNumber").value.replace(/\s+/g, "");
  const exp = el("cardExpiry").value.trim();
  const cvv = el("cardCvv").value.trim();
  if (!/^\d{13,19}$/.test(num)) { el("checkoutError").textContent = "Enter a valid card number."; return; }
  if (!/^\d{2}\/\d{2}$/.test(exp)) { el("checkoutError").textContent = "Enter expiry as MM/YY."; return; }
  if (!/^\d{3,4}$/.test(cvv)) { el("checkoutError").textContent = "Enter a valid CVV."; return; }
  doCheckout("card", { last4: num.slice(-4) });
};
el("payCodBtn").onclick = () => doCheckout("cod", {});

async function doCheckout(paymentMethod, paymentDetails) {
  el("checkoutError").textContent = "";
  if (!selectedCheckoutAddressId) { showCheckoutAddressStep(); return; }
  const items = CART.map((c) => ({ id: c.id, qty: c.qty }));
  try {
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ items, paymentMethod, paymentDetails, addressId: selectedCheckoutAddressId }),
    });
    const order = await readJson(res);
    if (!res.ok) throw new Error(order.error || "Checkout failed.");
    CART = [];
    saveCart();
    await refreshAll();
    const methodLabel = paymentMethod === "upi" ? "UPI" : paymentMethod === "card" ? "Card" : "Cash on delivery";
    el("checkoutHeadTitle").textContent = "Order placed";
    el("orderSuccessDetail").textContent = `Order #${order.id} · ₹${order.total} · Paid via ${methodLabel}`;
    el("checkoutPayArea").classList.add("hidden");
    el("checkoutSuccess").classList.remove("hidden");
  } catch (err) {
    el("checkoutError").textContent = err.message;
  }
}
el("orderDoneBtn").onclick = () => el("checkoutOverlay").classList.add("hidden");

/* ======================= SALES — NAV TABS ======================= */
document.querySelectorAll("[data-salestab]").forEach((btn) => {
  btn.onclick = () => switchSalesTab(btn.dataset.salestab);
});
function switchSalesTab(tab) {
  document.querySelectorAll("[data-salestab]").forEach((b) => b.classList.toggle("active", b.dataset.salestab === tab));
  ["overview", "stock", "offers", "orders", "accounts", "profile"].forEach((t) => {
    el(`salesPanel${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle("hidden", t !== tab);
  });
  if (tab === "overview") loadSalesOverview();
  if (tab === "offers") loadOffers();
  if (tab === "orders") loadAllOrders();
  if (tab === "accounts") loadAccounts();
  if (tab === "profile") populateSalesProfileForm();
}

/* ======================= SALES / EXECUTIVE — OVERVIEW ======================= */
async function loadSalesOverview() {
  try {
    const endpoint = ROLE === "executive" ? "/api/overview/executive" : "/api/overview/sales";
    const res = await fetch(`${API}${endpoint}`, { headers: authHeaders() });
    if (res.status === 401) return handleAuthExpired();
    const d = await readJson(res);
    el("statTotalOrders").textContent = d.totalOrders;
    el("statRevenue").textContent = `₹${d.revenue}`;
    el("statMoneySaved").textContent = `₹${d.moneySaved}`;
    el("statPendingApprovals").textContent = d.pendingApprovals;
    updateOffersBadge(d.pendingApprovals);
    renderRiskBars(d.expiryRisk);
    renderLowStock(d.lowStock);
    renderTopCategories(d.topCategories);
  } catch {}
}

/* ======================= EXECUTIVE — ADMINS & CUSTOMERS ======================= */
async function loadAccounts() {
  if (ROLE !== "executive") return;
  try {
    const [adminsRes, customersRes] = await Promise.all([
      fetch(`${API}/api/admins`, { headers: authHeaders() }),
      fetch(`${API}/api/customers`, { headers: authHeaders() }),
    ]);
    if (adminsRes.status === 401 || customersRes.status === 401) return handleAuthExpired();
    const adminsData = await readJson(adminsRes);
    const customersData = await readJson(customersRes);
    el("adminsBody").innerHTML = adminsData.admins.length
      ? adminsData.admins.map((a) => `
          <tr>
            <td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.email)}</td><td>${a.itemCount}</td><td>${a.pendingApprovals}</td>
            <td class="account-row-actions">
              <button class="link-btn" data-resetacc="${a.id}" data-name="${escapeHtml(a.name)}" data-email="${escapeHtml(a.email)}">Reset password</button>
              <button class="link-btn danger" data-removeacc="${a.id}" data-name="${escapeHtml(a.name)}">Remove</button>
            </td>
          </tr>`).join("")
      : `<tr class="empty-row"><td colspan="5">No Admin accounts yet.</td></tr>`;
    el("customersBody").innerHTML = customersData.customers.length
      ? customersData.customers.map((c) => `
          <tr>
            <td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.email)}</td><td>${c.orderCount}</td><td>₹${c.totalSpent}</td>
            <td class="account-row-actions">
              <button class="link-btn" data-resetacc="${c.id}" data-name="${escapeHtml(c.name)}" data-email="${escapeHtml(c.email)}">Reset password</button>
              <button class="link-btn danger" data-removeacc="${c.id}" data-name="${escapeHtml(c.name)}">Remove</button>
            </td>
          </tr>`).join("")
      : `<tr class="empty-row"><td colspan="5">No Customer accounts yet.</td></tr>`;

    document.querySelectorAll("[data-resetacc]").forEach((btn) => {
      btn.onclick = () => openResetPasswordModal(Number(btn.dataset.resetacc), btn.dataset.name, btn.dataset.email);
    });
    document.querySelectorAll("[data-removeacc]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Remove ${btn.dataset.name}'s account? This can't be undone.`)) return;
        await fetch(`${API}/api/accounts/${btn.dataset.removeacc}`, { method: "DELETE", headers: authHeaders() });
        loadAccounts();
      };
    });
  } catch {}
}

/* ---- create Admin / Customer account ---- */
let newAccountRole = "sales";
function openCreateAccountModal(role) {
  newAccountRole = role;
  el("createAccountTitle").textContent = role === "sales" ? "Add Admin" : "Add Customer";
  el("createAccountForm").reset();
  el("createAccountError").textContent = ""; el("createAccountSuccess").textContent = "";
  el("createAccountModal").classList.remove("hidden");
}
if (el("openAddAdminBtn")) el("openAddAdminBtn").onclick = () => openCreateAccountModal("sales");
if (el("openAddCustomerBtn")) el("openAddCustomerBtn").onclick = () => openCreateAccountModal("user");
if (el("closeCreateAccountModal")) el("closeCreateAccountModal").onclick = () => el("createAccountModal").classList.add("hidden");

if (el("createAccountForm")) el("createAccountForm").onsubmit = async (e) => {
  e.preventDefault();
  el("createAccountError").textContent = ""; el("createAccountSuccess").textContent = "";
  try {
    const res = await fetch(`${API}/api/accounts`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        name: el("newAccName").value, email: el("newAccEmail").value,
        phone: el("newAccPhone").value, password: el("newAccPassword").value,
        role: newAccountRole,
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not create account.");
    el("createAccountSuccess").textContent = "Account created!";
    await loadAccounts();
    setTimeout(() => el("createAccountModal").classList.add("hidden"), 900);
  } catch (err) {
    el("createAccountError").textContent = err.message;
  }
};

/* ---- reset password for an existing Admin / Customer account ---- */
let resettingAccountId = null;
function openResetPasswordModal(id, name, email) {
  resettingAccountId = id;
  el("resetPasswordTitle").textContent = `Reset password — ${name}`;
  el("resetPasswordForm").reset();
  el("resetPasswordError").textContent = ""; el("resetPasswordSuccess").textContent = "";
  el("resetPasswordModal").classList.remove("hidden");
}
if (el("closeResetPasswordModal")) el("closeResetPasswordModal").onclick = () => el("resetPasswordModal").classList.add("hidden");
if (el("resetPasswordForm")) el("resetPasswordForm").onsubmit = async (e) => {
  e.preventDefault();
  el("resetPasswordError").textContent = ""; el("resetPasswordSuccess").textContent = "";
  try {
    const res = await fetch(`${API}/api/accounts/${resettingAccountId}/reset-password`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ newPassword: el("resetAccPassword").value }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not reset password.");
    el("resetPasswordSuccess").textContent = "Password reset!";
    setTimeout(() => el("resetPasswordModal").classList.add("hidden"), 900);
  } catch (err) {
    el("resetPasswordError").textContent = err.message;
  }
};

function renderRiskBars(risk) {
  const defs = [
    { key: "safe", label: "Safe" },
    { key: "soon", label: "Expiring Soon" },
    { key: "urgent", label: "Urgent" },
    { key: "expiresToday", label: "Expires Today" },
    { key: "expired", label: "Expired" },
  ];
  const max = Math.max(1, ...defs.map((d) => risk[d.key] || 0));
  el("riskBars").innerHTML = defs.map((d) => {
    const val = risk[d.key] || 0;
    const pct = Math.round((val / max) * 100);
    return `
      <div class="risk-bar-row ${d.key}">
        <span>${d.label}</span>
        <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${pct}%"></div></div>
        <span>${val}</span>
      </div>`;
  }).join("");
}

function renderLowStock(list) {
  el("lowStockBody").innerHTML = list.length
    ? list.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td>${i.quantity}</td></tr>`).join("")
    : `<tr class="empty-row"><td colspan="2">Nothing running low right now.</td></tr>`;
}

function renderTopCategories(list) {
  el("topCategoriesBody").innerHTML = list.length
    ? list.map((c) => `<tr><td>${escapeHtml(c.category)}</td><td>${c.sold}</td></tr>`).join("")
    : `<tr class="empty-row"><td colspan="2">No sales yet.</td></tr>`;
}

/* ======================= SALES — OFFER APPROVALS ======================= */
async function loadOffers() {
  try {
    const res = await fetch(`${API}/api/offers/pending`, { headers: authHeaders() });
    if (res.status === 401) return handleAuthExpired();
    const d = await readJson(res);
    updateOffersBadge(d.count);
    renderOfferList(d.items);
  } catch {}
}

function updateOffersBadge(count) {
  const badge = el("offersNavBadge");
  badge.textContent = count;
  badge.classList.toggle("hidden", !count);
}

function renderOfferList(items) {
  const wrap = el("offerList");
  if (items.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><span class="emoji">🏷️</span><h3>No offers waiting</h3><p>Items get a pending offer here as they move into a new expiry discount tier.</p></div>`;
    return;
  }
  wrap.innerHTML = items.map((p) => {
    const thumb = p.photo ? `<img src="${p.photo}" alt="">` : `<div class="offer-icon">${CATEGORY_ICON[p.category] || "🛒"}</div>`;
    const discounted = Math.round(p.price * (1 - p.potential_discount_pct / 100));
    return `
      <div class="offer-card">
        ${thumb}
        <div class="offer-info">
          <h4>${escapeHtml(p.name)}</h4>
          <div class="meta">${escapeHtml(p.brand)} · exp ${p.expiry} · ${p.days_remaining <= 0 ? "expires today" : p.days_remaining + "d left"}</div>
        </div>
        <div class="offer-price"><span class="was">₹${p.price}</span>₹${discounted} <span class="sale-badge">${p.potential_discount_pct}% OFF</span></div>
        <div class="offer-actions">
          <button class="offer-keep" data-keep="${p.id}">Keep full price</button>
          <button class="offer-accept" data-accept="${p.id}">Accept discount</button>
        </div>
      </div>`;
  }).join("");

  wrap.querySelectorAll("[data-accept]").forEach((b) => { b.onclick = () => decideOffer(Number(b.dataset.accept), true); });
  wrap.querySelectorAll("[data-keep]").forEach((b) => { b.onclick = () => decideOffer(Number(b.dataset.keep), false); });
}

async function decideOffer(id, approve) {
  try {
    await fetch(`${API}/api/offers/${id}/decision`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ approve }) });
    await Promise.all([loadOffers(), refreshAll()]);
  } catch {}
}

/* ======================= ORDERS (shared render for sales-all / user-own) ======================= */
function renderOrderCards(targetId, orders, showCustomer) {
  const wrap = el(targetId);
  if (!orders.length) {
    wrap.innerHTML = `<div class="empty-state"><span class="emoji">🧾</span><h3>No orders yet</h3><p>${showCustomer ? "Orders placed by Customers will show up here." : "You haven't placed any orders yet."}</p></div>`;
    return;
  }
  wrap.innerHTML = orders.map((o) => {
    const date = new Date(o.placedAt).toLocaleString();
    const lines = o.items.map((l) => `<div>${l.qty} × ${escapeHtml(l.name)} — ₹${l.lineTotal}</div>`).join("");
    const payLabel = o.paymentMethod === "upi" ? "📱 UPI" : o.paymentMethod === "card" ? "💳 Card" : "💵 COD";
    const addr = o.deliveryAddress;
    const addrLine = addr
      ? `<div class="order-meta">📍 ${escapeHtml(addr.line1)}, ${escapeHtml([addr.city, addr.pincode].filter(Boolean).join(" "))}${addr.phone ? " · 📞 " + escapeHtml(addr.phone) : ""}</div>`
      : "";
    return `
      <div class="order-card">
        <div class="order-card-head">
          <strong>Order #${o.id}${showCustomer ? ` · ${escapeHtml(o.userName)}` : ""}</strong>
          <span class="order-total">₹${o.total}<span class="pay-chip">${payLabel}</span></span>
        </div>
        <div class="order-meta">${date}${o.paymentSummary ? " · " + escapeHtml(o.paymentSummary) : ""}</div>
        ${addrLine}
        <div class="order-lines">${lines}</div>
      </div>`;
  }).join("");
}

async function loadAllOrders() {
  try {
    const res = await fetch(`${API}/api/orders/all`, { headers: authHeaders() });
    if (res.status === 401) return handleAuthExpired();
    const d = await readJson(res);
    renderOrderCards("allOrdersList", d.orders, true);
  } catch {}
}

/* ======================= PROFILE (both roles) ======================= */
function populateSalesProfileForm() {
  if (!ME) return;
  el("salesProfileEmail").textContent = ME.email;
  el("salesProfileName").value = ME.name;
  el("salesProfilePhone").value = ME.phone || "";
  el("salesProfileError").textContent = ""; el("salesProfileSuccess").textContent = "";
}
el("salesProfileForm").onsubmit = async (e) => {
  e.preventDefault();
  el("salesProfileError").textContent = ""; el("salesProfileSuccess").textContent = "";
  try {
    const res = await fetch(`${API}/api/profile`, {
      method: "PUT", headers: authHeaders(),
      body: JSON.stringify({ name: el("salesProfileName").value, phone: el("salesProfilePhone").value }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not save changes.");
    USER_NAME = data.name; if (ME) { ME.name = data.name; ME.phone = data.phone; }
    localStorage.setItem(KEY_PREFIX + "name", USER_NAME);
    el("salesGreeting").textContent = `Hi, ${USER_NAME} 👋`;
    el("salesProfileSuccess").textContent = "Saved!";
  } catch (err) {
    el("salesProfileError").textContent = err.message;
  }
};

function populateUserProfileForm() {
  if (!ME) return;
  el("userProfileEmail").textContent = ME.email;
  el("userProfileName").value = ME.name;
  el("userProfilePhone").value = ME.phone || "";
  el("userProfileError").textContent = ""; el("userProfileSuccess").textContent = "";
}
el("userProfileForm").onsubmit = async (e) => {
  e.preventDefault();
  el("userProfileError").textContent = ""; el("userProfileSuccess").textContent = "";
  try {
    const res = await fetch(`${API}/api/profile`, {
      method: "PUT", headers: authHeaders(),
      body: JSON.stringify({ name: el("userProfileName").value, phone: el("userProfilePhone").value }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not save changes.");
    USER_NAME = data.name; if (ME) { ME.name = data.name; ME.phone = data.phone; }
    localStorage.setItem(KEY_PREFIX + "name", USER_NAME);
    el("userGreeting").textContent = `Hi, ${USER_NAME} 👋`;
    el("userProfileSuccess").textContent = "Saved!";
  } catch (err) {
    el("userProfileError").textContent = err.message;
  }
};

/* ======================= USER — ADDRESSES (asked at checkout, not in the sidebar) ======================= */
let editingAddressId = null; // null = adding a new address
let selectedCheckoutAddressId = null; // address chosen for the order currently being placed

// Renders the selectable address list shown inside the checkout modal (step 1).
function renderCheckoutAddresses() {
  const wrap = el("checkoutAddressList");
  const list = (ME && ME.addresses) || [];

  if (!selectedCheckoutAddressId) {
    const def = list.find((a) => a.isDefault) || list[0];
    if (def) selectedCheckoutAddressId = def.id;
  }

  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><span class="emoji">📍</span><h3>No addresses saved yet</h3><p>Add a delivery address below to continue with your order.</p></div>`;
    return;
  }

  wrap.innerHTML = list.map((a) => `
    <label class="address-card selectable ${a.id === selectedCheckoutAddressId ? "selected" : ""}" data-addrcard="${a.id}">
      <input type="radio" name="checkoutAddr" value="${a.id}" ${a.id === selectedCheckoutAddressId ? "checked" : ""}>
      <div class="address-card-body">
        <div class="address-card-head">
          <strong>${escapeHtml(a.label || "Address")}</strong>
          ${a.isDefault ? `<span class="default-badge">Default</span>` : ""}
        </div>
        <div class="addr-text">
          ${escapeHtml(a.line1)}<br>
          ${escapeHtml([a.city, a.state].filter(Boolean).join(", "))} ${escapeHtml(a.pincode || "")}
          ${a.phone ? `<br>📞 ${escapeHtml(a.phone)}` : ""}
        </div>
        <div class="address-actions">
          ${a.isDefault ? "" : `<button type="button" class="addr-default-btn" data-default="${a.id}">Set default</button>`}
          <button type="button" data-editaddr="${a.id}">Edit</button>
          <button type="button" class="addr-delete-btn" data-deleteaddr="${a.id}">Delete</button>
        </div>
      </div>
    </label>`).join("");

  wrap.querySelectorAll("[data-addrcard]").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest(".address-actions")) return; // let action buttons handle their own clicks
      selectedCheckoutAddressId = Number(card.dataset.addrcard);
      renderCheckoutAddresses();
    };
  });
  wrap.querySelectorAll("[data-editaddr]").forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); openAddressModal(Number(btn.dataset.editaddr)); };
  });
  wrap.querySelectorAll("[data-default]").forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); setDefaultAddress(Number(btn.dataset.default)); };
  });
  wrap.querySelectorAll("[data-deleteaddr]").forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); deleteAddress(Number(btn.dataset.deleteaddr)); };
  });
}

function openAddressModal(id) {
  editingAddressId = id || null;
  el("addressError").textContent = "";
  const a = id ? (ME.addresses || []).find((x) => x.id === id) : null;
  el("addressModalTitle").textContent = id ? "Edit address" : "Add address";
  el("addrLabel").value = a ? a.label || "" : "";
  el("addrLine1").value = a ? a.line1 : "";
  el("addrCity").value = a ? a.city : "";
  el("addrState").value = a ? a.state : "";
  el("addrPincode").value = a ? a.pincode : "";
  el("addrPhone").value = a ? a.phone : "";
  // Hide the checkout modal while the address form is open — showing both at once
  // was the stacked-modal glitch; this goes directly to the add/edit address form.
  el("checkoutOverlay").classList.add("hidden");
  el("addressModal").classList.remove("hidden");
}
function closeAddressModal() {
  el("addressModal").classList.add("hidden");
  el("checkoutOverlay").classList.remove("hidden");
  showCheckoutAddressStep();
}
el("checkoutAddNewAddressBtn").onclick = () => openAddressModal(null);
el("closeAddressModal").onclick = closeAddressModal;
el("addressModal").addEventListener("click", (e) => { if (e.target === el("addressModal")) closeAddressModal(); });

el("addressForm").onsubmit = async (e) => {
  e.preventDefault();
  el("addressError").textContent = "";
  const payload = {
    label: el("addrLabel").value, line1: el("addrLine1").value, city: el("addrCity").value,
    state: el("addrState").value, pincode: el("addrPincode").value, phone: el("addrPhone").value,
  };
  try {
    const wasNew = !editingAddressId;
    const url = editingAddressId ? `${API}/api/addresses/${editingAddressId}` : `${API}/api/addresses`;
    const res = await fetch(url, {
      method: editingAddressId ? "PUT" : "POST", headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not save address.");
    if (ME) ME.addresses = data.addresses;
    // Newly added address becomes the one selected for this order automatically.
    if (wasNew && data.addresses.length) selectedCheckoutAddressId = data.addresses[data.addresses.length - 1].id;
    el("addressModal").classList.add("hidden");
    el("checkoutOverlay").classList.remove("hidden");
    renderCheckoutAddresses();
  } catch (err) {
    el("addressError").textContent = err.message;
  }
};

async function setDefaultAddress(id) {
  try {
    const res = await fetch(`${API}/api/addresses/${id}/default`, { method: "POST", headers: authHeaders() });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not update default address.");
    if (ME) ME.addresses = data.addresses;
    renderCheckoutAddresses();
  } catch {}
}

async function deleteAddress(id) {
  if (!confirm("Remove this address?")) return;
  try {
    const res = await fetch(`${API}/api/addresses/${id}`, { method: "DELETE", headers: authHeaders() });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Could not remove address.");
    if (ME) ME.addresses = data.addresses;
    if (selectedCheckoutAddressId === id) selectedCheckoutAddressId = null;
    renderCheckoutAddresses();
  } catch {}
}

/* ======================= USER — NAV TABS ======================= */
document.querySelectorAll("[data-usertab]").forEach((btn) => {
  btn.onclick = () => switchUserTab(btn.dataset.usertab);
});
function switchUserTab(tab) {
  document.querySelectorAll("[data-usertab]").forEach((b) => b.classList.toggle("active", b.dataset.usertab === tab));
  ["shop", "dashboard", "profile"].forEach((t) => {
    el(`userPanel${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle("hidden", t !== tab);
  });
  if (tab === "dashboard") loadUserOverview();
  if (tab === "profile") populateUserProfileForm();
}

/* ======================= USER — DASHBOARD ======================= */
async function loadUserOverview() {
  try {
    const res = await fetch(`${API}/api/overview/user`, { headers: authHeaders() });
    if (res.status === 401) return handleAuthExpired();
    const d = await readJson(res);
    el("userStatTotalOrders").textContent = d.totalOrders;
    el("userStatTotalSpent").textContent = `₹${d.totalSpent}`;
    el("userStatTotalSaved").textContent = `₹${d.totalSaved}`;
    renderOrderCards("userRecentOrders", d.recentOrders, false);
  } catch {}
}

/* ======================= BOOT ======================= */
if (PAGE_ROLE && ROLE && ROLE !== PAGE_ROLE) {
  // Stale session for a different role on this page — ignore it.
  TOKEN = null; ROLE = null; USER_NAME = "";
}
if (TOKEN && ROLE) {
  // Already logged in (session restored from localStorage) — go straight to
  // the dashboard regardless of which page was opened.
  enterApp();
} else {
  // Two ways a page can be locked to one role, checked in this order:
  // 1) window.SMARTSHELF_PRESET_ROLE — set by admin.html / customer.html /
  //    executive.html themselves (see those files). Works even opened as a
  //    plain static file, with no server-side routing involved at all.
  // 2) The URL path (/admin, /customer, /executive) — a convenience for the
  //    Node server, which serves index.html for any path (see server.js).
  const presetRole = window.SMARTSHELF_PRESET_ROLE || PATH_ROLE[location.pathname];
  if (presetRole) {
    showAuth(presetRole);
  }
  // Otherwise (plain index.html / "/") the role-picker screen shows by default.
}
