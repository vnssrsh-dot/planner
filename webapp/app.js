"use strict";

const tg = window.Telegram?.WebApp;
if (tg && tg.initData) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor("#F4F2EE"); tg.setBackgroundColor("#F4F2EE"); } catch (_) {}
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
  habits: [],           // [{id, title, kind, start_date, marks: [date]}]
  habitSel: null,       // id вибраної звички
  editingHabit: null,
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
    keepalive: method !== "GET", // зміни дійдуть, навіть якщо застосунок закрили одразу після тапу
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

/* ---------- синхронізація з сервером ----------
   Екран — головний: зміна одразу показується, а запити йдуть на сервер СТРОГО по черзі.
   Дані з сервера підтягуємо лише коли черга порожня — інакше старша відповідь
   перезаписала б свіжі натискання (саме так «стрибали» відмітки при швидкому тапі). */
// Черги окремі для кожного «ключа» (день звички, справа): різні дні йдуть паралельно,
// а натискання по тому самому дню — строго по порядку, тож перемагає останнє.
const writeChains = new Map();
let pendingWrites = 0;
let syncTimer = null;

function write(key, fn) {
  pendingWrites++;
  const prev = writeChains.get(key) || Promise.resolve();
  const p = prev.then(fn).finally(() => {
    pendingWrites--;
    if (writeChains.get(key) === settled) writeChains.delete(key);
    if (!pendingWrites) syncSoon();
  });
  const settled = p.catch(() => {});
  writeChains.set(key, settled);
  return p;
}

// Невдала зміна: показуємо помилку і повертаємо екран до того, що насправді на сервері
function writeFailed(e) {
  showError(e);
  syncSoon(0);
}

function syncSoon(delay = 400) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => reload().catch(showError), delay);
}

let monthSeq = 0;
async function loadMonth({ force = false } = {}) {
  const seq = ++monthSeq;
  const { start, end } = gridRange();
  const tasks = await api("GET", `/api/tasks?from=${start}&to=${end}`);
  // застаріла відповідь (місяць уже перегорнули) або йдуть зміни — не перезаписуємо екран
  if (seq !== monthSeq || (!force && pendingWrites)) return false;
  state.byDate = {};
  for (const t of tasks) (state.byDate[t.date] ||= []).push(t);
  return true;
}

let reloadSeq = 0;
async function reload() {
  const seq = ++reloadSeq;
  const [, today, overdue, habits] = await Promise.all([
    loadMonth(),
    api("GET", `/api/tasks?from=${state.today}&to=${state.today}`),
    api("GET", `/api/overdue?today=${state.today}`),
    api("GET", "/api/habits"),
  ]);
  if (seq !== reloadSeq) return;            // є новіше оновлення
  if (pendingWrites) return;                // підтягнемо, коли черга змін спорожніє
  state.todayTasks = today;
  state.overdue = overdue;
  state.habits = habits;
  render();
}

// Локально змінити справу всюди, де вона показана (сьогодні, календар, хвости)
function patchLocalTask(id, fields) {
  const lists = [state.todayTasks, state.overdue, ...Object.values(state.byDate)];
  let task = null;
  for (const list of lists) for (const t of list) if (t.id === id) { Object.assign(t, fields); task ||= t; }
  if (!task) return;
  // перенесення на іншу дату — переставляємо між списками
  state.overdue = state.overdue.filter((t) => !t.done && t.date < state.today);
  state.todayTasks = state.todayTasks.filter((t) => t.date === state.today);
  for (const d of Object.keys(state.byDate)) state.byDate[d] = state.byDate[d].filter((t) => t.date === d);
  const copy = { ...task };
  if (copy.date === state.today && !state.todayTasks.some((t) => t.id === id)) state.todayTasks.push(copy);
  if (state.byDate[copy.date] !== undefined || gridHas(copy.date)) {
    const list = (state.byDate[copy.date] ||= []);
    if (!list.some((t) => t.id === id)) list.push({ ...copy });
  }
  const byTime = (a, b) => (a.time === null) - (b.time === null) || (a.time || "").localeCompare(b.time || "") || a.id - b.id;
  state.todayTasks.sort(byTime);
  for (const d of Object.keys(state.byDate)) state.byDate[d].sort(byTime);
}

