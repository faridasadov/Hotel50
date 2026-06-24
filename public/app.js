// ═══════════════════════════════════════════════════════════════
//  Hotel 50 · Front-end
// ═══════════════════════════════════════════════════════════════

const APP_BASE = window.location.pathname.startsWith("/hotel50/") ? "/hotel50" : "";

const AMENITIES = [
  { key: "wifi",        label: "Pulsuz Wi-Fi"    },
  { key: "breakfast",   label: "Səhər yeməyi"    },
  { key: "bath",        label: "Özəl hamam"      },
  { key: "tv",          label: "Televizor"       },
  { key: "ac",          label: "Kondisioner"     },
  { key: "minibar",     label: "Mini-bar"        },
  { key: "roomservice", label: "Otaq xidməti"    },
  { key: "safe",        label: "Seyf"            },
  { key: "balcony",     label: "Balkon"          },
  { key: "cityview",    label: "Şəhər mənzərəsi" },
  { key: "parking",     label: "Parkinq"         },
];
const appPath = (path) => `${APP_BASE}${path}`;

// ─── API helper ──────────────────────────────────────────────
const api = (path, options = {}) =>
  fetch(appPath(path), { headers: { "Content-Type": "application/json" }, ...options })
    .then(async (res) => {
      const data = await res.json();
      if (res.status === 401) showLogin();
      if (!res.ok) throw new Error(data.error || "Server xətası");
      return data;
    });

// ─── State ───────────────────────────────────────────────────
const state = {
  user: null,
  summary: {},
  rooms: [],
  categories: [],
  guests: [],
  documents: [],
  bookings: [],
  calendar: { rooms: [], bookings: [] },
  debtors: [],
  payments: [],
  roomOrders: [],
  expenses: [],
  requests: [],
  reminders: { debtors: [], arrivals: [], departures: [] },
  backups: [],
  users: [],
  audit: [],
  auditPage: 1,
};

const BOOKING_STATUS_LABELS = {
  Reserved: "Rezerv olunub",
  CheckedIn: "Yerləşib",
  CheckedOut: "Çıxış edib",
  Cancelled: "Ləğv olunub",
};

function bookingStatusLabel(status) {
  return BOOKING_STATUS_LABELS[status] || status || "–";
}

// ─── Formatters ───────────────────────────────────────────────
const fmt = (value) => `${Number(value || 0).toFixed(2)} AZN`;

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.max(1, Math.round((new Date(b) - new Date(a)) / 86_400_000));
}

function estimateLateFee(booking) {
  if (booking.status !== "CheckedIn") return 0;
  const dueAt = new Date(booking.check_out + "T12:00:00");
  const now = new Date();
  if (now <= dueAt) return 0;
  const lateHours = Math.ceil((now - dueAt) / 3_600_000);
  const hourlyRate = Number(booking.room_rate || 0) / 24;
  return Math.round(hourlyRate * lateHours * 100) / 100;
}

