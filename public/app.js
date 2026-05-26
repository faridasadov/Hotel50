// ═══════════════════════════════════════════════════════════════
//  Hotel 50 · Front-end
// ═══════════════════════════════════════════════════════════════

// ─── API helper ──────────────────────────────────────────────
const api = (path, options = {}) =>
  fetch(path, { headers: { "Content-Type": "application/json" }, ...options })
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
  hotels: [],
  guests: [],
  documents: [],
  bookings: [],
  calendar: { rooms: [], bookings: [] },
  debtors: [],
  payments: [],
  expenses: [],
  requests: [],
  reminders: { debtors: [], arrivals: [], departures: [] },
  backups: [],
  users: [],
  audit: [],
  auditPage: 1,
};

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
  document.querySelectorAll(".admin-only").forEach((el) =>
    el.classList.toggle("hidden", !isAdmin()));
  document.querySelectorAll(".accounting-only").forEach((el) =>
    el.classList.toggle("hidden", !isAccounting()));
  document.querySelector("#backupBtn").classList.toggle("hidden", !isAdmin());
  const pf = document.querySelector("#paymentForm");
  if (pf) pf.classList.toggle("hidden", !isAccounting());
  const ef = document.querySelector("#expenseForm");
  if (ef) ef.classList.toggle("hidden", !isAccounting());
}

