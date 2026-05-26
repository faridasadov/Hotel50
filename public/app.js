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
  document.querySelector('#publicRequestForm [name="check_in"]').value ||= today;
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
  const hotelOptions = state.hotels.map((h) => `<option value="${h.id}">${h.name}</option>`).join("");
  document.querySelector('[name="guest_id"]').innerHTML = guestOptions;
  document.querySelector('#documentForm [name="guest_id"]').innerHTML = guestOptions;
  document.querySelector('[name="room_id"]').innerHTML = roomOptions;
  document.querySelector('#roomForm [name="hotel_id"]').innerHTML = hotelOptions;
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
  table("#roomTable", ["Filial", "Otaq", "Mərtəbə", "Tip", "Tutum", "Dolu", "Boş", "Təmizlik", "Qiymət", "Əməl"], state.rooms.map((r) => `
    <tr>
      <td>${r.hotel_name || "-"}</td>
      <td><strong>${r.number}</strong></td>
      <td>${r.floor}</td>
      <td>${r.room_type}</td>
      <td>${r.capacity}</td>
      <td>${r.occupied}</td>
      <td>${r.free_beds}</td>
      <td>${r.cleaning_status || "Təmiz"}</td>
      <td>${money(r.nightly_rate)}</td>
      <td class="actions">
        <button data-cleaning="${r.id}:Təmiz">Təmiz</button>
        <button data-cleaning="${r.id}:Çirkli">Çirkli</button>
        <button data-cleaning="${r.id}:Təmizlikdə">Təmizlikdə</button>
        <button data-cleaning="${r.id}:Təmir lazımdır">Təmir</button>
      </td>
    </tr>
  `));
}

function renderCalendar() {
  table("#calendarTable", ["Otaq", "Tutum", "Aktiv bronlar"], state.calendar.rooms.map((r) => {
    const items = state.calendar.bookings.filter((b) => b.room_id === r.id)
      .map((b) => `#${b.id} ${b.guest_name}: ${b.check_in} → ${b.check_out} (${b.status})`).join("<br>");
    return `<tr><td><strong>${r.number}</strong></td><td>${r.capacity}</td><td>${items || "Boş"}</td></tr>`;
  }));
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
  table("#documentTable", ["Qonaq", "Sənəd", "Fayl", "Tarix", "Aç"], state.documents.map((d) => `
    <tr>
      <td>${d.guest_name}</td>
      <td>${d.title}</td>
      <td>${d.file_name}</td>
      <td>${d.created_at}</td>
      <td><a href="/api/documents/${d.id}" target="_blank">Aç</a></td>
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
        ${isAccounting() ? `<button data-late-fee="${b.id}">Gecikmə</button>` : ""}
      </td>
    </tr>
  `));
}

function renderDebtors() {
  table("#debtorTable", ["Qonaq", "Telefon", "Otaq", "Tarix", "Borc"], state.debtors.map((d) => `
    <tr>
      <td><strong>${d.guest_name}</strong></td>
      <td>${d.guest_phone || "-"}</td>
      <td>${d.room_number}</td>
      <td>${d.check_in} → ${d.check_out}</td>
      <td>${money(d.balance)}</td>
    </tr>
  `));
}