// ─── Toast ────────────────────────────────────────────────────
function toast(message, type = "success", duration = 3500) {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  const remove = () => {
    el.classList.add("toast-fade-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  const timer = setTimeout(remove, duration);
  el.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

// ─── Modal ────────────────────────────────────────────────────
function openModal(title, bodyHTML, onSubmit) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHTML;
  document.getElementById("modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";

  if (onSubmit) {
    const form = document.getElementById("modalForm");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = form.querySelector("button[type='submit']");
        if (btn) btn.disabled = true;
        try {
          await onSubmit(Object.fromEntries(new FormData(form).entries()));
          closeModal();
        } catch (err) {
          toast(err.message, "error");
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }
  }
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  document.getElementById("modalBody").innerHTML = "";
  document.body.style.overflow = "";
}

document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeModal();
});

// ─── Auth / permissions ───────────────────────────────────────
function showLogin() { document.querySelector("#loginScreen").classList.remove("hidden"); }
function hideLogin() { document.querySelector("#loginScreen").classList.add("hidden"); }
function isAdmin()      { return state.user?.role === "Admin"; }
function isAccounting() { return ["Admin", "Accounting"].includes(state.user?.role); }
function isOps()        { return ["Admin", "Reception"].includes(state.user?.role); }

function applyPermissions() {
  document.querySelector("#userChip").textContent =
    state.user ? `${state.user.full_name} · ${state.user.role}` : "";
  document.querySelectorAll(".ops-only").forEach((el) =>
    el.classList.toggle("hidden", !isOps()));
  document.querySelectorAll(".admin-only").forEach((el) =>
    el.classList.toggle("hidden", !isAdmin()));
  document.querySelectorAll(".accounting-only").forEach((el) =>
    el.classList.toggle("hidden", !isAccounting()));
  document.querySelector("#backupBtn").classList.toggle("hidden", !isAdmin());
  const pf = document.querySelector("#paymentForm");
  if (pf) pf.classList.toggle("hidden", !isAccounting());
  const ef = document.querySelector("#expenseForm");
  if (ef) ef.classList.toggle("hidden", !isAccounting());
  const activeTab = document.querySelector(".tab.active");
  if (!activeTab || activeTab.classList.contains("hidden")) {
    document.querySelectorAll(".tab, .panel").forEach((el) => el.classList.remove("active"));
    const firstTab = [...document.querySelectorAll(".tab")]
      .find((el) => !el.classList.contains("hidden"));
    if (firstTab) {
      firstTab.classList.add("active");
      const panel = document.querySelector(`#${firstTab.dataset.tab}`);
      if (panel) panel.classList.add("active");
    }
  }
}

// ─── Option lists ─────────────────────────────────────────────
function optionLists() {
  const guestOpts = state.guests
    .map((g) => `<option value="${g.id}">${escapeHtml(g.full_name)}${g.phone ? " – " + escapeHtml(g.phone) : ""}</option>`)
    .join("");
  const roomOpts = state.rooms
    .map((r) => `<option value="${r.id}">${escapeHtml(r.number)} (boş: ${r.free_beds}/${r.capacity}) – ${fmt(r.nightly_rate)}/gecə</option>`)
    .join("");

  document.querySelector('[name="guest_id"]').innerHTML = guestOpts;
  document.querySelector('#documentForm [name="guest_id"]').innerHTML = guestOpts;
  document.querySelector('[name="room_id"]').innerHTML = roomOpts;
  document.querySelector('[name="booking_id"]').innerHTML = state.bookings
    .filter((b) => b.status !== "Cancelled")
    .map((b) => `<option value="${b.id}">#${b.id} ${escapeHtml(b.guest_name)} / ${escapeHtml(b.room_number)} / borc: ${fmt(b.balance)}</option>`)
    .join("");

  // Room orders form
  const roRoomEl = document.querySelector('#roomOrderForm [name="room_id"]');
  if (roRoomEl) roRoomEl.innerHTML = state.rooms
    .map((r) => `<option value="${r.id}">${escapeHtml(r.number)} (${escapeHtml(r.room_type)})</option>`)
    .join("");
  const roBookingEl = document.querySelector('#roomOrderForm [name="booking_id"]');
  if (roBookingEl) roBookingEl.innerHTML =
    `<option value="">– Opsional –</option>` +
    state.bookings.filter((b) => b.status === "CheckedIn")
      .map((b) => `<option value="${b.id}">#${b.id} ${escapeHtml(b.guest_name)} / ${escapeHtml(b.room_number)}</option>`)
      .join("");
}

// ─── Stats ────────────────────────────────────────────────────
function renderStats() {
  const s = state.summary;
  const items = [
    ["Boş yataq",   `${s.free_beds ?? 0}/${s.total_beds ?? 0}`],
    ["Aktiv qonaq", s.active_guests ?? 0],
    ["Bu gün giriş",s.arrivals_today ?? 0],
    ["Bu gün çıxış",s.departures_today ?? 0],
    ["Qalıq borc",  fmt(s.debt)],
    ["Aylıq gəlir", fmt(s.month_income)],
    ["Aylıq net",   fmt(s.month_profit)],
  ];
  document.querySelector("#stats").innerHTML = items
    .map(([label, val]) =>
      `<article class="stat"><strong>${val}</strong><span>${label}</span></article>`)
    .join("");
}

// ─── Helpers: generic table builder ──────────────────────────
function buildTable(targetSelector, headers, rowsHTML) {
  document.querySelector(targetSelector).innerHTML = `
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rowsHTML.join("") || `<tr><td colspan="${headers.length}" style="text-align:center;color:var(--muted);padding:24px">Məlumat yoxdur</td></tr>`}</tbody>
  `;
}

// ─── Rooms ────────────────────────────────────────────────────
function renderRooms() {
  buildTable(
    "#roomTable",
    ["Otaq", "M-bə", "Tip", "Tutum", "Dolu", "Boş", "Təmizlik", "Qiymət/gecə", "Əməliyyat"],
    state.rooms.map((r) => `
      <tr>
        <td><strong>${escapeHtml(r.number)}</strong></td>
        <td>${r.floor}</td>
        <td>${escapeHtml(r.room_type)}</td>
        <td>${r.capacity}</td>
        <td>${r.occupied}</td>
        <td>${r.free_beds}</td>
        <td><span class="status">${escapeHtml(r.cleaning_status || "Təmiz")}</span></td>
        <td>${fmt(r.nightly_rate)}</td>
        <td class="actions">
          <button data-cleaning="${r.id}:Təmiz">Təmiz</button>
          <button data-cleaning="${r.id}:Çirkli">Çirkli</button>
          <button data-cleaning="${r.id}:Təmizlikdə">Təmizlikdə</button>
          <button data-cleaning="${r.id}:Təmir lazımdır">Təmir</button>
          ${isAdmin() ? `<button class="btn-edit" data-edit-room="${r.id}">✎ Redaktə</button>
          <button class="btn-del" data-del-room="${r.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
  );
}

// ─── Categories ───────────────────────────────────────────────
function amenityChecks(selected = []) {
  return `<div class="amenity-checks">
    ${AMENITIES.map((a) => `
      <label class="amenity-check">
        <input type="checkbox" name="amenity_${a.key}" value="${a.key}" ${selected.includes(a.key) ? "checked" : ""} />
        ${a.label}
      </label>`).join("")}
  </div>`;
}

function collectAmenities(container) {
  return AMENITIES.filter((a) => container.querySelector(`[name="amenity_${a.key}"]`)?.checked).map((a) => a.key);
}

function renderCategories() {
  buildTable(
    "#categoryTable",
    ["Ad", "Qiymət/gecə", "Imkanlar", "Əməliyyat"],
    state.categories.map((c) => {
      const ams = Array.isArray(c.amenities) ? c.amenities : [];
      return `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong><br><small style="color:var(--muted)">${escapeHtml(c.description || "")}</small></td>
        <td>${c.base_price > 0 ? `<strong>${fmt(c.base_price)}</strong>` : "–"}</td>
        <td><div class="amenity-badges">${ams.map((k) => {
          const a = AMENITIES.find((x) => x.key === k);
          return `<span class="amenity-badge">${escapeHtml(a ? a.label : k)}</span>`;
        }).join("")}</div></td>
        <td class="actions">
          <button class="btn-edit" data-edit-category="${c.id}">✎ Redaktə</button>
          <button class="btn-del"  data-del-category="${c.id}">Sil</button>
        </td>
      </tr>`;
    })
  );

  // Populate room_type dropdowns (add + edit forms)
  const catOpts = state.categories
    .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
    .join("");
  document.querySelectorAll('[name="room_type"]').forEach((el) => {
    const cur = el.value;
    el.innerHTML = catOpts;
    if (cur && [...el.options].some((o) => o.value === cur)) el.value = cur;
  });

  // Render amenity checkboxes in the add-category form
  const ac = document.getElementById("amenityCheckboxes");
  if (ac) ac.innerHTML = `<label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">İmkanlar</label>${amenityChecks()}`;
}

function editCategory(id) {
  const c = state.categories.find((x) => x.id === id);
  if (!c) return;
  const sel = Array.isArray(c.amenities) ? c.amenities : [];
  openModal("Kateqoriyanı redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Ad<input name="name" value="${escapeHtml(c.name)}" required /></label>
      <label>Qiymət (AZN/gecə)<input name="base_price" type="number" step="0.01" min="0" value="${Number(c.base_price || 0).toFixed(2)}" /></label>
      <label class="wide">Açıqlama<input name="description" value="${escapeHtml(c.description || "")}" /></label>
      <div class="wide">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">İmkanlar</label>
        ${amenityChecks(sel)}
      </div>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (_) => {
    const form = document.getElementById("modalForm");
    const payload = {
      name: form.querySelector("[name=name]").value.trim(),
      description: form.querySelector("[name=description]").value.trim(),
      base_price: parseFloat(form.querySelector("[name=base_price]").value) || 0,
      amenities: collectAmenities(form),
    };
    await api(`/api/room-categories/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    toast("Kateqoriya yeniləndi");
    await loadAll();
  });
}

// ─── Gantt Calendar ───────────────────────────────────────────
function renderCalendar() {
  const { rooms, bookings } = state.calendar;
  const from = document.getElementById("calFrom").value || today();
  const toVal = document.getElementById("calTo").value || dateOffset(14);

  const days = [];
  let d = new Date(from);
  const endD = new Date(toVal);
  while (d <= endD && days.length < 60) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  if (!days.length) return;

  const todayStr = today();

  const colorMap = {};
  bookings.forEach((b) => {
    if (!colorMap[b.room_id]) colorMap[b.room_id] = {};
    let cur = new Date(b.check_in);
    const end = new Date(b.check_out);
    while (cur < end) {
      const ds = cur.toISOString().slice(0, 10);
      colorMap[b.room_id][ds] = b;
      cur.setDate(cur.getDate() + 1);
    }
  });

  const thead = `<tr>
    <th class="cal-room-col">Otaq</th>
    ${days.map((d) => `<th class="cal-day-head ${d === todayStr ? "cal-today-head" : ""}">${d.slice(5)}</th>`).join("")}
  </tr>`;

  const tbody = rooms.map((r) => {
    const cells = days.map((ds) => {
      const b = colorMap[r.id]?.[ds];
      if (!b) return `<td class="cal-cell cal-free"></td>`;
      const name = escapeHtml(b.guest_name.split(" ")[0]);
      return `<td class="cal-cell cal-${b.status}" title="${escapeHtml(b.guest_name)}: ${b.check_in}→${b.check_out} (${b.status})">${name}</td>`;
    }).join("");
    return `<tr><td class="cal-room-td">${escapeHtml(r.number)}</td>${cells}</tr>`;
  }).join("");

  document.querySelector("#calendarTable").innerHTML =
    `<thead>${thead}</thead><tbody>${tbody}</tbody>`;
}

// ─── Guests ───────────────────────────────────────────────────
function renderGuests(list) {
  const guestData = list ?? state.guests;
  buildTable(
    "#guestTable",
    ["Ad soyad", "Telefon", "Sənəd", "Qeyd", "Əməliyyat"],
    guestData.map((g) => `
      <tr>
        <td><strong>${escapeHtml(g.full_name)}</strong></td>
        <td>${escapeHtml(g.phone || "–")}</td>
        <td>${escapeHtml(g.document_no || "–")}</td>
        <td>${escapeHtml(g.note || "–")}</td>
        <td class="actions">
          <button class="btn-edit" data-edit-guest="${g.id}">✎ Redaktə</button>
          ${isAdmin() ? `<button class="btn-del" data-del-guest="${g.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
  );

  buildTable(
    "#documentTable",
    ["Qonaq", "Sənəd", "Fayl", "Tarix", "Əməliyyat"],
    state.documents.map((doc) => `
      <tr>
        <td>${escapeHtml(doc.guest_name)}</td>
        <td>${escapeHtml(doc.title)}</td>
        <td>${escapeHtml(doc.file_name)}</td>
        <td>${doc.created_at.slice(0, 10)}</td>
        <td class="actions">
          <a href="${appPath(`/api/documents/${doc.id}`)}" target="_blank">Aç</a>
          ${isAdmin() ? `<button class="btn-del" data-del-doc="${doc.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
  );
}

// ─── Bookings ─────────────────────────────────────────────────
function renderBookings(list) {
  const data = list || state.bookings;
  buildTable(
    "#bookingTable",
    ["#", "Qonaq", "Otaq", "Tarix", "Status", "Məbləğ", "Ödənilib", "Borc", "Əməliyyat"],
    data.map((b) => {
      const estimated = estimateLateFee(b);
      return `
      <tr>
        <td>${b.id}</td>
        <td><strong>${escapeHtml(b.guest_name)}</strong><br><small>${escapeHtml(b.guest_phone || "")}</small></td>
        <td>${escapeHtml(b.room_number)} <small>(${b.people_count} nəfər)</small></td>
        <td>${b.check_in} 14:00<br>→ ${b.check_out} 12:00</td>
        <td><span class="status ${b.status}">${bookingStatusLabel(b.status)}</span></td>
        <td>
          ${fmt(b.total_amount)}
          ${Number(b.room_order_amount) > 0 ? `<br><small style="color:var(--accent)">+${fmt(b.room_order_amount)} servis</small>` : ""}
          ${Number(b.late_fee) > 0 ? `<br><small style="color:var(--warn)">+${fmt(b.late_fee)} gecikmə</small>` : ""}
          ${estimated > 0 ? `<br><small style="color:var(--warn);opacity:.7">~${fmt(estimated)} (cari)</small>` : ""}
        </td>
        <td>${fmt(b.paid_amount)}</td>
        <td style="${Number(b.balance) > 0 ? "color:var(--danger);font-weight:700" : ""}">${fmt(b.balance)}</td>
        <td class="actions">
          ${isOps() ? `
            ${b.status === "Reserved"  ? `<button data-status="${b.id}:CheckedIn">✔ Giriş</button>` : ""}
            ${b.status === "CheckedIn" ? `<button data-status="${b.id}:CheckedOut">✘ Çıxış</button>` : ""}
            ${b.status !== "CheckedOut" && b.status !== "Cancelled" ? `<button data-status="${b.id}:Cancelled">Ləğv</button>` : ""}
          ` : ""}
          ${isAdmin() ? `<button class="btn-edit" data-edit-late-fee="${b.id}">✎ Gecikmə</button>` : ""}
          ${isOps() ? `<button class="btn-edit" data-edit-booking="${b.id}">✎ Redaktə</button>` : ""}
          ${isAdmin() ? `<button class="btn-del" data-del-booking="${b.id}">Sil</button>` : ""}
        </td>
      </tr>
    `})
  );
}

// ─── Debtors ──────────────────────────────────────────────────
function renderDebtors() {
  buildTable(
    "#debtorTable",
    ["Qonaq", "Telefon", "Otaq", "Tarix", "Borc", "WhatsApp"],
    state.debtors.map((d) => `
      <tr>
        <td><strong>${escapeHtml(d.guest_name)}</strong></td>
        <td>${escapeHtml(d.guest_phone || "–")}</td>
        <td>${escapeHtml(d.room_number)}</td>
        <td>${d.check_in} → ${d.check_out}</td>
        <td style="color:var(--danger);font-weight:700">${fmt(d.balance)}</td>
        <td>${d.whatsapp_url ? `<a href="${escapeHtml(d.whatsapp_url)}" target="_blank">WhatsApp</a>` : "–"}</td>
      </tr>
    `)
  );
}

// ─── Payments ─────────────────────────────────────────────────
function renderPayments() {
  buildTable(
    "#paymentTable",
    ["Tarix", "Qonaq", "Otaq", "Məbləğ", "Metod", "Qeyd", "Sənəd", "Əməliyyat"],
    state.payments.map((p) => `
      <tr>
        <td>${p.paid_at}</td>
        <td>${escapeHtml(p.guest_name)}</td>
        <td>${escapeHtml(p.room_number)}</td>
        <td><strong>${fmt(p.amount)}</strong></td>
        <td>${escapeHtml(p.method)}</td>
        <td>${escapeHtml(p.note || "–")}</td>
        <td><a href="${appPath(`/api/receipts/${p.id}`)}" target="_blank">🖨 Qəbz</a><br><a href="${appPath(`/api/invoices/${p.booking_id}`)}" target="_blank">📄 Final hesab</a></td>
        <td class="actions">
          ${isAccounting() ? `<button class="btn-edit" data-edit-payment="${p.id}">✎</button>
          <button class="btn-del" data-del-payment="${p.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
  );
}

// ─── Room Orders ──────────────────────────────────────────────
const ORDER_STATUS_CLASS = {
  "Yeni":        "Reserved",
  "Hazırlanır":  "CheckedIn",
  "Çatdırıldı":  "CheckedOut",
  "Ləğv edildi": "Cancelled",
};

function renderRoomOrders() {
  buildTable(
    "#roomOrderTable",
    ["Tarix", "Otaq", "Qonaq", "Kateqoriya", "Təsvir", "Məbləğ", "Status", "Əməliyyat"],
    state.roomOrders.map((o) => `
      <tr>
        <td>${o.created_at.slice(0, 16).replace("T", " ")}</td>
        <td><strong>${escapeHtml(o.room_number)}</strong></td>
        <td>${o.guest_name ? `${escapeHtml(o.guest_name)}${o.booking_id ? `<br><small style="color:var(--muted)">Bron #${o.booking_id}</small>` : ""}` : "–"}</td>
        <td><span class="order-cat">${escapeHtml(o.category)}</span></td>
        <td>${escapeHtml(o.description)}</td>
        <td>${o.amount > 0 ? `${fmt(o.amount)}${o.booking_id && o.status === "Çatdırıldı" ? `<br><small style="color:var(--accent)">Borca yazılıb</small>` : ""}` : "–"}</td>
        <td><span class="status ${ORDER_STATUS_CLASS[o.status] || ""}">${escapeHtml(o.status)}</span></td>
        <td class="actions">
          ${isOps() ? `
            ${o.status !== "Çatdırıldı" && o.status !== "Ləğv edildi" ? `
              <button data-order-status="${o.id}:Hazırlanır">Hazırlanır</button>
              <button data-order-status="${o.id}:Çatdırıldı">✔ Çatdır</button>
              <button data-order-status="${o.id}:Ləğv edildi">Ləğv</button>
            ` : ""}
            <button class="btn-edit" data-edit-order="${o.id}">✎</button>
          ` : ""}
          ${isAdmin() ? `<button class="btn-del" data-del-order="${o.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
  );
}

// ─── Expenses ─────────────────────────────────────────────────
function renderExpenses(list) {
  const data = list ?? state.expenses;

  // Category totals
  const totals = {};
  let grandTotal = 0;
  data.forEach((e) => {
    totals[e.category] = (totals[e.category] || 0) + e.amount;
    grandTotal += e.amount;
  });

  // Update total badge
  const badge = document.getElementById("expenseTotalBadge");
  if (badge) badge.textContent = data.length ? `Toplam: ${fmt(grandTotal)}` : "";

  // Populate category filter dropdown (only on full load, not filtered)
  if (!list) {
    const catFilter = document.getElementById("expenseCatFilter");
    if (catFilter) {
      const allCats = [...new Set(state.expenses.map((e) => e.category))].sort();
      const curVal = catFilter.value;
      catFilter.innerHTML =
        `<option value="">Bütün kateqoriyalar</option>` +
        allCats.map((c) =>
          `<option value="${escapeHtml(c)}" ${c === curVal ? "selected" : ""}>${escapeHtml(c)}</option>`
        ).join("");
    }
  }

  const rows = data.map((e) => `
    <tr>
      <td>${e.spent_at}</td>
      <td><strong>${escapeHtml(e.category)}</strong></td>
      <td>${fmt(e.amount)}</td>
      <td>${escapeHtml(e.note || "–")}</td>
      <td class="actions">
        <button class="btn-edit" data-edit-expense="${e.id}">✎</button>
        <button class="btn-del" data-del-expense="${e.id}">Sil</button>
      </td>
    </tr>
  `);

  if (data.length) {
    rows.push(`
      <tr class="expense-total-row">
        <td colspan="2" style="text-align:right;font-weight:700">Toplam:</td>
        <td style="font-weight:700">${fmt(grandTotal)}</td>
        <td colspan="2"></td>
      </tr>
    `);
  }

  buildTable("#expenseTable", ["Tarix", "Kateqoriya", "Məbləğ", "Qeyd", "Əməliyyat"], rows);
}

function applyExpenseFilter() {
  const cat   = document.getElementById("expenseCatFilter")?.value || "";
  const from  = document.getElementById("expenseFromFilter")?.value || "";
  const to    = document.getElementById("expenseToFilter")?.value || "";
  const filtered = state.expenses.filter((e) =>
    (!cat  || e.category === cat) &&
    (!from || e.spent_at >= from) &&
    (!to   || e.spent_at <= to)
  );
  renderExpenses(filtered);
}

// ─── Requests ─────────────────────────────────────────────────
function renderRequests(list) {
  const data = list ?? state.requests;
  buildTable(
    "#requestTable",
    ["Tarix", "Ad", "Telefon", "Tarix aralığı", "Nəfər", "Kateqoriya", "Status", "Qəbul edən", "Əməliyyat"],
    data.map((r) => `
      <tr>
        <td>${r.created_at.slice(0, 10)}</td>
        <td><strong>${escapeHtml(r.full_name)}</strong></td>
        <td>${escapeHtml(r.phone || "–")}</td>
        <td>${r.check_in || "–"} → ${r.check_out || "–"}</td>
        <td>${r.people_count}</td>
        <td>${r.room_category ? `<span class="amenity-badge">${escapeHtml(r.room_category)}</span>` : "–"}</td>
        <td><span class="status ${r.status}">${escapeHtml(r.status)}</span></td>
        <td>${r.handled_by ? `<strong>${escapeHtml(r.handled_by)}</strong><br><small>${escapeHtml((r.handled_at || "").slice(0, 16).replace("T", " "))}</small>` : "–"}</td>
        <td class="actions">
          ${r.status === "Təsdiq" || r.status === "İmtina" ? "" : `
            <button data-req-status="${r.id}:Baxılır">Baxılır</button>
            <button data-req-status="${r.id}:Təsdiq">Təsdiq</button>
            <button data-req-status="${r.id}:İmtina">İmtina</button>
            <button class="btn-edit" data-convert-request="${r.id}">Bron yarat</button>
          `}
        </td>
      </tr>
    `)
  );
}

function applyRequestFilter() {
  const status = document.getElementById("requestStatusFilter")?.value || "";
  const handler = (document.getElementById("requestHandlerFilter")?.value || "").trim().toLowerCase();
  const filtered = state.requests.filter((r) =>
    (!status || r.status === status) &&
    (!handler || String(r.handled_by || "").toLowerCase().includes(handler))
  );
  renderRequests(filtered);
}

// ─── Reminders ────────────────────────────────────────────────
function renderReminders() {
  const rows = [
    ...state.reminders.debtors.map((d) =>
      `<tr><td><span class="status Cancelled">Borc</span></td><td><strong>${escapeHtml(d.guest_name)}</strong></td>
       <td style="color:var(--danger);font-weight:700">${fmt(d.balance)}<br><small style="color:var(--muted)">Bron #${d.id} / Otaq ${escapeHtml(d.room_number || "")}</small></td>
       <td>
         ${d.whatsapp_url ? `<a href="${escapeHtml(d.whatsapp_url)}" target="_blank">WhatsApp</a><br>` : ""}
         ${d.sms_url ? `<a href="${escapeHtml(d.sms_url)}">SMS</a><br>` : ""}
         <button type="button" class="btn-edit" data-copy-message="${d.id}">Mətni kopyala</button>
       </td></tr>`),
    ...state.reminders.arrivals.map((b) =>
      `<tr><td><span class="status Reserved">${bookingStatusLabel("Reserved")}</span></td><td>${escapeHtml(b.guest_name)}</td>
       <td>${b.check_in}<br><small style="color:var(--muted)">Bron #${b.id} / Otaq ${escapeHtml(b.room_number || "")}</small></td><td>–</td></tr>`),
    ...state.reminders.departures.map((b) =>
      `<tr><td><span class="status CheckedOut">${bookingStatusLabel("CheckedOut")}</span></td><td>${escapeHtml(b.guest_name)}</td>
       <td>${b.check_out}<br><small style="color:var(--muted)">Bron #${b.id} / Otaq ${escapeHtml(b.room_number || "")}</small></td><td>–</td></tr>`),
  ];
  buildTable("#reminderTable", ["Tip", "Qonaq", "Məlumat", "Link"], rows);
}

// ─── Backups ──────────────────────────────────────────────────
function renderBackups() {
  buildTable(
    "#backupTable",
    ["Seç", "Fayl", "Ölçü", "Əməliyyat"],
    state.backups.map((b) => `
      <tr>
        <td><input type="checkbox" data-backup-check="${escapeHtml(b.name)}"></td>
        <td><strong>${escapeHtml(b.name)}</strong></td>
        <td>${(b.size / 1024).toFixed(1)} KB</td>
        <td class="actions">
          <button data-restore="${escapeHtml(b.name)}">⟳ Restore</button>
          <button class="btn-del" data-del-backup="${escapeHtml(b.name)}">Sil</button>
        </td>
      </tr>
    `)
  );
}

// ─── Users ────────────────────────────────────────────────────
function renderUsers() {
  buildTable(
    "#userTable",
    ["Username", "Ad soyad", "Rol", "Aktiv", "Yaradıldı", "Əməliyyat"],
    state.users.map((u) => `
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(u.full_name)}</td>
        <td><span class="status">${escapeHtml(u.role)}</span></td>
        <td>${u.active ? "✅" : "❌"}</td>
        <td>${u.created_at.slice(0, 10)}</td>
        <td class="actions">
          <button class="btn-edit" data-edit-user="${u.id}">✎ Redaktə</button>
          ${u.id !== state.user?.id
            ? `<button class="btn-del" data-del-user="${u.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
  );
}

// ─── Audit ────────────────────────────────────────────────────
function renderAudit(append = false) {
  const rows = state.audit.map((a) => `
    <tr>
      <td>${a.created_at.replace("T", " ").slice(0, 16)}</td>
      <td>${escapeHtml(a.username)}</td>
      <td>${escapeHtml(a.action)}</td>
      <td>${escapeHtml(a.entity)}</td>
      <td>${escapeHtml(a.entity_id || "–")}</td>
      <td>${escapeHtml(a.note || "–")}</td>
    </tr>
  `);
  if (!append) {
    buildTable("#auditTable", ["Tarix", "İstifadəçi", "Əməl", "Obyekt", "ID", "Qeyd"], rows);
  } else {
    const tbody = document.querySelector("#auditTable tbody");
    if (tbody) rows.forEach((r) => (tbody.innerHTML += r));
  }
}

// ─── Charts ───────────────────────────────────────────────────
let _monthlyChart = null;
let _occupancyChart = null;

async function renderCharts() {
  if (!isAccounting()) return;
  try {
    const [monthly, occupancy] = await Promise.all([
      api("/api/reports/monthly"),
      api("/api/reports/occupancy"),
    ]);

    const mc = document.getElementById("monthlyChart");
    if (mc && typeof Chart !== "undefined") {
      if (_monthlyChart) _monthlyChart.destroy();
      _monthlyChart = new Chart(mc, {
        type: "bar",
        data: {
          labels: monthly.map((m) => m.month),
          datasets: [
            { label: "Gəlir",  data: monthly.map((m) => m.income),  backgroundColor: "rgba(2,122,72,0.75)" },
            { label: "Xərc",   data: monthly.map((m) => m.expense), backgroundColor: "rgba(180,35,24,0.65)" },
            { label: "Net",    data: monthly.map((m) => m.profit),  type: "line",
              borderColor: "#0f766e", backgroundColor: "rgba(15,118,110,0.1)",
              tension: 0.3, fill: false, borderWidth: 2, pointRadius: 3 },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { position: "bottom" } },
          scales: { y: { beginAtZero: true } },
        },
      });
    }

    const oc = document.getElementById("occupancyChart");
    if (oc && typeof Chart !== "undefined") {
      if (_occupancyChart) _occupancyChart.destroy();
      _occupancyChart = new Chart(oc, {
        type: "line",
        data: {
          labels: occupancy.map((o) => o.date.slice(5)),
          datasets: [{
            label: "Doluluq %",
            data: occupancy.map((o) => o.rate),
            borderColor: "#0f766e",
            backgroundColor: "rgba(15,118,110,0.12)",
            fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2,
          }],
        },
        options: {
          responsive: true,
          plugins: { legend: { position: "bottom" } },
          scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } } },
        },
      });
    }
  } catch (_) { /* chart errors are non-critical */ }
}

// ─── Render all ───────────────────────────────────────────────
function renderAll() {
  applyPermissions();
  renderStats();
  optionLists();
  renderRooms();
  renderCategories();
  renderCalendar();
  renderGuests();
  // Re-apply active booking filter if any, else render full list
  const _bq = document.getElementById("bookingSearch")?.value.trim();
  const _bs = document.getElementById("bookingStatusFilter")?.value;
  if (_bq || _bs) applyBookingFilter(); else renderBookings();
  renderDebtors();
  renderPayments();
  renderRoomOrders();
  if (isAccounting()) renderExpenses();
  renderRequests();
  renderReminders();
  if (isAdmin()) renderBackups();
  if (isAdmin()) {
    renderUsers();
    renderAudit();
  }
}

// ─── Data loading ─────────────────────────────────────────────
async function loadAll() {
  const calFrom = document.getElementById("calFrom").value || today();
  const calTo   = document.getElementById("calTo").value   || dateOffset(14);

  const requests = [
    api("/api/summary"),
    api("/api/rooms"),
    api("/api/room-categories"),
    api(`/api/calendar?from=${calFrom}&to=${calTo}`),
    api("/api/bookings"),
  ];
  if (isOps()) {
    requests.push(
      api("/api/guests"),
      api("/api/documents"),
      api("/api/room-orders"),
      api("/api/booking-requests"),
    );
  }
  if (isAccounting()) {
    requests.push(
      api("/api/debtors"),
      api("/api/payments"),
      api("/api/reminders"),
      api("/api/expenses"),
    );
  }
  if (isAdmin())      requests.push(api("/api/users"), api("/api/audit?page=1&limit=100"), api("/api/backups"));

  const result = await Promise.all(requests);
  const [summary, rooms, categories, calendar, bookings] = result;
  let idx = 5;
  const guests    = isOps() ? result[idx++] : [];
  const documents = isOps() ? result[idx++] : [];
  const roomOrders = isOps() ? result[idx++] : [];
  const reqs      = isOps() ? result[idx++] : [];
  const debtors   = isAccounting() ? result[idx++] : [];
  const payments  = isAccounting() ? result[idx++] : [];
  const reminders = isAccounting() ? result[idx++] : { debtors: [], arrivals: [], departures: [] };
  const expenses = isAccounting() ? result[idx++] : [];
  const users    = isAdmin() ? result[idx++] : [];
  const auditRes = isAdmin() ? result[idx++] : { data: [] };
  const backups  = isAdmin() ? result[idx++] : [];

  Object.assign(state, { summary, rooms, categories, guests, documents, bookings, calendar, debtors, payments, roomOrders, requests: reqs, reminders, expenses, users, backups });
  state.audit = auditRes.data ?? auditRes;
  state.auditPage = 1;

  renderAll();
}

// ─── Session check ────────────────────────────────────────────
async function checkSession() {
  try {
    const session = await api("/api/auth/session");
    state.user = session.user;
    hideLogin();
    setTodayDefaults();
    await loadAll();
  } catch {
    showLogin();
  }
}

// ─── Today defaults ───────────────────────────────────────────
function setTodayDefaults() {
  const t = today();
  const setIfEmpty = (sel, val) => {
    const el = document.querySelector(sel);
    if (el && !el.value) el.value = val;
  };
  setIfEmpty('[name="check_in"]', t);
  setIfEmpty('[name="paid_at"]', t);
  setIfEmpty('[name="spent_at"]', t);

  const calFrom = document.getElementById("calFrom");
  const calTo   = document.getElementById("calTo");
  if (calFrom && !calFrom.value) calFrom.value = today();
  if (calTo   && !calTo.value)   calTo.value   = dateOffset(14);
  const reminderDate = document.getElementById("reminderDateFilter");
  if (reminderDate && !reminderDate.value) reminderDate.value = t;
}

// ─── Auto-calculate booking amount ───────────────────────────
function calcBookingAmount() {
  const roomEl   = document.querySelector('[name="room_id"]');
  const checkIn  = document.querySelector('[name="check_in"]').value;
  const checkOut = document.querySelector('[name="check_out"]').value;
  if (!roomEl || !checkIn || !checkOut) return;
  const roomId = parseInt(roomEl.value, 10);
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room || !room.nightly_rate) return;
  const nights = daysBetween(checkIn, checkOut);
  const amountEl = document.querySelector('[name="total_amount"]');
  if (amountEl) amountEl.value = (room.nightly_rate * nights).toFixed(2);
}

// ─── Edit modals ──────────────────────────────────────────────
function editGuest(id) {
  const g = state.guests.find((x) => x.id === id);
  if (!g) return;
  openModal("Qonağı redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Ad soyad<input name="full_name" value="${escapeHtml(g.full_name)}" required /></label>
      <label>Telefon<input name="phone" value="${escapeHtml(g.phone || "")}" /></label>
      <label>Sənəd No<input name="document_no" value="${escapeHtml(g.document_no || "")}" /></label>
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(g.note || "")}" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    await api(`/api/guests/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("Qonaq yeniləndi");
    await loadAll();
  });
}

function editLateFee(id) {
  const b = state.bookings.find((x) => x.id === id);
  if (!b) return;
  const estimated = estimateLateFee(b);
  openModal("Gecikmə haqqını düzəlt", `
    <form id="modalForm" class="form-grid">
      <label>Hesablanmış gecikmə (AZN)
        <input name="late_fee" type="number" step="0.01" min="0"
          value="${Number(b.late_fee || 0).toFixed(2)}" required />
      </label>
      ${estimated > 0 ? `<p style="grid-column:1/-1;margin:0;font-size:12px;color:var(--muted)">Cari vaxt üzrə avtomatik hesab: <strong style="color:var(--warn)">${fmt(estimated)}</strong></p>` : ""}
      <button type="submit">💾 Yadda saxla</button>
      ${Number(b.late_fee) > 0 ? `<button type="button" id="clearLateFeeBtn" style="background:var(--danger)">Sıfırla</button>` : ""}
    </form>
  `, async (data) => {
    await api(`/api/bookings/${id}/late-fee`, {
      method: "PATCH",
      body: JSON.stringify({ late_fee: parseFloat(data.late_fee) || 0 }),
    });
    toast("Gecikmə yeniləndi");
    await loadAll();
  });

  document.getElementById("clearLateFeeBtn")?.addEventListener("click", async () => {
    if (!confirm("Gecikmə sıfırlansın?")) return;
    try {
      await api(`/api/bookings/${id}/late-fee`, { method: "PATCH", body: JSON.stringify({ late_fee: 0 }) });
      toast("Gecikmə silindi", "warn");
      closeModal();
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  });
}

function editBooking(id) {
  const b = state.bookings.find((x) => x.id === id);
  if (!b) return;
  const gOpts = state.guests.map((g) =>
    `<option value="${g.id}" ${g.id === b.guest_id ? "selected" : ""}>${escapeHtml(g.full_name)}</option>`).join("");
  const rOpts = state.rooms.map((r) =>
    `<option value="${r.id}" ${r.id === b.room_id ? "selected" : ""}>${escapeHtml(r.number)} – ${fmt(r.nightly_rate)}/gecə</option>`).join("");
  openModal("Bronu redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Qonaq<select name="guest_id">${gOpts}</select></label>
      <label>Otaq<select name="room_id">${rOpts}</select></label>
      <label>Giriş<input name="check_in" type="date" value="${b.check_in}" required /></label>
      <label>Çıxış<input name="check_out" type="date" value="${b.check_out}" required /></label>
      <label>Nəfər<input name="people_count" type="number" min="1" value="${b.people_count}" required /></label>
      <label>Otaq haqqı<input name="total_amount" type="number" step="0.01" value="${b.total_amount}" required readonly /></label>
      <input type="hidden" name="status" value="${escapeHtml(b.status)}" />
      <input type="hidden" name="late_fee" value="${Number(b.late_fee || 0).toFixed(2)}" />
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(b.note || "")}" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    await api(`/api/bookings/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("Bron yeniləndi");
    await loadAll();
  });

  const modal = document.getElementById("modal");
  const mRoom  = modal.querySelector('[name="room_id"]');
  const mIn    = modal.querySelector('[name="check_in"]');
  const mOut   = modal.querySelector('[name="check_out"]');
  const mAmt   = modal.querySelector('[name="total_amount"]');
  const recalcModal = () => {
    if (!mRoom || !mIn?.value || !mOut?.value || !mAmt) return;
    const room = state.rooms.find((r) => r.id === parseInt(mRoom.value, 10));
    if (room) mAmt.value = (room.nightly_rate * daysBetween(mIn.value, mOut.value)).toFixed(2);
  };
  mRoom?.addEventListener("change", recalcModal);
  mIn?.addEventListener("change",   recalcModal);
  mOut?.addEventListener("change",  recalcModal);
}

function convertRequestToBooking(id) {
  const req = state.requests.find((x) => x.id === id);
  if (!req) return;
  const requestedCat = req.room_category || "";
  const sortedRooms = [...state.rooms].sort((a, b) => {
    const aMatch = requestedCat && a.room_type === requestedCat ? -1 : 0;
    const bMatch = requestedCat && b.room_type === requestedCat ? -1 : 0;
    return aMatch - bMatch;
  });
  const roomOpts = sortedRooms.map((r) => {
    const isMatch = requestedCat && r.room_type === requestedCat;
    return `<option value="${r.id}" ${isMatch ? "selected" : ""}>${isMatch ? "★ " : ""}${escapeHtml(r.number)} [${escapeHtml(r.room_type)}] (boş: ${r.free_beds}/${r.capacity}) – ${fmt(r.nightly_rate)}/gecə</option>`;
  }).join("");
  openModal("Sorğunu brona çevir", `
    <form id="modalForm" class="form-grid">
      <label>Ad soyad<input value="${escapeHtml(req.full_name)}" disabled /></label>
      <label>Telefon<input value="${escapeHtml(req.phone || "")}" disabled /></label>
      ${requestedCat ? `<label class="wide">İstənilən kateqoriya<input value="${escapeHtml(requestedCat)}" disabled style="color:var(--accent);font-weight:600" /></label>` : ""}
      <label>Otaq<select name="room_id">${roomOpts}</select></label>
      <label>Status<select name="status"><option value="Reserved">Rezerv olunub</option><option value="CheckedIn">Yerləşib</option></select></label>
      <label>Giriş<input name="check_in" type="date" value="${escapeHtml(req.check_in || today())}" required /></label>
      <label>Çıxış<input name="check_out" type="date" value="${escapeHtml(req.check_out || dateOffset(1))}" required /></label>
      <label>Nəfər<input name="people_count" type="number" min="1" value="${req.people_count || 1}" required /></label>
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(req.note || "")}" /></label>
      <button type="submit">Bron yarat</button>
    </form>
  `, async (data) => {
    await api(`/api/booking-requests/${id}/convert`, { method: "POST", body: JSON.stringify(data) });
    toast("Sorğu brona çevrildi");
    await loadAll();
  });
}

function editPayment(id) {
  const p = state.payments.find((x) => x.id === id);
  if (!p) return;
  const bOpts = state.bookings.map((b) =>
    `<option value="${b.id}" ${b.id === p.booking_id ? "selected" : ""}>#${b.id} ${escapeHtml(b.guest_name)} / ${escapeHtml(b.room_number)}</option>`).join("");
  openModal("Ödənişi redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Bron<select name="booking_id">${bOpts}</select></label>
      <label>Məbləğ<input name="amount" type="number" step="0.01" value="${p.amount}" required /></label>
      <label>Metod<select name="method">
        ${["Cash","Card","Transfer"].map((m) => `<option ${m === p.method ? "selected" : ""}>${m}</option>`).join("")}
      </select></label>
      <label>Tarix<input name="paid_at" type="date" value="${p.paid_at}" required /></label>
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(p.note || "")}" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    await api(`/api/payments/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("Ödəniş yeniləndi");
    await loadAll();
  });
}

function editExpense(id) {
  const e = state.expenses.find((x) => x.id === id);
  if (!e) return;
  openModal("Xərci redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Kateqoriya
        <input name="category" list="modalExpCats" value="${escapeHtml(e.category)}" required />
        <datalist id="modalExpCats">
          <option>Kommunal</option><option>Təmir</option><option>Təmizlik</option>
          <option>Ərzaq</option><option>Reklam</option>
          <option>Avadanlıq</option><option>Nəqliyyat</option><option>Digər</option>
        </datalist>
      </label>
      <label>Məbləğ<input name="amount" type="number" step="0.01" value="${e.amount}" required /></label>
      <label>Tarix<input name="spent_at" type="date" value="${e.spent_at}" required /></label>
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(e.note || "")}" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    await api(`/api/expenses/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("Xərc yeniləndi");
    await loadAll();
  });
}