function gridHas(ds) {
  const { start, end } = gridRange();
  return ds >= start && ds <= end;
}

let renderTimer = null;
function renderSoon(delay) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, delay);
}

/* ---------- відображення ---------- */
function render() { renderToday(); renderCalendar(); renderCalendarDay(); renderHabits(); }

// Змінює текст і коротко «підстрибує», якщо значення справді змінилось
function setText(el, text) {
  if (el.textContent === text) return;
  const had = el.textContent !== "";
  el.textContent = text;
  if (had) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* Фрази привітання. {name} — імʼя; без імені фраза скорочується.
   ANYTIME — дружні, підходять будь-коли; решта — під час доби. Обидва набори змішуються. */
const ANYTIME = [
  "Привіт, {name}",
  "Привітик, {name}",
  "Привіт-привіт, {name}",
  "Вітаю, {name}",
  "Вітаю вас, {name}",
  "Мої вітання, {name}",
  "Рада бачити, {name}",
  "Рада тебе бачити, {name}",
  "З поверненням, {name}",
  "Салют, {name}",
  "Хей, {name}",
  "Здоровенькі були, {name}",
  "Як справи, {name}?",
  "Як ся маєш, {name}?",
  "Ну що, {name}, до справ?",
];

const GREETINGS = {
  morning: [ // 05:00–11:59
    "Доброго ранку, {name}",
    "Гарного ранку, {name}",
    "З новим днем, {name}",
    "Кава й план — і вперед, {name}",
    "Новий день — нові можливості, {name}",
    "Ранок, {name}! Прокидаємось?",
    "Сонячного ранку, {name}",
  ],
  day: [ // 12:00–17:59
    "Добрий день, {name}",
    "Гарного дня, {name}",
    "Як минає день, {name}?",
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
    "Вечірні вітання, {name}",
  ],
  night: [ // 23:00–04:59
    "Доброї ночі, {name}",
    "Не спиться, {name}?",
    "Пізно вже, {name}",
    "Час відпочивати, {name}",
    "Тихої ночі, {name}",
  ],
};

/* Маленька лінійна іконка в блоці привітання — випадкова при кожному відкритті.
   when: "day" — лише вдень (5–18), "night" — лише ввечері/вночі; без when — будь-коли. */
const HERO_ICONS = [
  { name: "зірочка", svg: '<path d="M12 2.5c.6 4.9 2.9 7.3 9.5 9.5-6.6 2.2-8.9 4.6-9.5 9.5-.6-4.9-2.9-7.3-9.5-9.5 6.6-2.2 8.9-4.6 9.5-9.5Z"/>' },
  { name: "сонце", when: "day", svg: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>' },
  { name: "місяць", when: "night", svg: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10Z"/>' },
  { name: "хмаринка", svg: '<path d="M7.5 18.5h9.5a4 4 0 0 0 .4-7.98A5.5 5.5 0 0 0 6.9 9.6 4.5 4.5 0 0 0 7.5 18.5Z"/>' },
  { name: "сердечко", svg: '<path d="M12 20s-7.5-4.4-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.6 12 20 12 20Z"/>' },
  { name: "конвертик", svg: '<rect x="3.5" y="6" width="17" height="12.5" rx="2"/><path d="M4.2 7.2 12 13l7.8-5.8"/>' },
  { name: "машина", svg: '<path d="M3.5 15.5v-3l2.1-4.3a1.6 1.6 0 0 1 1.4-.9h10a1.6 1.6 0 0 1 1.4.9l2.1 4.3v3h-1.8M7.3 15.5h9.4M5.3 15.5H3.5M3.5 12.5h17"/><circle cx="7.3" cy="16" r="1.8"/><circle cx="16.7" cy="16" r="1.8"/>' },
  { name: "телефон", svg: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.3h2"/>' },
  { name: "пляшечка", svg: '<path d="M10 2.5h4v3.2l1.6 2.6v10.7a2.2 2.2 0 0 1-2.2 2.2h-2.8a2.2 2.2 0 0 1-2.2-2.2V8.3L10 5.7Z"/><path d="M8.4 12h7.2M8.4 16h7.2"/>' },
  { name: "кава", svg: '<path d="M5 9.5h11v4.3a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5Z"/><path d="M16 11h1.4a2.3 2.3 0 0 1 0 4.6H16M8.5 3.5c-.8 1 .8 1.8 0 3M12 3.5c-.8 1 .8 1.8 0 3"/>' },
  { name: "листочок", svg: '<path d="M5 19C5 10 10 5 19.5 4.5 19 14 14 19 5 19Z"/><path d="M5 19l8.5-8.5"/>' },
  { name: "квітка", svg: '<circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="6.6" r="3"/><circle cx="17.4" cy="12" r="3"/><circle cx="12" cy="17.4" r="3"/><circle cx="6.6" cy="12" r="3"/>' },
  { name: "подарунок", svg: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7M12 8v12M12 8C10.5 5 7 4.6 7.5 7c.3 1.3 2.6 1 4.5 1Zm0 0c1.5-3 5-3.4 4.5-1-.3 1.3-2.6 1-4.5 1Z"/>' },
  { name: "нотка", svg: '<path d="M9 17.5V5.5l10-2v12"/><circle cx="7" cy="17.5" r="2"/><circle cx="17" cy="15.5" r="2"/>' },
  { name: "парасолька", svg: '<path d="M3 12a9 9 0 0 1 18 0Z"/><path d="M12 12v6.5a2 2 0 0 1-4 0M12 3v.5"/>' },
  { name: "кулька", svg: '<ellipse cx="12" cy="9.5" rx="5.5" ry="6.5"/><path d="M12 16l-1.2 1.6h2.4Z"/><path d="M12 17.6c0 2-1.8 2.2-1 4"/>' },
  { name: "книжка", svg: '<path d="M12 6.5C10.3 5 7.5 4.5 4 4.5v13.5c3.5 0 6.3.5 8 2M12 6.5c1.7-1.5 4.5-2 8-2v13.5c-3.5 0-6.3.5-8 2M12 6.5v13.5"/>' },
];

function pickHeroIcon() {
  const night = dayPart() === "evening" || dayPart() === "night";
  const pool = HERO_ICONS.filter((i) => !i.when || (i.when === "night") === night);
  let last = null;
  try { last = localStorage.getItem("heroIcon"); } catch (_) {}
  const options = pool.filter((i) => i.name !== last);
  const icon = options[Math.floor(Math.random() * options.length)];
  try { localStorage.setItem("heroIcon", icon.name); } catch (_) {}
  const el = $("heroIcon");
  el.innerHTML = icon.svg;
  el.setAttribute("data-name", icon.name);
  el.style.animation = "none"; void el.getBoundingClientRect(); el.style.animation = "";
}

/* Фраза дня: спокійна, без тиску. Залежить від дати — протягом дня не змінюється. */
const MOTTOS = [
  "Не обовʼязково встигнути все. Достатньо зробити перший крок.",
  "Спокійно, все по порядку.",
  "Сьогодні можна почати з малого.",
  "Одна справа за раз — і день складеться.",
  "Маленькі кроки теж рухають уперед.",
  "Почнемо з головного.",
  "Не поспішай. Головне ти встигнеш.",
  "Простий план — спокійний день.",
  "Відпочинок теж частина плану.",
  "Зроби сьогодні те, за що завтра скажеш собі дякую.",
  "Крок за кроком.",
  "Хай цей день буде легким.",
  "Достатньо зробити трохи більше, ніж нічого.",
  "Добре сплановане — наполовину зроблене.",
];

function mottoFor(ds) {
  let h = 0;
  for (const c of ds) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return MOTTOS[h % MOTTOS.length];
}

function dayPart(h = new Date().getHours()) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "day";
  if (h >= 18 && h < 23) return "evening";
  return "night";
}

function fillName(phrase, name) {
  if (name) return phrase.replace("{name}", name);
  return phrase.replace(/,?\s*\{name\}/, "").replace(/\s+([?!.,])/, "$1");
}

// Фраза обирається випадково при кожному відкритті застосунку (і при зміні частини доби),
// але не мигтить при оновленні списку. Останні кілька фраз не повторюються.
const greetingCache = { part: null, phrase: null };
function pickGreeting() {
  const part = dayPart();
  const pool = [...ANYTIME, ...GREETINGS[part]];
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem("greetings") || "[]"); } catch (_) {}
  const fresh = pool.filter((p) => !recent.includes(p));
  const options = fresh.length ? fresh : pool;
  const phrase = options[Math.floor(Math.random() * options.length)];
  try { localStorage.setItem("greetings", JSON.stringify([phrase, ...recent].slice(0, 6))); } catch (_) {}
  greetingCache.part = part;
  greetingCache.phrase = phrase;
}

function greeting() {
  if (greetingCache.part !== dayPart()) pickGreeting();
  return fillName(greetingCache.phrase, state.name);
}

// Спільний список справ дня: відкриті, порожній стан, згорнуті виконані
function renderDayList(prefix, ds, tasks) {
  const isToday = ds === state.today;
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const late = (t) => (isToday && t.time && t.time < nowHM()) || ds < state.today;

  // «Далі»: найближча справа з часом сьогодні — про неї прийде нагадування
  const next = isToday ? open.find((t) => t.time && t.time >= nowHM()) : null;
  $(`${prefix}-taskList`).replaceChildren(...open.map((t) => taskRow(t, { late: late(t), next: t === next })));
  $(`${prefix}-doneList`).replaceChildren(...done.map((t) => taskRow(t)));
  $(`${prefix}-doneBlock`).hidden = !done.length;
  $(`${prefix}-doneSummary`).textContent = `Виконано · ${done.length}`;

  renderEmpty($(`${prefix}-empty`), ds, tasks, open);
  return { open, done };
}

const ICONS = {
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M9 14.5l2 2 4-4"/></svg>',
  done: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>',
};

// Порожній стан: легка картка з іконкою, коротким текстом і кнопкою
function renderEmpty(el, ds, tasks, open) {
  el.hidden = open.length > 0;
  if (!el.hidden) {
    const isToday = ds === state.today;
    const [icon, title, text, withBtn] = tasks.length
      ? ["done", "Усе виконано", "Чудова робота. Решта дня — для тебе.", false]
      : isToday
        ? ["calendar", "Поки що вільний день", "Можеш відпочити або запланувати щось нове.", true]
        : ds < state.today
          ? ["sun", "Цей день був вільним", "Тут нічого не було заплановано.", false]
          : ["calendar", "Нічого не заплановано", "Додай справу на цей день, коли буде потрібно.", true];
    el.innerHTML = `
      <div class="empty-row">
        <span class="empty-icon">${ICONS[icon]}</span>
        <div class="empty-text"><b></b><span></span></div>
      </div>
      ${withBtn ? '<button class="btn primary empty-btn" type="button">+ Додати завдання</button>' : ""}`;
    el.querySelector("b").textContent = title;
    el.querySelector(".empty-text span").textContent = text;
    el.querySelector(".empty-btn")?.addEventListener("click", () => openSheet(null));
  }
}

function renderToday() {
  const tasks = state.todayTasks;
  $("greeting").textContent = greeting();
  $("todayDate").textContent = `${weekday(state.today)}, ${human(state.today)}`;

  const { open, done } = renderDayList("t", state.today, tasks);
  const n = tasks.length;
  $("motto").textContent = mottoFor(state.today);
  // прогрес показуємо лише коли є справи — щоб не тиснути порожнім лічильником
  $("heroProgress").hidden = !n;
  if (n) {
    setText($("progressLabel"), !open.length ? `Виконано всі ${n} з ${n}` : `Виконано ${done.length} з ${n}`);
    $("progressFill").style.width = `${(done.length / n) * 100}%`;
  }
  $("t-listTitle").hidden = !open.length;

  const showOverdue = state.overdue.length > 0;
  $("t-overdue").hidden = !showOverdue;
  $("t-overdueList").replaceChildren(...state.overdue.map((t) => taskRow(t, { overdue: true })));

  const badge = $("todayBadge");
  badge.hidden = !open.length;
  setText(badge, String(open.length));
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
  li.className = "task" + (t.done ? " done" : "") + (opts.next ? " next" : "");
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
  if (opts.next) li.append(Object.assign(document.createElement("span"), { className: "next-label", textContent: "Далі" }));

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
    render();
    loadMonth({ force: true }).then((ok) => ok && render()).catch(showError);
  } else {
    render();
  }
  haptic("light");
}

function shiftMonth(n) {
  const d = new Date(Date.UTC(state.view.y, state.view.m + n, 1));
  state.view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  state.byDate = {};
  renderCalendar();
  loadMonth({ force: true }).then((ok) => ok && (renderCalendar(), renderCalendarDay())).catch(showError);
}

function toggleDone(t, li, check) {
  if (li.dataset.busy) return;              // подвійний тап по тій самій справі
  li.dataset.busy = "1";
  const next = !t.done;
  haptic(next ? "success" : "light");
  patchLocalTask(t.id, { done: next, done_at: next ? new Date().toISOString() : null });
  if (next) {
    // спершу чекбокс заповнюється, потім рядок відʼїжджає; перемальовуємо після анімації
    check.classList.add("on");
    setTimeout(() => li.classList.add("leaving"), 280);
    renderSoon(520);
  } else {
    render();
  }
  write(`task:${t.id}`, () => api("PATCH", `/api/tasks/${t.id}`, { done: next })).catch(writeFailed);
  if (next) toast(`«${t.title}» виконано`, () => {
    patchLocalTask(t.id, { done: false, done_at: null });
    render();
    write(`task:${t.id}`, () => api("PATCH", `/api/tasks/${t.id}`, { done: false })).catch(writeFailed);
  });
}

function moveToToday(t) {
  haptic("light");
  patchLocalTask(t.id, { date: state.today });
  render();
  write(`task:${t.id}`, () => api("PATCH", `/api/tasks/${t.id}`, { date: state.today })).catch(writeFailed);
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
  $("habitSheet").hidden = true;
  state.editingHabit = null;
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
    const editing = state.editing;
    await write(editing ? `task:${editing.id}` : `new-task:${Date.now()}`, () => editing
      ? api("PATCH", `/api/tasks/${editing.id}`, data)
      : api("POST", "/api/tasks", data));
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
    try { await write(`task:${t.id}`, () => api("DELETE", `/api/tasks/${t.id}`)); closeSheet(); await reload(); haptic("medium"); }
    catch (e) { showError(e); }
  };
  if (tg?.showConfirm && tg.initData) tg.showConfirm(`Видалити «${t.title}»?`, doDelete);
  else doDelete(confirm(`Видалити «${t.title}»?`));
};

