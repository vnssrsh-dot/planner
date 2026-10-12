// Сховище D1 (SQLite): користувачі, справи, звички.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY, chat_id INTEGER, first_name TEXT, tz TEXT, last_evening_date TEXT,
     last_morning_date TEXT)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT,
     title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, done_at TEXT,
     reminded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date)`,
  `CREATE TABLE IF NOT EXISTS habits (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'build', start_date TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS habit_marks (
     habit_id INTEGER NOT NULL, date TEXT NOT NULL, PRIMARY KEY (habit_id, date))`,
];

let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  // база, створена до появи ранкової зведення, — додаємо колонку (якщо вже є, SQLite поверне помилку)
  try { await db.prepare("ALTER TABLE users ADD COLUMN last_morning_date TEXT").run(); } catch {}
  schemaReady = true;
}

const now = () => new Date().toISOString().slice(0, 19) + "+00:00";

const toTask = (r) => ({
  id: r.id, date: r.date, time: r.time, title: r.title, note: r.note, done: !!r.done, done_at: r.done_at,
});

export class Store {
  constructor(db) { this.db = db; }

  q(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async all(sql, ...args) { return (await this.q(sql, ...args).all()).results; }

  // ---------- settings ----------
  async getSetting(key) { return (await this.q("SELECT value FROM settings WHERE key = ?", key).first())?.value ?? null; }
  setSetting(key, value) {
    return this.q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value).run();
  }

  // ---------- users ----------
  async upsertUser(id, { chatId = null, firstName = null, tz = null } = {}) {
    await this.q(
      `INSERT INTO users (id, chat_id, first_name, tz) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         chat_id = COALESCE(excluded.chat_id, users.chat_id),
         first_name = COALESCE(excluded.first_name, users.first_name),
         tz = COALESCE(excluded.tz, users.tz)`,
      id, chatId, firstName, tz,
    ).run();
  }
  getUser(id) { return this.q("SELECT * FROM users WHERE id = ?", id).first(); }
  usersWithChat() { return this.all("SELECT * FROM users WHERE chat_id IS NOT NULL"); }
  setLastMorning(id, day) { return this.q("UPDATE users SET last_morning_date = ? WHERE id = ?", day, id).run(); }
  setLastEvening(id, day) { return this.q("UPDATE users SET last_evening_date = ? WHERE id = ?", day, id).run(); }

  // ---------- tasks ----------
  async tasksBetween(uid, from, to) {
    const rows = await this.all(
      `SELECT * FROM tasks WHERE user_id = ? AND date BETWEEN ? AND ?
       ORDER BY date, time IS NULL, time, id`, uid, from, to);
    return rows.map(toTask);
  }
  async overdue(uid, today) {
    const rows = await this.all(
      `SELECT * FROM tasks WHERE user_id = ? AND date < ? AND done = 0
       ORDER BY date, time IS NULL, time, id`, uid, today);
    return rows.map(toTask);
  }
  async getTask(uid, id) {
    const r = await this.q("SELECT * FROM tasks WHERE id = ? AND user_id = ?", id, uid).first();
    return r ? toTask(r) : null;
  }
  async createTask(uid, { date, title, time = null, note = "" }) {
    const res = await this.q(
      "INSERT INTO tasks (user_id, date, time, title, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      uid, date, time, title, note, now()).run();
    return this.getTask(uid, res.meta.last_row_id);
  }
  async updateTask(uid, id, fields) {
    const f = {};
    for (const k of ["date", "time", "title", "note", "done"]) if (k in fields) f[k] = fields[k];
    if ("done" in f) { f.done = f.done ? 1 : 0; f.done_at = f.done ? now() : null; }
    if ("date" in f || "time" in f) f.reminded = 0; // перенесли — нагадаємо знову
    const keys = Object.keys(f);
    if (keys.length) {
      await this.q(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND user_id = ?`,
        ...keys.map((k) => f[k]), id, uid).run();
    }
    return this.getTask(uid, id);
  }
  async deleteTask(uid, id) {
    const res = await this.q("DELETE FROM tasks WHERE id = ? AND user_id = ?", id, uid).run();
    return res.meta.changes > 0;
  }
  async timedUnreminded(uid, day) {
    const rows = await this.all(
      `SELECT * FROM tasks WHERE user_id = ? AND date = ? AND time IS NOT NULL AND done = 0 AND reminded = 0`,
      uid, day);
    return rows.map(toTask);
  }
  markReminded(id) { return this.q("UPDATE tasks SET reminded = 1 WHERE id = ?", id).run(); }

  // ---------- habits ----------
  async habits(uid) {
    const habits = await this.all(
      "SELECT id, title, kind, start_date FROM habits WHERE user_id = ? ORDER BY id", uid);
    if (!habits.length) return [];
    const marks = await this.all(
      `SELECT habit_id, date FROM habit_marks WHERE habit_id IN (${habits.map(() => "?").join(",")}) ORDER BY date`,
      ...habits.map((h) => h.id));
    const by = {};
    for (const m of marks) (by[m.habit_id] ||= []).push(m.date);
    return habits.map((h) => ({ ...h, marks: by[h.id] || [] }));
  }
  async getHabit(uid, id) { return (await this.habits(uid)).find((h) => h.id === id) || null; }
  async createHabit(uid, { title, kind, startDate }) {
    const res = await this.q(
      "INSERT INTO habits (user_id, title, kind, start_date, created_at) VALUES (?, ?, ?, ?, ?)",
      uid, title, kind, startDate, now()).run();
    return this.getHabit(uid, res.meta.last_row_id);
  }
  async updateHabit(uid, id, fields) {
    const keys = ["title", "kind"].filter((k) => k in fields);
    if (keys.length) {
      await this.q(`UPDATE habits SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND user_id = ?`,
        ...keys.map((k) => fields[k]), id, uid).run();
    }
    return this.getHabit(uid, id);
  }
  async deleteHabit(uid, id) {
    const res = await this.q("DELETE FROM habits WHERE id = ? AND user_id = ?", id, uid).run();
    if (res.meta.changes) await this.q("DELETE FROM habit_marks WHERE habit_id = ?", id).run();
    return res.meta.changes > 0;
  }
  async setHabitMark(uid, id, day, on) {
    if (!(await this.getHabit(uid, id))) return null;
    if (on) {
      await this.db.batch([
        this.q("INSERT OR IGNORE INTO habit_marks (habit_id, date) VALUES (?, ?)", id, day),
        // відмітка раніше старту — зсуваємо старт, щоб статистика була чесною
        this.q("UPDATE habits SET start_date = ? WHERE id = ? AND start_date > ?", day, id, day),
      ]);
    } else {
      await this.q("DELETE FROM habit_marks WHERE habit_id = ? AND date = ?", id, day).run();
    }
    return this.getHabit(uid, id);
  }
  async unmarkedHabits(uid, day) {
    return (await this.habits(uid)).filter((h) => !h.marks.includes(day) && h.start_date <= day);
  }
}