function editRoom(id) {
  const r = state.rooms.find((x) => x.id === id);
  if (!r) return;
  const catOpts = state.categories
    .map((c) => `<option value="${escapeHtml(c.name)}" ${c.name === r.room_type ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    .join("");
  openModal("Otağı redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Nömrə<input name="number" value="${escapeHtml(r.number)}" required /></label>
      <label>Mərtəbə<input name="floor" type="number" min="1" value="${r.floor}" required /></label>
      <label>Kateqoriya<select name="room_type" required>${catOpts}</select></label>
      <label>Tutum<input name="capacity" type="number" min="1" value="${r.capacity}" required /></label>
      <label>Gecəlik AZN<input name="nightly_rate" type="number" step="0.01" value="${r.nightly_rate}" required /></label>
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(r.note || "")}" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    await api(`/api/rooms/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("Otaq yeniləndi");
    await loadAll();
  });
}

function editRoomOrder(id) {
  const o = state.roomOrders.find((x) => x.id === id);
  if (!o) return;
  const rOpts = state.rooms.map((r) =>
    `<option value="${r.id}" ${r.id === o.room_id ? "selected" : ""}>${escapeHtml(r.number)}</option>`).join("");
  const bOpts = `<option value="">– Opsional –</option>` +
    state.bookings.filter((b) => b.status === "CheckedIn" || b.id === o.booking_id)
      .map((b) => `<option value="${b.id}" ${b.id === o.booking_id ? "selected" : ""}>#${b.id} ${escapeHtml(b.guest_name)} / ${escapeHtml(b.room_number)}</option>`).join("");
  const cats = ["Yemək","İçki","Gigiyena məhsulu","Əlavə inventar","Müxtəlif"];
  const catOpts = cats.map((c) => `<option ${c === o.category ? "selected" : ""}>${c}</option>`).join("");
  const statuses = ["Yeni","Hazırlanır","Çatdırıldı","Ləğv edildi"];
  const statOpts = statuses.map((s) => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("");
  openModal("Sifarişi redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Otaq<select name="room_id">${rOpts}</select></label>
      <label>Bron<select name="booking_id">${bOpts}</select></label>
      <label>Kateqoriya<select name="category">${catOpts}</select></label>
      <label>Təsvir<input name="description" value="${escapeHtml(o.description)}" required /></label>
      <label>Məbləğ<input name="amount" type="number" step="0.01" value="${o.amount}" /></label>
      <label>Status<select name="status">${statOpts}</select></label>
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(o.note || "")}" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    await api(`/api/room-orders/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("Sifariş yeniləndi");
    await loadAll();
  });
}