// ─── Option lists ─────────────────────────────────────────────
function optionLists() {
  const guestOpts = state.guests
    .map((g) => `<option value="${g.id}">${escapeHtml(g.full_name)}${g.phone ? " – " + escapeHtml(g.phone) : ""}</option>`)
    .join("");
  const roomOpts = state.rooms
    .map((r) => `<option value="${r.id}">${escapeHtml(r.number)} (boş: ${r.free_beds}/${r.capacity}) – ${fmt(r.nightly_rate)}/gecə</option>`)
    .join("");
  const hotelOpts = state.hotels
    .map((h) => `<option value="${h.id}">${escapeHtml(h.name)}</option>`)
    .join("");

  document.querySelector('[name="guest_id"]').innerHTML = guestOpts;
  document.querySelector('#documentForm [name="guest_id"]').innerHTML = guestOpts;
  document.querySelector('[name="room_id"]').innerHTML = roomOpts;
  document.querySelector('#roomForm [name="hotel_id"]').innerHTML = hotelOpts;
  document.querySelector('[name="booking_id"]').innerHTML = state.bookings
    .map((b) => `<option value="${b.id}">#${b.id} ${escapeHtml(b.guest_name)} / ${escapeHtml(b.room_number)} / borc: ${fmt(b.balance)}</option>`)
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
    ["Filial", "Otaq", "M-bə", "Tip", "Tutum", "Dolu", "Boş", "Təmizlik", "Qiymət/gecə", "Əməliyyat"],
    state.rooms.map((r) => `
      <tr>
        <td>${escapeHtml(r.hotel_name || "–")}</td>
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

// ─── Gantt Calendar ───────────────────────────────────────────
function renderCalendar() {
  const { rooms, bookings } = state.calendar;
  const from = document.getElementById("calFrom").value || today();
  const toVal = document.getElementById("calTo").value || dateOffset(14);

  // Build day array
  const days = [];
  let d = new Date(from);
  const endD = new Date(toVal);
  while (d <= endD && days.length < 60) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  if (!days.length) return;

  const todayStr = today();

  // Build colorMap: roomId → date → booking
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
function renderGuests() {
  buildTable(
    "#guestTable",
    ["Ad soyad", "Telefon", "Sənəd", "Qeyd", "Əməliyyat"],
    state.guests.map((g) => `
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
          <a href="/api/documents/${doc.id}" target="_blank">Aç</a>
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
    data.map((b) => `
      <tr>
        <td>${b.id}</td>
        <td><strong>${escapeHtml(b.guest_name)}</strong><br><small>${escapeHtml(b.guest_phone || "")}</small></td>
        <td>${escapeHtml(b.room_number)} <small>(${b.people_count} nəfər)</small></td>
        <td>${b.check_in}<br>→ ${b.check_out}</td>
        <td><span class="status ${b.status}">${b.status}</span></td>
        <td>${fmt(b.total_amount)}${b.late_fee > 0 ? `<br><small>+${fmt(b.late_fee)} gec</small>` : ""}</td>
        <td>${fmt(b.paid_amount)}</td>
        <td style="${Number(b.balance) > 0 ? "color:var(--danger);font-weight:700" : ""}">${fmt(b.balance)}</td>
        <td class="actions">
          ${isOps() ? `<button data-status="${b.id}:CheckedIn">✔ Giriş</button>
          <button data-status="${b.id}:CheckedOut">✘ Çıxış</button>
          <button data-status="${b.id}:Cancelled">Ləğv</button>` : ""}
          ${isAccounting() ? `<button data-late-fee="${b.id}">+Gecikmə</button>` : ""}
          ${isOps() ? `<button class="btn-edit" data-edit-booking="${b.id}">✎ Redaktə</button>` : ""}
          ${isAdmin() ? `<button class="btn-del" data-del-booking="${b.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
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
    ["Tarix", "Qonaq", "Otaq", "Məbləğ", "Metod", "Qeyd", "Qəbz", "Əməliyyat"],
    state.payments.map((p) => `
      <tr>
        <td>${p.paid_at}</td>
        <td>${escapeHtml(p.guest_name)}</td>
        <td>${escapeHtml(p.room_number)}</td>
        <td><strong>${fmt(p.amount)}</strong></td>
        <td>${escapeHtml(p.method)}</td>
        <td>${escapeHtml(p.note || "–")}</td>
        <td><a href="/api/receipts/${p.id}" target="_blank">🖨 Qəbz</a></td>
        <td class="actions">
          ${isAccounting() ? `<button class="btn-edit" data-edit-payment="${p.id}">✎</button>
          <button class="btn-del" data-del-payment="${p.id}">Sil</button>` : ""}
        </td>
      </tr>
    `)
  );
}

// ─── Expenses ─────────────────────────────────────────────────
function renderExpenses() {
  buildTable(
    "#expenseTable",
    ["Tarix", "Kateqoriya", "Məbləğ", "Qeyd", "Əməliyyat"],
    state.expenses.map((e) => `
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
    `)
  );
}

// ─── Requests ─────────────────────────────────────────────────
function renderRequests() {
  buildTable(
    "#requestTable",
    ["Tarix", "Ad", "Telefon", "Tarix aralığı", "Nəfər", "Status", "Əməliyyat"],
    state.requests.map((r) => `
      <tr>
        <td>${r.created_at.slice(0, 10)}</td>
        <td><strong>${escapeHtml(r.full_name)}</strong></td>
        <td>${escapeHtml(r.phone || "–")}</td>
        <td>${r.check_in || "–"} → ${r.check_out || "–"}</td>
        <td>${r.people_count}</td>
        <td><span class="status ${r.status}">${escapeHtml(r.status)}</span></td>
        <td class="actions">
          <button data-req-status="${r.id}:Baxılır">Baxılır</button>
          <button data-req-status="${r.id}:Təsdiq">Təsdiq</button>
          <button data-req-status="${r.id}:İmtina">İmtina</button>
        </td>
      </tr>
    `)
  );
}

// ─── Reminders ────────────────────────────────────────────────
function renderReminders() {
  const rows = [
    ...state.reminders.debtors.map((d) =>
      `<tr><td><span class="status Cancelled">Borc</span></td><td><strong>${escapeHtml(d.guest_name)}</strong></td>
       <td style="color:var(--danger);font-weight:700">${fmt(d.balance)}</td>
       <td><a href="${escapeHtml(d.whatsapp_url || "")}" target="_blank">WhatsApp</a></td></tr>`),
    ...state.reminders.arrivals.map((b) =>
      `<tr><td><span class="status Reserved">Giriş</span></td><td>${escapeHtml(b.guest_name)}</td>
       <td>${b.check_in}</td><td>–</td></tr>`),
    ...state.reminders.departures.map((b) =>
      `<tr><td><span class="status CheckedOut">Çıxış</span></td><td>${escapeHtml(b.guest_name)}</td>
       <td>${b.check_out}</td><td>–</td></tr>`),
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
  renderCalendar();
  renderGuests();
  renderBookings();
  renderDebtors();
  renderPayments();
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
    api("/api/hotels"),
    api("/api/guests"),
    api("/api/documents"),
    api("/api/bookings"),
    api(`/api/calendar?from=${calFrom}&to=${calTo}`),
    api("/api/debtors"),
    api("/api/payments"),
    api("/api/booking-requests"),
    api("/api/reminders"),
  ];
  if (isAccounting()) requests.push(api("/api/expenses"));
  if (isAdmin())      requests.push(api("/api/users"), api("/api/audit?page=1&limit=100"), api("/api/backups"));

  const result = await Promise.all(requests);
  const [summary, rooms, hotels, guests, documents, bookings, calendar, debtors, payments, reqs, reminders] = result;
  let idx = 11;
  const expenses = isAccounting() ? result[idx++] : [];
  const users    = isAdmin() ? result[idx++] : [];
  const auditRes = isAdmin() ? result[idx++] : { data: [] };
  const backups  = isAdmin() ? result[idx++] : [];

  Object.assign(state, { summary, rooms, hotels, guests, documents, bookings, calendar, debtors, payments, requests: reqs, reminders, expenses, users, backups });
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
  setIfEmpty('#publicRequestForm [name="check_in"]', t);

  const calFrom = document.getElementById("calFrom");
  const calTo   = document.getElementById("calTo");
  if (calFrom && !calFrom.value) calFrom.value = today();
  if (calTo   && !calTo.value)   calTo.value   = dateOffset(14);
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
      <label>Məbləğ<input name="total_amount" type="number" step="0.01" value="${b.total_amount}" required /></label>
      <label>Status<select name="status">
        ${["Reserved","CheckedIn","CheckedOut","Cancelled"].map((s) =>
          `<option ${s === b.status ? "selected" : ""}>${s}</option>`).join("")}
      </select></label>
      <label class="wide">Qeyd<input name="note" value="${escapeHtml(b.note || "")}" /></label>
      <button type="submit">💾 Yadda saxla</button>
    </form>
  `, async (data) => {
    await api(`/api/bookings/${id}`, { method: "PUT", body: JSON.stringify(data) });
    toast("Bron yeniləndi");
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
      <label>Kateqoriya<select name="category">
        ${["Kommunal","Təmir","Təmizlik","Ərzaq","Əmək haqqı","Digər"].map((c) =>
          `<option ${c === e.category ? "selected" : ""}>${c}</option>`).join("")}
      </select></label>
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
  const hOpts = state.hotels.map((h) =>
    `<option value="${h.id}" ${h.id === r.hotel_id ? "selected" : ""}>${escapeHtml(h.name)}</option>`).join("");
  openModal("Otağı redaktə et", `
    <form id="modalForm" class="form-grid">
      <label>Filial<select name="hotel_id">${hOpts}</select></label>
      <label>Nömrə<input name="number" value="${escapeHtml(r.number)}" required /></label>
      <label>Mərtəbə<input name="floor" type="number" min="1" value="${r.floor}" required /></label>
      <label>Tip<input name="room_type" value="${escapeHtml(r.room_type)}" required /></label>
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
    // temporarily replace guests for render
    const orig = state.guests;
    state.guests = filtered;
    renderGuests();
    state.guests = orig;
  }, 300);
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

