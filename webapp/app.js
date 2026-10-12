"use strict";

const tg = window.Telegram?.WebApp;
if (tg && tg.initData) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor("#F5F5F3"); tg.setBackgroundColor("#F5F5F3"); } catch (_) {}
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const WEEKDAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

const $ = (id) => document.getElementById(id);
const state = {
  today: null,          // "YYYY-MM-DD" у часовому поясі користувача
  selected: null,
  view: { y: 0, m: 0 }, // місяць, що відображається
  byDate: {},           // date -> [task]
  overdue: [],
  todayTasks: [],
  name: "",
  page: "today",
  editing: null,        // завдання, що редагується, або null
};

/* ---------- дати (рядки YYYY-MM-DD, рахуємо в UTC, щоб уникнути DST) ---------- */
const toDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toStr = (dt) => dt.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return toStr(d); };
const pad = (n) => String(n).padStart(2, "0");
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const human = (s) => { const d = toDate(s); return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`; };
const weekday = (s) => WEEKDAYS[toDate(s).getUTCDay()];

/* ---------- API ---------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": tg?.initData || "",
      "X-Timezone": TZ,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function haptic(kind) {
  try {
    if (kind === "success") tg?.HapticFeedback?.notificationOccurred("success");
    else tg?.HapticFeedback?.impactOccurred(kind || "light");
  } catch (_) {}
}

function showError(e) {
  console.error(e);
  const msg = String(e.message).startsWith("401")
    ? "Відкрийте планер через кнопку в боті Telegram."
    : "Не вдалося звʼязатися із сервером. Спробуйте ще раз.";
  tg?.showAlert ? tg.showAlert(msg) : alert(msg);
}

/* ---------- завантаження ---------- */
function gridRange() {
  const first = new Date(Date.UTC(state.view.y, state.view.m, 1));
  const shift = (first.getUTCDay() + 6) % 7; // понеділок — перший день
  const start = addDays(toStr(first), -shift);
  return { start, end: addDays(start, 41) };
}

async function loadMonth() {
  const { start, end } = gridRange();
  const tasks = await api("GET", `/api/tasks?from=${start}&to=${end}`);
  state.byDate = {};
  for (const t of tasks) (state.byDate[t.date] ||= []).push(t);
}

async function loadToday() {
  const [tasks, overdue] = await Promise.all([
    api("GET", `/api/tasks?from=${state.today}&to=${state.today}`),
    api("GET", `/api/overdue?today=${state.today}`),
  ]);
  state.todayTasks = tasks;
  state.overdue = overdue;
}

async function reload() {
  await Promise.all([loadMonth(), loadToday()]);
  render();
}

/* ---------- відображення ---------- */
function render() { renderToday(); renderCalendar(); renderCalendarDay(); }

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* Фрази привітання за часом доби. {name} — імʼя; без імені фраза скорочується. */
const GREETINGS = {
  morning: [ // 05:00–11:59
    "Доброго ранку, {name}",
    "Гарного ранку, {name}",
    "Ранок добрий, {name}",
    "З новим днем, {name}",
    "Прокидаємось, {name}",
    "Кава й план — і вперед, {name}",
    "Новий день — нові можливості, {name}",
  ],
  day: [ // 12:00–17:59
    "Добрий день, {name}",
    "Гарного дня, {name}",
    "Як минає день, {name}?",
    "Вітаю, {name}",
    "Продуктивного дня, {name}",
    "Тримаємо темп, {name}",
    "Половина дня позаду, {name}",
  ],
  evening: [ // 18:00–22:59
    "Добрий вечір, {name}",
    "Гарного вечора, {name}",
    "Час підбити підсумки, {name}",
    "Ще трохи — і відпочинок, {name}",
    "Затишного вечора, {name}",
    "Як пройшов день, {name}?",
  ],
  night: [ // 23:00–04:59
    "Доброї ночі, {name}",
    "Не спиться, {name}?",
    "Пізно вже, {name}",
    "Час відпочивати, {name}",
    "Тихої ночі, {name}",
  ],
};

function dayPart(h = new Date().getHours()) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "day";
  if (h >= 18 && h < 23) return "evening";
  return "night";
}

function fillName(phrase, name) {
  if (name) return phrase.replace("{name}", name);
  return phrase.replace(/,?\s*\{name\}/, "").replace(/\s+([?!.])$/, "$1");
}

// Фраза обирається випадково один раз на частину доби (щоб не мигтіла при кожному оновленні)
// і не повторює попередню.
const greetingCache = { part: null, phrase: null };
function greeting() {
  const part = dayPart();
  if (greetingCache.part !== part) {
    const pool = GREETINGS[part];
    let last = null;
    try { last = localStorage.getItem("greeting"); } catch (_) {}
    const options = pool.length > 1 ? pool.filter((p) => p !== last) : pool;
    greetingCache.part = part;
    greetingCache.phrase = options[Math.floor(Math.random() * options.length)];
    try { localStorage.setItem("greeting", greetingCache.phrase); } catch (_) {}
  }
  return fillName(greetingCache.phrase, state.name);
}

// Спільний список справ дня: відкриті, порожній стан, згорнуті виконані
function renderDayList(prefix, ds, tasks) {
  const isToday = ds === state.today;
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const late = (t) => (isToday && t.time && t.time < nowHM()) || ds < state.today;

  $(`${prefix}-taskList`).replaceChildren(...open.map((t) => taskRow(t, { late: late(t) })));
  $(`${prefix}-doneList`).replaceChildren(...done.map((t) => taskRow(t)));
  $(`${prefix}-doneBlock`).hidden = !done.length;
  $(`${prefix}-doneSummary`).textContent = `Виконано · ${done.length}`;

  const empty = $(`${prefix}-empty`);
  empty.hidden = open.length > 0;
  empty.textContent = tasks.length ? "Усе виконано" : isToday ? "На сьогодні планів немає" : "Нічого не заплановано";
  return { open, done };
}

function renderToday() {
  const tasks = state.todayTasks;
  $("greeting").textContent = greeting();
  $("todayDate").textContent = `${weekday(state.today)}, ${human(state.today)}`;

  const { open, done } = renderDayList("t", state.today, tasks);
  const n = tasks.length;
  $("summary").textContent = !n
    ? "Можна відпочити або запланувати щось нове."
    : !open.length
      ? `Усі ${n} ${plural(n, "справу", "справи", "справ")} виконано. Чудовий день!`
      : `На сьогодні ${open.length === n ? "" : "залишилось "}${open.length} ${plural(open.length, "справа", "справи", "справ")}` +
        (done.length ? ` з ${n}` : "") + ".";
  $("summaryBar").hidden = !n;
  $("summaryBar").firstElementChild.style.width = n ? `${(done.length / n) * 100}%` : "0";
  $("t-listTitle").hidden = !open.length;

  const showOverdue = state.overdue.length > 0;
  $("t-overdue").hidden = !showOverdue;
  $("t-overdueList").replaceChildren(...state.overdue.map((t) => taskRow(t, { overdue: true })));

  const badge = $("todayBadge");
  badge.hidden = !open.length;
  badge.textContent = open.length;
}

function renderCalendar() {
  $("monthTitle").textContent = `${MONTHS[state.view.m]} ${state.view.y}`;
  const { start } = gridRange();
  const grid = $("grid");
  grid.replaceChildren();
  for (let i = 0; i < 42; i++) {
    const ds = addDays(start, i);
    const d = toDate(ds);
    const cell = document.createElement("button");
    cell.className = "cell";
    if (d.getUTCMonth() !== state.view.m) cell.classList.add("other");
    if (ds === state.today) cell.classList.add("today");
    if (ds === state.selected) cell.classList.add("selected");
    cell.innerHTML = `<span class="num">${d.getUTCDate()}</span><span class="dots"></span>`;

    const tasks = state.byDate[ds] || [];
    const open = tasks.filter((t) => !t.done);
    const dots = cell.querySelector(".dots");
    if (tasks.length && !open.length) {
      dots.innerHTML = `<i class="dot done"></i>`;
    } else {
      const cls = ds < state.today ? "dot late" : "dot";
      dots.innerHTML = open.slice(0, 3).map(() => `<i class="${cls}"></i>`).join("");
    }
    cell.onclick = () => selectDay(ds);
    grid.append(cell);
  }
  const t = toDate(state.today);
  const viewingToday = state.selected === state.today && t.getUTCMonth() === state.view.m && t.getUTCFullYear() === state.view.y;
  $("gotoToday").hidden = viewingToday;
}

function renderCalendarDay() {
  const ds = state.selected;
  const isToday = ds === state.today;
  const rel = isToday ? "Сьогодні" : ds === addDays(state.today, 1) ? "Завтра" : ds === addDays(state.today, -1) ? "Вчора" : weekday(ds);
  $("dayLabel").textContent = rel;
  $("dayTitle").textContent = isToday ? `${weekday(ds)}, ${human(ds)}` : human(ds);

  const tasks = state.byDate[ds] || [];
  const { done } = renderDayList("c", ds, tasks);

  $("progress").hidden = !tasks.length;
  if (tasks.length) {
    const c = 2 * Math.PI * 15;
    const bar = $("progressBar");
    bar.style.strokeDasharray = c;
    bar.style.strokeDashoffset = c * (1 - done.length / tasks.length);
    $("progressText").textContent = `${done.length}/${tasks.length}`;
  }
}

function taskRow(t, opts = {}) {
  const li = document.createElement("li");
  li.className = "task" + (t.done ? " done" : "");
  li.dataset.id = t.id;

  const check = document.createElement("button");
  check.className = "check";
  check.setAttribute("aria-label", t.done ? "Повернути в роботу" : "Позначити виконаним");
  check.onclick = (e) => { e.stopPropagation(); toggleDone(t, li, check); };

  const body = document.createElement("div");
  body.className = "task-body";
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = t.title;
  const meta = document.createElement("div");
  meta.className = "task-meta";
  if (opts.overdue) meta.append(Object.assign(document.createElement("span"), { textContent: human(t.date) }));
  if (t.note) meta.append(Object.assign(document.createElement("span"), { className: "note", textContent: t.note }));
  body.append(title);
  if (meta.childElementCount) body.append(meta);
  body.onclick = () => openSheet(t);

  li.append(check);
  if (t.time) li.append(Object.assign(document.createElement("span"), { className: "time" + (opts.late && !t.done ? " late" : ""), textContent: t.time }));
  li.append(body);

  if (opts.overdue) {
    const move = document.createElement("button");
    move.className = "move-btn";
    move.textContent = "На сьогодні";
    move.onclick = (e) => { e.stopPropagation(); moveToToday(t); };
    li.append(move);
  }
  return li;
}

/* ---------- дії ---------- */
function selectDay(ds) {
  state.selected = ds;
  const d = toDate(ds);
  if (d.getUTCMonth() !== state.view.m || d.getUTCFullYear() !== state.view.y) {
    state.view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    loadMonth().then(render).catch(showError);
  } else {
    render();
  }
  haptic("light");
}

function shiftMonth(n) {
  const d = new Date(Date.UTC(state.view.y, state.view.m + n, 1));
  state.view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  loadMonth().then(renderCalendar).catch(showError);
}

async function toggleDone(t, li, check) {
  const next = !t.done;
  haptic(next ? "success" : "light");
  if (next) { check.classList.add("on"); li.classList.add("leaving"); await new Promise((r) => setTimeout(r, 260)); }
  try {
    const updated = await api("PATCH", `/api/tasks/${t.id}`, { done: next });
    await reload();
    if (next) toast(`«${updated.title}» виконано`, async () => {
      await api("PATCH", `/api/tasks/${t.id}`, { done: false });
      await reload();
    });
  } catch (e) { showError(e); render(); }
}

async function moveToToday(t) {
  haptic("light");
  try {
    await api("PATCH", `/api/tasks/${t.id}`, { date: state.today });
    await reload();
  } catch (e) { showError(e); }
}

let toastTimer;
function toast(text, undo) {
  const el = $("toast");
  $("toastText").textContent = text;
  $("toastUndo").hidden = !undo;
  $("toastUndo").onclick = async () => { el.hidden = true; try { await undo(); } catch (e) { showError(e); } };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

/* ---------- форма ---------- */
const form = $("sheet");

function openSheet(task) {
  state.editing = task || null;
  $("sheetTitle").textContent = task ? "Редагувати" : "Нове завдання";
  form.elements.title.value = task?.title || "";
  form.elements.date.value = task?.date || (state.page === "calendar" ? state.selected : state.today);
  form.elements.time.value = task?.time || "";
  form.elements.note.value = task?.note || "";
  $("deleteBtn").hidden = !task;
  $("backdrop").hidden = false;
  form.hidden = false;
  tg?.BackButton?.show();
  if (!task) setTimeout(() => form.elements.title.focus(), 50);
}

function closeSheet() {
  form.hidden = true;
  $("backdrop").hidden = true;
  tg?.BackButton?.hide();
  state.editing = null;
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const data = {
    title: form.elements.title.value.trim(),
    date: form.elements.date.value,
    time: form.elements.time.value || null,
    note: form.elements.note.value.trim(),
  };
  if (!data.title || !data.date) return;
  $("saveBtn").disabled = true;
  try {
    if (state.editing) await api("PATCH", `/api/tasks/${state.editing.id}`, data);
    else await api("POST", "/api/tasks", data);
    haptic("success");
    closeSheet();
    if (state.page === "calendar" && data.date !== state.selected) selectDay(data.date);
    await reload();
  } catch (err) { showError(err); }
  finally { $("saveBtn").disabled = false; }
};

$("deleteBtn").onclick = () => {
  const t = state.editing;
  const doDelete = async (ok) => {
    if (!ok) return;
    try { await api("DELETE", `/api/tasks/${t.id}`); closeSheet(); await reload(); haptic("medium"); }
    catch (e) { showError(e); }
  };
  if (tg?.showConfirm && tg.initData) tg.showConfirm(`Видалити «${t.title}»?`, doDelete);
  else doDelete(confirm(`Видалити «${t.title}»?`));
};

$("cancelBtn").onclick = closeSheet;
$("backdrop").onclick = closeSheet;
tg?.BackButton?.onClick(closeSheet);
$("addBtn").onclick = () => openSheet(null);
$("prevMonth").onclick = () => shiftMonth(-1);
$("nextMonth").onclick = () => shiftMonth(1);
$("gotoToday").onclick = () => selectDay(state.today);

/* ---------- нижнє меню ---------- */
function showPage(page) {
  state.page = page;
  for (const p of ["today", "calendar"]) $(`page-${p}`).hidden = p !== page;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  try { localStorage.setItem("page", page); } catch (_) {}
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { if (state.page !== b.dataset.page) { haptic("light"); showPage(b.dataset.page); } }));
let savedPage = "today";
try { savedPage = localStorage.getItem("page") || "today"; } catch (_) {}
showPage(savedPage === "calendar" ? "calendar" : "today");

/* ---------- старт ---------- */
async function init() {
  try {
    const me = await api("GET", "/api/me");
    const dayChanged = state.today && state.today !== me.today;
    state.today = me.today;
    state.name = tg?.initDataUnsafe?.user?.first_name || me.first_name || "";
    if (!state.selected || dayChanged) {
      state.selected = me.today;
      const d = toDate(me.today);
      state.view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    }
    await reload();
  } catch (e) { showError(e); }
}

// повернулися в застосунок (наприклад, наступного дня) — оновимо дані
document.addEventListener("visibilitychange", () => { if (!document.hidden) init(); });
init();