function editUser(id) {
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  openModal("İstifadəçini redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Ad soyad<input name="full_name" value="${escapeHtml(u.full_name)}" required /></label>
      <label>Rol<select name="role">
        ${["Reception","Accounting","Admin"].map((r) =>
          `<option ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}
      </select></label>
      <label>Aktiv<select name="active">
        <option value="1" ${u.active ? "selected" : ""}>Bəli</option>
        <option value="0" ${!u.active ? "selected" : ""}>Xeyr</option>
      </select></label>
      <label>Yeni şifrə (boş qoysan dəyişmir)<input name="password" type="password" minlength="6" placeholder="min 6 simvol" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    if (!data.password) delete data.password;
    await api(`/api/users/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("İstifadəçi yeniləndi");
    await loadAll();
  });
}

// ─── Search / filter helpers ──────────────────────────────────
let bookingSearchTimer = null;
document.getElementById("bookingSearch").addEventListener("input", (e) => {
  clearTimeout(bookingSearchTimer);
  bookingSearchTimer = setTimeout(() => applyBookingFilter(), 300);
});
document.getElementById("bookingStatusFilter").addEventListener("change", applyBookingFilter);

function applyBookingFilter() {
  const q      = document.getElementById("bookingSearch").value.trim().toLowerCase();
  const status = document.getElementById("bookingStatusFilter").value;
  const filtered = state.bookings.filter((b) => {
    const matchQ = !q ||
      b.guest_name.toLowerCase().includes(q) ||
      b.room_number.toLowerCase().includes(q) ||
      (b.guest_phone || "").toLowerCase().includes(q);
    const matchS = !status || b.status === status;
    return matchQ && matchS;
  });
  renderBookings(filtered);
}

let guestSearchTimer = null;
document.getElementById("guestSearch").addEventListener("input", (e) => {
  clearTimeout(guestSearchTimer);
  guestSearchTimer = setTimeout(() => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = state.guests.filter(
      (g) => !q || g.full_name.toLowerCase().includes(q) ||
        (g.phone || "").includes(q) || (g.document_no || "").includes(q)
    );
    renderGuests(filtered);
  }, 300);
});

