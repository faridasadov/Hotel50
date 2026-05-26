const api = (path, options = {}) =>
  fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  }).then(async (res) => {
    const data = await res.json();
    if (res.status === 401) showLogin();
    if (!res.ok) throw new Error(data.error || "Server xətası");
    return data;
  });

const state = {
  user: null,
  summary: {},
  rooms: [],
  guests: [],
  bookings: [],
  payments: [],
  expenses: [],
  proposals: [],
  users: [],
  audit: [],
};

const money = (value) => `${Number(value || 0).toFixed(2)} AZN`;

function showLogin() {
  document.querySelector("#loginScreen").classList.remove("hidden");
}

function hideLogin() {
  document.querySelector("#loginScreen").classList.add("hidden");
}

function isAdmin() {
  return state.user?.role === "Admin";
}

function isAccounting() {
  return ["Admin", "Accounting"].includes(state.user?.role);
}

function applyPermissions() {
  document.querySelector("#userChip").textContent = state.user ? `${state.user.full_name} · ${state.user.role}` : "";
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin()));
  document.querySelectorAll(".accounting-only").forEach((el) => el.classList.toggle("hidden", !isAccounting()));
  document.querySelector("#backupBtn").classList.toggle("hidden", !isAdmin());
  document.querySelector("#paymentForm").classList.toggle("hidden", !isAccounting());
  document.querySelector("#expenseForm")?.classList.toggle("hidden", !isAccounting());
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setTodayDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  document.querySelector('[name="check_in"]').value ||= today;
  document.querySelector('[name="paid_at"]').value ||= today;
  document.querySelector('[name="spent_at"]').value ||= today;
}

function renderStats() {
  const s = state.summary;
  document.querySelector("#stats").innerHTML = [
    ["Boş yataq", `${s.free_beds || 0}/${s.total_beds || 0}`],
    ["Aktiv qonaq", s.active_guests || 0],
    ["Bu gün giriş", s.arrivals_today || 0],
    ["Qalıq borc", money(s.debt)],
    ["Aylıq gəlir", money(s.month_income)],
    ["Aylıq xərc", money(s.month_expense)],
    ["Aylıq net", money(s.month_profit)],
  ].map(([label, value]) => `<article class="stat"><strong>${value}</strong><span>${label}</span></article>`).join("");
}

function optionLists() {
  const guestOptions = state.guests.map((g) => `<option value="${g.id}">${g.full_name} ${g.phone ? `- ${g.phone}` : ""}</option>`).join("");
  const roomOptions = state.rooms.map((r) => `<option value="${r.id}">${r.number} - boş ${r.free_beds}/${r.capacity}</option>`).join("");
  document.querySelector('[name="guest_id"]').innerHTML = guestOptions;
  document.querySelector('[name="room_id"]').innerHTML = roomOptions;
  document.querySelector('[name="booking_id"]').innerHTML = state.bookings
    .map((b) => `<option value="${b.id}">#${b.id} ${b.guest_name} / ${b.room_number} / borc ${money(b.balance)}</option>`)
    .join("");
}