function renderPayments() {
  table("#paymentTable", ["Tarix", "Qonaq", "Otaq", "Məbləğ", "Metod", "Qeyd", "Qəbz"], state.payments.map((p) => `
    <tr>
      <td>${p.paid_at}</td>
      <td>${p.guest_name}</td>
      <td>${p.room_number}</td>
      <td>${money(p.amount)}</td>
      <td>${p.method}</td>
      <td>${p.note || "-"}</td>
      <td><a href="/api/receipts/${p.id}" target="_blank">Aç</a></td>
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

function renderRequests() {
  table("#requestTable", ["Tarix", "Ad", "Telefon", "Tarix aralığı", "Nəfər", "Status", "Əməl"], state.requests.map((r) => `
    <tr>
      <td>${r.created_at}</td>
      <td><strong>${r.full_name}</strong></td>
      <td>${r.phone || "-"}</td>
      <td>${r.check_in || "-"} → ${r.check_out || "-"}</td>
      <td>${r.people_count}</td>
      <td><span class="status ${r.status}">${r.status}</span></td>
      <td class="actions">
        <button data-request-status="${r.id}:Baxılır">Baxılır</button>
        <button data-request-status="${r.id}:Təsdiq">Təsdiq</button>
        <button data-request-status="${r.id}:İmtina">İmtina</button>
      </td>
    </tr>
  `));
}

function renderReminders() {
  const rows = [
    ...state.reminders.debtors.map((d) => `<tr><td>Borc</td><td>${d.guest_name}</td><td>${money(d.balance)}</td><td><a href="${d.whatsapp_url}" target="_blank">WhatsApp</a></td></tr>`),
    ...state.reminders.arrivals.map((b) => `<tr><td>Giriş</td><td>${b.guest_name}</td><td>${b.check_in}</td><td>-</td></tr>`),
    ...state.reminders.departures.map((b) => `<tr><td>Çıxış</td><td>${b.guest_name}</td><td>${b.check_out}</td><td>-</td></tr>`),
  ];
  table("#reminderTable", ["Tip", "Qonaq", "Məlumat", "Link"], rows);
}

function renderBackups() {
  table("#backupTable", ["Seç", "Fayl", "Ölçü", "Əməl"], state.backups.map((b) => `
    <tr>
      <td><input type="checkbox" data-backup-check="${b.name}"></td>
      <td><strong>${b.name}</strong></td>
      <td>${b.size} bayt</td>
      <td class="actions">
        <button data-restore="${b.name}">Restore</button>
        <button data-delete-backup="${b.name}">Sil</button>
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

async function loadAll() {
  const requests = [
    api("/api/summary"),
    api("/api/rooms"),
    api("/api/hotels"),
    api("/api/guests"),
    api("/api/documents"),
    api("/api/bookings"),
    api("/api/calendar"),
    api("/api/debtors"),
    api("/api/payments"),
    api("/api/booking-requests"),
    api("/api/reminders"),
  ];
  if (isAccounting()) {
    requests.push(api("/api/expenses"));
  }
  if (isAdmin()) {
    requests.push(api("/api/users"), api("/api/audit"), api("/api/backups"));
  }
  const result = await Promise.all(requests);
  const [summary, rooms, hotels, guests, documents, bookings, calendar, debtors, payments, bookingRequests, reminders] = result;
  let index = 11;
  const expenses = isAccounting() ? result[index++] : [];
  const users = isAdmin() ? result[index++] : [];
  const audit = isAdmin() ? result[index++] : [];
  const backups = isAdmin() ? result[index++] : [];
  Object.assign(state, { summary, rooms, hotels, guests, documents, bookings, calendar, debtors, payments, requests: bookingRequests, reminders });
  if (isAccounting()) Object.assign(state, { expenses });
  if (isAdmin()) Object.assign(state, { users, audit, backups });
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
document.querySelector("#hotelForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/hotels").catch((err) => alert(err.message));
});
document.querySelector("#guestForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/guests").catch((err) => alert(err.message));
});
document.querySelector("#documentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.currentTarget);
  await api(`/api/guests/${data.guest_id}/documents`, { method: "POST", body: JSON.stringify(data) }).catch((err) => alert(err.message));
  event.currentTarget.reset();
  await loadAll();
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
document.querySelector("#publicRequestForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/public/booking-requests").catch((err) => alert(err.message));
});
document.querySelector("#userForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/api/users").catch((err) => alert(err.message));
});
document.querySelector("#bookingTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-status]");
  const lateButton = event.target.closest("[data-late-fee]");
  if (lateButton) {
    const late_fee = prompt("Gec çıxış əlavə ödənişi (AZN)", "0");
    if (late_fee === null) return;
    await api(`/api/bookings/${lateButton.dataset.lateFee}/late-fee`, { method: "PATCH", body: JSON.stringify({ late_fee }) });
    await loadAll();
    return;
  }
  if (!button) return;
  const [id, status] = button.dataset.status.split(":");
  await api(`/api/bookings/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
  await loadAll();
});
document.querySelector("#roomTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cleaning]");
  if (!button) return;
  const [id, cleaning_status] = button.dataset.cleaning.split(":");
  await api(`/api/rooms/${id}/cleaning`, { method: "PATCH", body: JSON.stringify({ cleaning_status }) });
  await loadAll();
});
document.querySelector("#requestTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-request-status]");
  if (!button) return;
  const [id, status] = button.dataset.requestStatus.split(":");
  await api(`/api/booking-requests/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
  await loadAll();
});
document.querySelector("#backupTable").addEventListener("click", async (event) => {
  const restoreButton = event.target.closest("[data-restore]");
  const deleteButton = event.target.closest("[data-delete-backup]");
  if (restoreButton) {
    if (!confirm(`${restoreButton.dataset.restore} backup-dan bərpa edilsin?`)) return;
    await api("/api/restore", { method: "POST", body: JSON.stringify({ name: restoreButton.dataset.restore }) });
    await loadAll();
    return;
  }
  if (deleteButton) {
    if (!confirm(`${deleteButton.dataset.deleteBackup} silinsin?`)) return;
    await api(`/api/backups/${encodeURIComponent(deleteButton.dataset.deleteBackup)}`, { method: "DELETE" });
    await loadAll();
  }
});
document.querySelector("#deleteSelectedBackupsBtn").addEventListener("click", async () => {
  const names = [...document.querySelectorAll("[data-backup-check]:checked")].map((item) => item.dataset.backupCheck);
  if (!names.length) {
    alert("Silinəcək backup seçilməyib.");
    return;
  }
  if (!confirm(`${names.length} backup silinsin?`)) return;
  await api("/api/backups/delete", { method: "POST", body: JSON.stringify({ names }) });
  await loadAll();
});
document.querySelector("#exportBtn").addEventListener("click", () => {
  window.open("/api/export/monthly", "_blank");
});
document.querySelector("#createBackupBtn").addEventListener("click", async () => {
  await api("/api/backup");
  await loadAll();
});

setTodayDefaults();
checkSession();