// ─── Expense filter events ────────────────────────────────────
document.getElementById("expenseFilterBtn")?.addEventListener("click", applyExpenseFilter);
document.getElementById("expenseFilterClearBtn")?.addEventListener("click", () => {
  const catEl  = document.getElementById("expenseCatFilter");
  const fromEl = document.getElementById("expenseFromFilter");
  const toEl   = document.getElementById("expenseToFilter");
  if (catEl)  catEl.value  = "";
  if (fromEl) fromEl.value = "";
  if (toEl)   toEl.value   = "";
  renderExpenses();
});
document.getElementById("requestFilterBtn")?.addEventListener("click", applyRequestFilter);
document.getElementById("requestFilterClearBtn")?.addEventListener("click", () => {
  const statusEl = document.getElementById("requestStatusFilter");
  const handlerEl = document.getElementById("requestHandlerFilter");
  if (statusEl) statusEl.value = "";
  if (handlerEl) handlerEl.value = "";
  renderRequests();
});
document.getElementById("reminderFilterBtn")?.addEventListener("click", async () => {
  const date = document.getElementById("reminderDateFilter")?.value || "";
  const q = document.getElementById("reminderSearchFilter")?.value.trim() || "";
  const bookingId = document.getElementById("reminderBookingFilter")?.value || "";
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (q) params.set("q", q);
  if (bookingId) params.set("booking_id", bookingId);
  try {
    state.reminders = await api(`/api/reminders?${params.toString()}`);
    renderReminders();
  } catch (err) { toast(err.message, "error"); }
});
document.getElementById("reminderFilterClearBtn")?.addEventListener("click", async () => {
  const dateEl = document.getElementById("reminderDateFilter");
  const searchEl = document.getElementById("reminderSearchFilter");
  const bookingEl = document.getElementById("reminderBookingFilter");
  if (dateEl) dateEl.value = today();
  if (searchEl) searchEl.value = "";
  if (bookingEl) bookingEl.value = "";
  try {
    state.reminders = await api(`/api/reminders?date=${today()}`);
    renderReminders();
  } catch (err) { toast(err.message, "error"); }
});