function table(target, headers, rows) {
  document.querySelector(target).innerHTML = `
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="${headers.length}">Məlumat yoxdur</td></tr>`}</tbody>
  `;
}

function renderRooms() {
  table("#roomTable", ["Otaq", "Mərtəbə", "Tip", "Tutum", "Dolu", "Boş", "Qiymət"], state.rooms.map((r) => `
    <tr>
      <td><strong>${r.number}</strong></td>
      <td>${r.floor}</td>
      <td>${r.room_type}</td>
      <td>${r.capacity}</td>
      <td>${r.occupied}</td>
      <td>${r.free_beds}</td>
      <td>${money(r.nightly_rate)}</td>
    </tr>
  `));
}

function renderGuests() {
  table("#guestTable", ["Ad soyad", "Telefon", "Sənəd", "Qeyd"], state.guests.map((g) => `
    <tr>
      <td><strong>${g.full_name}</strong></td>
      <td>${g.phone || "-"}</td>
      <td>${g.document_no || "-"}</td>
      <td>${g.note || "-"}</td>
    </tr>
  `));
}

function renderBookings() {
  table("#bookingTable", ["#", "Qonaq", "Otaq", "Tarix", "Status", "Məbləğ", "Ödənilib", "Borc", "Əməl"], state.bookings.map((b) => `
    <tr>
      <td>${b.id}</td>
      <td><strong>${b.guest_name}</strong><br>${b.guest_phone || ""}</td>
      <td>${b.room_number} (${b.people_count} nəfər)</td>
      <td>${b.check_in} → ${b.check_out}</td>
      <td><span class="status ${b.status}">${b.status}</span></td>
      <td>${money(b.total_amount)}</td>
      <td>${money(b.paid_amount)}</td>
      <td>${money(b.balance)}</td>
      <td class="actions">
        <button data-status="${b.id}:CheckedIn">Giriş</button>
        <button data-status="${b.id}:CheckedOut">Çıxış</button>
        <button data-status="${b.id}:Cancelled">Ləğv</button>
      </td>
    </tr>
  `));
}

function renderPayments() {
  table("#paymentTable", ["Tarix", "Qonaq", "Otaq", "Məbləğ", "Metod", "Qeyd"], state.payments.map((p) => `
    <tr>
      <td>${p.paid_at}</td>
      <td>${p.guest_name}</td>
      <td>${p.room_number}</td>
      <td>${money(p.amount)}</td>
      <td>${p.method}</td>
      <td>${p.note || "-"}</td>
    </tr>
  `));
}

function renderExpenses() {
  table("#expenseTable", ["Tarix", "Kateqoriya", "Məbləğ", "Qeyd"], state.expenses.map((e) => `
    <tr>
      <td>${e.spent_at}</td>
      <td><strong>${e.category}</strong></td>
      <td>${money(e.amount)}</td>
      <td>${e.note || "-"}</td>
    </tr>
  `));
}

function renderProposals() {
  table("#proposalTable", ["#", "Təklif", "Kateqoriya", "Prioritet", "Status", "Əməl"], state.proposals.map((p) => `
    <tr>
      <td>${p.id}</td>
      <td><strong>${p.title}</strong><br>${p.description || ""}</td>
      <td>${p.category}</td>
      <td>${p.priority}</td>
      <td><span class="status ${p.status}">${p.status}</span></td>
      <td class="actions">
        ${isAdmin() ? `
          <button data-proposal-status="${p.id}:Seçildi">Seç</button>
          <button data-proposal-status="${p.id}:İcrada">İcrada</button>
          <button data-proposal-status="${p.id}:Hazır">Hazır</button>
          <button data-proposal-status="${p.id}:Gözləyir">Gözlət</button>
        ` : "-"}
      </td>
    </tr>
  `));
}

function renderUsers() {
  table("#userTable", ["Username", "Ad soyad", "Rol", "Aktiv", "Yaradıldı"], state.users.map((u) => `
    <tr>
      <td><strong>${u.username}</strong></td>
      <td>${u.full_name}</td>
      <td>${u.role}</td>
      <td>${u.active ? "Bəli" : "Xeyr"}</td>
      <td>${u.created_at}</td>
    </tr>
  `));
}

function renderAudit() {
  table("#auditTable", ["Tarix", "İstifadəçi", "Əməl", "Obyekt", "ID"], state.audit.map((a) => `
    <tr>
      <td>${a.created_at}</td>
      <td>${a.username}</td>
      <td>${a.action}</td>
      <td>${a.entity}</td>
      <td>${a.entity_id || "-"}</td>
    </tr>
  `));
}

function renderAll() {
  applyPermissions();
  renderStats();
  optionLists();
  renderRooms();
  renderGuests();
  renderBookings();
  renderPayments();
  if (isAccounting()) renderExpenses();
  renderProposals();
  if (isAdmin()) {
    renderUsers();
    renderAudit();
  }
}

async function loadAll() {
  const requests = [
    api("/api/summary"),
    api("/api/rooms"),
    api("/api/guests"),
    api("/api/bookings"),
    api("/api/payments"),
    api("/api/proposals"),
  ];
  if (isAccounting()) {
    requests.push(api("/api/expenses"));
  }
  if (isAdmin()) {
    requests.push(api("/api/users"), api("/api/audit"));
  }
  const result = await Promise.all(requests);
  const [summary, rooms, guests, bookings, payments] = result;
  let index = 5;
  const proposals = result[index++];
  const expenses = isAccounting() ? result[index++] : [];
  const users = isAdmin() ? result[index++] : [];
  const audit = isAdmin() ? result[index++] : [];
  Object.assign(state, { summary, rooms, guests, bookings, payments, proposals });
  if (isAccounting()) Object.assign(state, { expenses });
  if (isAdmin()) Object.assign(state, { users, audit });
  renderAll();
}

async function checkSession() {
  try {
    const session = await api("/api/auth/session");
    state.user = session.user;
    hideLogin();
    await loadAll();
  } catch {
    showLogin();
  }
}

async function submitForm(form, path) {
  await api(path, { method: "POST", body: JSON.stringify(formData(form)) });
  form.reset();
  setTodayDefaults();
  await loadAll();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, .panel").forEach((el) => el.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
  });
});

document.querySelector("#refreshBtn").addEventListener("click", loadAll);
document.querySelector("#backupBtn").addEventListener("click", async () => {
  try {
    const backup = await api("/api/backup");
    alert(`Backup yaradıldı: ${backup.name}`);
  } catch (err) {
    alert(err.message);
  }
});
document.querySelector("#logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
  showLogin();
});
document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#loginError");
  error.textContent = "";
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    const session = await api("/api/auth/session");
    state.user = session.user;
    hideLogin();
    await loadAll();
  } catch (err) {
    error.textContent = err.message;
  }
});
document.querySelector("#roomForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/rooms").catch((err) => alert(err.message));
});
document.querySelector("#guestForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/guests").catch((err) => alert(err.message));
});
document.querySelector("#bookingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/bookings").catch((err) => alert(err.message));
});
document.querySelector("#paymentForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/payments").catch((err) => alert(err.message));
});
document.querySelector("#expenseForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/expenses").catch((err) => alert(err.message));
});
document.querySelector("#proposalForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/proposals").catch((err) => alert(err.message));
});
document.querySelector("#userForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/users").catch((err) => alert(err.message));
});
document.querySelector("#bookingTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-status]");
  if (!button) return;
  const [id, status] = button.dataset.status.split(":");
  await api(`/api/bookings/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
  await loadAll();
});
document.querySelector("#proposalTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-proposal-status]");
  if (!button) return;
  const [id, status] = button.dataset.proposalStatus.split(":");
  await api(`/api/proposals/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
  await loadAll();
});

setTodayDefaults();
checkSession();