$("cancelBtn").onclick = closeSheet;
$("backdrop").onclick = closeSheet;
tg?.BackButton?.onClick(closeSheet);
$("addBtn").onclick = () => (state.page === "habits" ? openHabitSheet(null) : openSheet(null));
$("prevMonth").onclick = () => shiftMonth(-1);
$("nextMonth").onclick = () => shiftMonth(1);
$("gotoToday").onclick = () => selectDay(state.today);

/* ---------- звички ---------- */
const habitSet = (h) => new Set(h.marks);

function habitStreak(h) {
  const set = habitSet(h);
  let d = set.has(state.today) ? state.today : addDays(state.today, -1);
  let n = 0;
  while (set.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

function habitBest(h) {
  let best = 0, run = 0, prev = null;
  for (const d of [...h.marks].sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

// Яку частку днів за останні 30 (але не раніше старту) звичку відмічено
function habitRate(h) {
  const from = [addDays(state.today, -29), h.start_date].sort()[1];
  if (from > state.today) return 0;
  const days = Math.round((toDate(state.today) - toDate(from)) / 864e5) + 1;
  const count = h.marks.filter((d) => d >= from && d <= state.today).length;
  return Math.round((count / days) * 100);
}

const markedToday = (h) => h.marks.includes(state.today);

function renderHabits() {
  const hs = state.habits;
  if (!hs.some((h) => h.id === state.habitSel)) state.habitSel = hs[0]?.id ?? null;
  const done = hs.filter(markedToday).length;

  $("habitsSummary").textContent = !hs.length
    ? "Регулярність важливіша за ідеальність."
    : done === hs.length ? `Сьогодні відмічено всі ${hs.length}. Так тримати!` : `Сьогодні відмічено ${done} з ${hs.length}`;
  const badge = $("habitsBadge");
  badge.hidden = !(hs.length - done);
  setText(badge, String(hs.length - done));

  $("habitEmpty").hidden = hs.length > 0;
  $("habitChips").hidden = $("habitCard").hidden = $("habitHeat").hidden = !hs.length;
  if (!hs.length) return;

  // перемикач між звичками
  $("habitChips").replaceChildren(...hs.map((h) => {
    const b = document.createElement("button");
    b.className = "chip" + (h.id === state.habitSel ? " active" : "") + (markedToday(h) ? " marked" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", h.id === state.habitSel);
    b.textContent = h.title;
    b.onclick = () => { state.habitSel = h.id; haptic("light"); renderHabits(); };
    return b;
  }));

  const h = hs.find((x) => x.id === state.habitSel);
  const quit = h.kind === "quit";
  const streak = habitStreak(h);
  $("habitKind").textContent = quit ? "Позбуваюсь" : "Корисна звичка";
  $("habitTitle").textContent = h.title;
  setText($("statStreak"), String(streak));
  $("statStreakLabel").textContent = quit
    ? plural(streak, "день без зриву", "дні без зривів", "днів без зривів")
    : plural(streak, "день поспіль", "дні поспіль", "днів поспіль");
  setText($("statBest"), String(habitBest(h)));
  setText($("statRate"), `${habitRate(h)}%`);

  const on = markedToday(h);
  const tgl = $("habitToggle");
  tgl.classList.toggle("on", on);
  tgl.textContent = on
    ? (quit ? "Сьогодні без зриву ✓" : "Сьогодні зроблено ✓")
    : (quit ? "Сьогодні тримаюсь" : "Відмітити сьогодні");
  tgl.onclick = () => toggleHabitDay(h, state.today);

  renderHeat(h);
}

function renderHeat(h) {
  const set = habitSet(h);
  const monIdx = (toDate(state.today).getUTCDay() + 6) % 7;
  const end = addDays(state.today, 6 - monIdx); // неділя поточного тижня
  const start = addDays(end, -34);
  const cells = [];
  for (let i = 0; i < 35; i++) {
    const ds = addDays(start, i);
    const c = document.createElement("button");
    c.className = "heat-cell";
    c.textContent = toDate(ds).getUTCDate();
    if (ds > state.today) { c.classList.add("future"); c.disabled = true; }
    else {
      if (set.has(ds)) c.classList.add("on");
      else if (ds < h.start_date) c.classList.add("before");
      c.onclick = () => toggleHabitDay(h, ds);
    }
    if (ds === state.today) c.classList.add("today");
    c.setAttribute("aria-label", `${human(ds)}${set.has(ds) ? ", відмічено" : ""}`);
    cells.push(c);
  }
  $("heatGrid").replaceChildren(...cells);
}

function toggleHabitDay(h, ds) {
  const on = !h.marks.includes(ds);
  haptic(on ? "success" : "light");
  // екран змінюється одразу; відповіді сервера НЕ перезаписують відмітки — лише остаточна синхронізація
  h.marks = on ? [...h.marks, ds].sort() : h.marks.filter((d) => d !== ds);
  // старт = найраніша відмітка (без відміток — день створення), як і на сервері
  h.start_date = h.marks[0] || h.base_start || h.start_date;
  renderHabits();
  if (on && ds === state.today) {
    const t = $("habitToggle");
    t.classList.remove("pop"); void t.offsetWidth; t.classList.add("pop");
  }
  write(`habit:${h.id}:${ds}`, () => api(on ? "PUT" : "DELETE", `/api/habits/${h.id}/marks/${ds}`)).catch(writeFailed);
}

/* форма звички */
const hform = $("habitSheet");

function syncHabitKind() {
  const quit = hform.elements.kind.value === "quit";
  $("habitTitleLabel").textContent = quit ? "Від чого хочеш позбутися" : "Що робити регулярно";
  hform.elements.title.placeholder = quit ? "Наприклад, курити або гортати стрічку" : "Наприклад, пити 2 л води";
}
hform.querySelectorAll("input[name=kind]").forEach((r) => (r.onchange = syncHabitKind));

// Android: після появи клавіатури підкручуємо активне поле у видиму частину форми
document.querySelectorAll(".sheet input, .sheet textarea").forEach((el) =>
  el.addEventListener("focus", () => setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 300)));

function openHabitSheet(h) {
  state.editingHabit = h || null;
  $("habitSheetTitle").textContent = h ? "Редагувати звичку" : "Нова звичка";
  hform.elements.title.value = h?.title || "";
  hform.elements.kind.value = h?.kind || "build";
  syncHabitKind();
  const del = $("habitDeleteBtn");
  del.hidden = !h;
  delete del.dataset.armed;
  del.textContent = "Видалити";
  $("backdrop").hidden = false;
  hform.hidden = false;
  tg?.BackButton?.show();
  if (!h) setTimeout(() => hform.elements.title.focus(), 50);
}

hform.onsubmit = async (e) => {
  e.preventDefault();
  const data = { title: hform.elements.title.value.trim(), kind: hform.elements.kind.value };
  if (!data.title) return;
  $("habitSaveBtn").disabled = true;
  try {
    const editing = state.editingHabit;
    const saved = await write(editing ? `habit:${editing.id}` : `new-habit:${Date.now()}`, () => editing
      ? api("PATCH", `/api/habits/${editing.id}`, data)
      : api("POST", "/api/habits", data));
    state.habitSel = saved.id;
    haptic("success");
    closeSheet();
    await reload();
  } catch (err) { showError(err); }
  finally { $("habitSaveBtn").disabled = false; }
};

// видалення у два натискання — без системних діалогів
$("habitDeleteBtn").onclick = async () => {
  const btn = $("habitDeleteBtn");
  if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Точно?"; return; }
  try {
    const id = state.editingHabit.id;
    await write(`habit:${id}`, () => api("DELETE", `/api/habits/${id}`));
    closeSheet();
    await reload();
  } catch (e) { showError(e); }
};
$("habitCancelBtn").onclick = closeSheet;
$("habitEmptyBtn").onclick = () => openHabitSheet(null);
$("habitEdit").onclick = () => openHabitSheet(state.habits.find((h) => h.id === state.habitSel));

/* ---------- нижнє меню ---------- */
const PAGES = ["today", "calendar", "habits"];
function showPage(page) {
  state.page = page;
  for (const p of PAGES) $(`page-${p}`).hidden = p !== page;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  try { localStorage.setItem("page", page); } catch (_) {}
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { if (state.page !== b.dataset.page) { haptic("light"); showPage(b.dataset.page); } }));
let savedPage = "today";
try { savedPage = localStorage.getItem("page") || "today"; } catch (_) {}
// посилання з бота «Відкрити звички» веде одразу на вкладку
if (location.hash === "#habits") savedPage = "habits";
showPage(PAGES.includes(savedPage) ? savedPage : "today");

/* ---------- старт ---------- */
const splashStart = Date.now();
function hideSplash() {
  const el = $("splash");
  if (!el || el.classList.contains("gone")) return;
  setTimeout(() => el.classList.add("gone"), Math.max(0, 700 - (Date.now() - splashStart)));
}

async function init() {
  pickGreeting();
  pickHeroIcon();
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
  hideSplash();
}

// повернулися в застосунок (наприклад, наступного дня) — оновимо дані
document.addEventListener("visibilitychange", () => { if (!document.hidden) init(); });
init();