// ─── Calendar controls ────────────────────────────────────────
document.getElementById("calApplyBtn").addEventListener("click", async () => {
  const from = document.getElementById("calFrom").value;
  const to   = document.getElementById("calTo").value;
  if (!from || !to) { toast("Tarix aralığı seçin", "warn"); return; }
  try {
    state.calendar = await api(`/api/calendar?from=${from}&to=${to}`);
    renderCalendar();
  } catch (err) { toast(err.message, "error"); }
});

document.getElementById("calTodayBtn").addEventListener("click", async () => {
  document.getElementById("calFrom").value = today();
  document.getElementById("calTo").value   = dateOffset(7);
  try {
    state.calendar = await api(`/api/calendar?from=${today()}&to=${dateOffset(7)}`);
    renderCalendar();
  } catch (err) { toast(err.message, "error"); }
});

// ─── Tabs ─────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, .panel").forEach((el) => el.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "reports") renderCharts();
  });
});

// ─── Top-bar buttons ──────────────────────────────────────────
document.querySelector("#refreshBtn").addEventListener("click", async () => {
  await loadAll();
  toast("Yeniləndi", "info");
});

document.querySelector("#backupBtn").addEventListener("click", async () => {
  try {
    const backup = await api("/api/backup");
    toast(`Backup yaradıldı: ${backup.name}`, "success");
    if (isAdmin()) {
      state.backups = await api("/api/backups");
      renderBackups();
    }
  } catch (err) { toast(err.message, "error"); }
});