// ─── Room form ────────────────────────────────────────────────
document.querySelector("#roomForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/rooms"); toast("Otaq əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});
document.querySelector("#hotelForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/hotels"); toast("Filial əlavə edildi"); }
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
  const data = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    await api(`/api/guests/${data.guest_id}/documents`, { method: "POST", body: JSON.stringify(data) });
    e.currentTarget.reset();
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

// Auto-calc on date / room change
["check_in", "check_out"].forEach((name) => {
  document.querySelector(`[name="${name}"]`)?.addEventListener("change", calcBookingAmount);
});
document.querySelector('[name="room_id"]')?.addEventListener("change", calcBookingAmount);

// ─── Payment form ─────────────────────────────────────────────
document.querySelector("#paymentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/payments"); toast("Ödəniş əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});

// ─── Expense form ─────────────────────────────────────────────
document.querySelector("#expenseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/expenses"); toast("Xərc əlavə edildi"); }
  catch (err) { toast(err.message, "error"); }
});

// ─── Public request form ──────────────────────────────────────
document.querySelector("#publicRequestForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await submitForm(e.currentTarget, "/api/public/booking-requests"); toast("Sorğu yaradıldı"); }
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
  const statusBtn  = e.target.closest("[data-status]");
  const lateFeeBtn = e.target.closest("[data-late-fee]");
  const editBtn    = e.target.closest("[data-edit-booking]");
  const delBtn     = e.target.closest("[data-del-booking]");

  if (lateFeeBtn) {
    const lateFee = prompt("Gec çıxış əlavə ödənişi (AZN):", "0");
    if (lateFee === null) return;
    try {
      await api(`/api/bookings/${lateFeeBtn.dataset.lateFee}/late-fee`, {
        method: "PATCH", body: JSON.stringify({ late_fee: lateFee }),
      });
      toast("Gecikmə ödənişi əlavə edildi");
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
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
  window.open("/api/export/monthly", "_blank");
});

// ─── Keyboard shortcut: Escape closes modal ───────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ─── Init ─────────────────────────────────────────────────────
checkSession();