document.querySelector("#logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
  state.user = null;
  document.querySelectorAll(".tab, .panel").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".ops-only, .admin-only, .accounting-only")
    .forEach((el) => el.classList.add("hidden"));
  showLogin();
});

// ─── Login form ───────────────────────────────────────────────
document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorEl = document.querySelector("#loginError");
  errorEl.textContent = "";
  const btn = event.currentTarget.querySelector("button");
  btn.disabled = true;
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())),
    });
    const session = await api("/api/auth/session");
    state.user = session.user;
    hideLogin();
    setTodayDefaults();
    await loadAll();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ─── Form submit helpers ──────────────────────────────────────
async function submitForm(form, path) {
  await api(path, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
  form.reset();
  setTodayDefaults();
  await loadAll();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Fayl oxunmadı"));
    reader.readAsDataURL(file);
  });
}

// ─── Category form ────────────────────────────────────────────
document.querySelector("#categoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = {
    name:        form.querySelector("[name=name]").value.trim(),
    description: form.querySelector("[name=description]")?.value.trim() || "",
    base_price:  parseFloat(form.querySelector("[name=base_price]")?.value) || 0,
    amenities:   collectAmenities(form),
  };
  try {
    await api("/api/room-categories", { method: "POST", body: JSON.stringify(payload) });
    form.reset();
    toast("Kateqoriya əlavə edildi");
    await loadAll();
  } catch (err) { toast(err.message, "error"); }
});

document.querySelector("#categoryTable").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-category]");
  const delBtn  = e.target.closest("[data-del-category]");
  if (editBtn) { editCategory(parseInt(editBtn.dataset.editCategory, 10)); return; }
  if (delBtn) {
    if (!confirm("Bu kateqoriya silinsin?")) return;
    try {
      await api(`/api/room-categories/${delBtn.dataset.delCategory}`, { method: "DELETE" });
      toast("Kateqoriya silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Room form ────────────────────────────────────────────────
document.querySelector("#roomForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/rooms"); toast("Otaq əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});

// ─── Guest form ───────────────────────────────────────────────
document.querySelector("#guestForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/guests"); toast("Qonaq əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});
document.querySelector("#documentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const formData = new FormData(e.currentTarget);
    const file = formData.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Sənəd faylı seçin");
    const payload = {
      guest_id: formData.get("guest_id"),
      title: formData.get("title"),
      file_name: file.name,
      content_type: file.type || "application/octet-stream",
      data_base64: await fileToBase64(file),
    };
    await api(`/api/guests/${payload.guest_id}/documents`, { method: "POST", body: JSON.stringify(payload) });
    e.currentTarget.reset();
    setTodayDefaults();
    await loadAll();
    toast("Sənəd əlavə edildi");
  } catch (err) { toast(err.message, "error"); }
});

// ─── Booking form ─────────────────────────────────────────────
document.querySelector("#bookingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/bookings"); toast("Bron yaradıldı"); }
  catch (err) { toast(err.message, "error"); }
});

["check_in", "check_out"].forEach((name) => {
  document.querySelector(`[name="${name}"]`)?.addEventListener("change", calcBookingAmount);
});
document.querySelector('[name="room_id"]')?.addEventListener("change", calcBookingAmount);

// Auto-fill nightly_rate from category base_price
document.querySelector("#roomTypeSelect")?.addEventListener("change", (e) => {
  const cat = state.categories.find((c) => c.name === e.target.value);
  if (cat && cat.base_price > 0) {
    const rateEl = document.querySelector('#roomForm [name="nightly_rate"]');
    if (rateEl) rateEl.value = cat.base_price.toFixed(2);
  }
});

// ─── Payment form ─────────────────────────────────────────────
document.querySelector("#paymentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/payments"); toast("Ödəniş əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});

// ─── Room order form ──────────────────────────────────────────
document.querySelector("#roomOrderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/room-orders"); toast("Sifariş əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});

// ─── Expense form ─────────────────────────────────────────────
document.querySelector("#expenseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/expenses"); toast("Xərc əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});

// ─── User form ────────────────────────────────────────────────
document.querySelector("#userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/users"); toast("İstifadəçi əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});

// ─── Booking table actions ────────────────────────────────────
document.querySelector("#bookingTable").addEventListener("click", async (e) => {
  const statusBtn      = e.target.closest("[data-status]");
  const lateFeeEditBtn = e.target.closest("[data-edit-late-fee]");
  const editBtn        = e.target.closest("[data-edit-booking]");
  const delBtn         = e.target.closest("[data-del-booking]");

  if (lateFeeEditBtn) {
    editLateFee(parseInt(lateFeeEditBtn.dataset.editLateFee, 10));
    return;
  }

  if (statusBtn) {
    const [id, status] = statusBtn.dataset.status.split(":");
    try {
      await api(`/api/bookings/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast(`Status: ${status}`, "info");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
    return;
  }

  if (editBtn) { editBooking(parseInt(editBtn.dataset.editBooking, 10)); return; }

  if (delBtn) {
    if (!confirm("Bu bron silinsin?")) return;
    try {
      await api(`/api/bookings/${delBtn.dataset.delBooking}`, { method: "DELETE" });
      toast("Bron silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

document.querySelector("#reminderTable").addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("[data-copy-message]");
  if (!copyBtn) return;
  const item = state.reminders.debtors.find((d) => String(d.id) === String(copyBtn.dataset.copyMessage));
  if (!item?.message_text) return;
  try {
    await navigator.clipboard.writeText(item.message_text);
    toast("Mesaj mətni kopyalandı");
  } catch (err) {
    toast("Mesaj mətni kopyalanmadı", "error");
  }
});

// ─── Room order table actions ─────────────────────────────────
document.querySelector("#roomOrderTable").addEventListener("click", async (e) => {
  const statusBtn = e.target.closest("[data-order-status]");
  const editBtn   = e.target.closest("[data-edit-order]");
  const delBtn    = e.target.closest("[data-del-order]");

  if (statusBtn) {
    const [id, status] = statusBtn.dataset.orderStatus.split(":");
    try {
      await api(`/api/room-orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast(`Sifariş: ${status}`, "info");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  if (editBtn) { editRoomOrder(parseInt(editBtn.dataset.editOrder, 10)); return; }
  if (delBtn) {
    if (!confirm("Bu sifariş silinsin?")) return;
    try {
      await api(`/api/room-orders/${delBtn.dataset.delOrder}`, { method: "DELETE" });
      toast("Sifariş silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Room table actions ───────────────────────────────────────
document.querySelector("#roomTable").addEventListener("click", async (e) => {
  const cleaningBtn = e.target.closest("[data-cleaning]");
  const editBtn     = e.target.closest("[data-edit-room]");
  const delBtn      = e.target.closest("[data-del-room]");

  if (cleaningBtn) {
    const [id, cleaning_status] = cleaningBtn.dataset.cleaning.split(":");
    try {
      await api(`/api/rooms/${id}/cleaning`, { method: "PATCH", body: JSON.stringify({ cleaning_status }) });
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  if (editBtn) { editRoom(parseInt(editBtn.dataset.editRoom, 10)); return; }
  if (delBtn) {
    if (!confirm("Bu otaq silinsin?")) return;
    try {
      await api(`/api/rooms/${delBtn.dataset.delRoom}`, { method: "DELETE" });
      toast("Otaq silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Guest table actions ──────────────────────────────────────
document.querySelector("#guestTable").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-guest]");
  const delBtn  = e.target.closest("[data-del-guest]");

  if (editBtn) { editGuest(parseInt(editBtn.dataset.editGuest, 10)); return; }
  if (delBtn) {
    if (!confirm("Bu qonaq silinsin?")) return;
    try {
      await api(`/api/guests/${delBtn.dataset.delGuest}`, { method: "DELETE" });
      toast("Qonaq silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Document table actions ───────────────────────────────────
document.querySelector("#documentTable").addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-del-doc]");
  if (delBtn) {
    if (!confirm("Bu sənəd silinsin?")) return;
    try {
      await api(`/api/documents/${delBtn.dataset.delDoc}`, { method: "DELETE" });
      toast("Sənəd silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Payment table actions ────────────────────────────────────
document.querySelector("#paymentTable").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-payment]");
  const delBtn  = e.target.closest("[data-del-payment]");

  if (editBtn) { editPayment(parseInt(editBtn.dataset.editPayment, 10)); return; }
  if (delBtn) {
    if (!confirm("Bu ödəniş silinsin?")) return;
    try {
      await api(`/api/payments/${delBtn.dataset.delPayment}`, { method: "DELETE" });
      toast("Ödəniş silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Expense table actions ────────────────────────────────────
document.querySelector("#expenseTable").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-expense]");
  const delBtn  = e.target.closest("[data-del-expense]");

  if (editBtn) { editExpense(parseInt(editBtn.dataset.editExpense, 10)); return; }
  if (delBtn) {
    if (!confirm("Bu xərc silinsin?")) return;
    try {
      await api(`/api/expenses/${delBtn.dataset.delExpense}`, { method: "DELETE" });
      toast("Xərc silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Request table actions ────────────────────────────────────
document.querySelector("#requestTable").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-req-status]");
  const convertBtn = e.target.closest("[data-convert-request]");
  if (convertBtn) {
    convertRequestToBooking(parseInt(convertBtn.dataset.convertRequest, 10));
    return;
  }
  if (!btn) return;
  const [id, status] = btn.dataset.reqStatus.split(":");
  try {
    await api(`/api/booking-requests/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    toast(`Sorğu: ${status}`, "info");
    await loadAll();
  } catch (err) { toast(err.message, "error"); }
});

// ─── Backup table actions ─────────────────────────────────────
document.querySelector("#backupTable").addEventListener("click", async (e) => {
  const restoreBtn = e.target.closest("[data-restore]");
  const delBtn     = e.target.closest("[data-del-backup]");

  if (restoreBtn) {
    if (!confirm(`${restoreBtn.dataset.restore} backup-dan bərpa edilsin?`)) return;
    try {
      await api("/api/restore", { method: "POST", body: JSON.stringify({ name: restoreBtn.dataset.restore }) });
      toast("Bərpa tamamlandı", "success");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  if (delBtn) {
    if (!confirm(`${delBtn.dataset.delBackup} silinsin?`)) return;
    try {
      await api(`/api/backups/${encodeURIComponent(delBtn.dataset.delBackup)}`, { method: "DELETE" });
      toast("Backup silindi", "warn");
      state.backups = await api("/api/backups");
      renderBackups();
    } catch (err) { toast(err.message, "error"); }
  }
});

document.querySelector("#deleteSelectedBackupsBtn").addEventListener("click", async () => {
  const names = [...document.querySelectorAll("[data-backup-check]:checked")].map((el) => el.dataset.backupCheck);
  if (!names.length) { toast("Silinəcək backup seçilməyib", "warn"); return; }
  if (!confirm(`${names.length} backup silinsin?`)) return;
  try {
    await api("/api/backups/delete", { method: "POST", body: JSON.stringify({ names }) });
    toast(`${names.length} backup silindi`, "warn");
    state.backups = await api("/api/backups");
    renderBackups();
  } catch (err) { toast(err.message, "error"); }
});

document.querySelector("#createBackupBtn").addEventListener("click", async () => {
  try {
    const b = await api("/api/backup");
    toast(`Backup yaradıldı: ${b.name}`, "success");
    state.backups = await api("/api/backups");
    renderBackups();
  } catch (err) { toast(err.message, "error"); }
});

// ─── User table actions ───────────────────────────────────────
document.querySelector("#userTable").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-user]");
  const delBtn  = e.target.closest("[data-del-user]");

  if (editBtn) { editUser(parseInt(editBtn.dataset.editUser, 10)); return; }
  if (delBtn) {
    if (!confirm("Bu istifadəçi silinsin?")) return;
    try {
      await api(`/api/users/${delBtn.dataset.delUser}`, { method: "DELETE" });
      toast("İstifadəçi silindi", "warn");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }
});

// ─── Audit load more ──────────────────────────────────────────
document.getElementById("auditNextBtn").addEventListener("click", async () => {
  state.auditPage++;
  try {
    const res = await api(`/api/audit?page=${state.auditPage}&limit=100`);
    const newItems = res.data ?? res;
    state.audit = [...state.audit, ...newItems];
    renderAudit(true);
    if (newItems.length < 100) toast("Bütün qeydlər yükləndi", "info");
  } catch (err) { toast(err.message, "error"); }
});

// ─── Export ───────────────────────────────────────────────────
document.querySelector("#exportBtn").addEventListener("click", () => {
  window.open(appPath("/api/export/monthly"), "_blank");
});

// ─── Keyboard shortcut: Escape closes modal ───────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ─── Init ─────────────────────────────────────────────────────
checkSession();
