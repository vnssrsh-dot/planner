// Тексти та клавіатури повідомлень бота.
import { humanDay, addDays, plural } from "./time.js";

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const taskLine = (t) => `• ${t.time ? `<b>${t.time}</b> ` : ""}${esc(t.title)}`;
const short = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

export function dayText(day, tasks, overdue = []) {
  const lines = [`<b>План на ${humanDay(day)}</b>`, ""];
  const open = tasks.filter((t) => !t.done);
  const done = tasks.length - open.length;
  if (open.length) lines.push(...open.map(taskLine));
  else if (tasks.length) lines.push("Усе виконано.");
  else lines.push("Планів немає. Додайте завдання в планері або командою /add.");
  if (done) lines.push("", `Виконано: ${done} з ${tasks.length}`);
  if (overdue.length) {
    lines.push("", `<b>Не виконано раніше: ${overdue.length}</b>`);
    lines.push(...overdue.slice(0, 5).map((t) => `${taskLine(t)} <i>(${t.date.slice(8)}.${t.date.slice(5, 7)})</i>`));
  }
  return lines.join("\n");
}

export function tasksKeyboard(tasks, webappUrl, { withTomorrow = false } = {}) {
  const rows = [];
  for (const t of tasks) {
    if (t.done) continue;
    const row = [{ text: `✓ ${short(t.title, 28)}`, callback_data: `done:${t.id}` }];
    if (withTomorrow) row.push({ text: "→ Завтра", callback_data: `tmrw:${t.id}` });
    rows.push(row);
  }
  if (webappUrl) rows.push([{ text: "Відкрити Ritmoza", web_app: { url: webappUrl } }]);
  return { inline_keyboard: rows };
}

export function habitsText(habits) {
  const lines = ["<b>Звички, які сьогодні ще не відмічені</b>", ""];
  for (const h of habits) lines.push(`• ${h.kind === "quit" ? "без зриву: " : ""}${esc(h.title)}`);
  lines.push("", "Відмітьте, якщо вже зробили — серія не перерветься.");
  return lines.join("\n");
}

export function habitsKeyboard(habits, day, webappUrl) {
  const rows = habits.map((h) => [{ text: `✓ ${short(h.title, 30)}`, callback_data: `habit:${h.id}:${day}` }]);
  if (webappUrl) rows.push([{ text: "Відкрити звички", web_app: { url: webappUrl + "#habits" } }]);
  return { inline_keyboard: rows };
}

// ---------- ранкова зведення ----------

export function habitStreak(h, day) {
  const set = new Set(h.marks);
  let d = set.has(day) ? day : addDays(day, -1);
  let n = 0;
  while (set.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

export function habitBest(h) {
  let best = 0, run = 0, prev = null;
  for (const d of [...h.marks].sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function habitLine(h, day) {
  const quit = h.kind === "quit";
  const streak = habitStreak(h, day);
  const best = habitBest(h);
  const title = `<b>${esc(h.title)}</b>${quit ? " <i>(позбуваюсь)</i>" : ""}`;
  if (!streak) {
    return `• ${title} — ${quit ? "сьогодні новий старт, тримайся" : "почни нову серію сьогодні"}`;
  }
  const days = quit
    ? `${streak} ${plural(streak, "день", "дні", "днів")} без зривів`
    : `${streak} ${plural(streak, "день", "дні", "днів")} поспіль`;
  const record = streak >= best && streak > 1 ? " · новий рекорд 🔥" : best > streak ? ` · рекорд ${best}` : "";
  return `• ${title} — ${days}${record}`;
}

export function morningText(day, tasks, overdue, habits) {
  const open = tasks.filter((t) => !t.done);
  const lines = [`<b>Доброго ранку! План на ${humanDay(day)}</b>`, ""];
  if (open.length) lines.push(...open.map(taskLine));
  else lines.push("На сьогодні справ немає — можна спокійно зайнятися собою.");
  if (overdue.length) {
    lines.push("", `<b>Не виконано раніше: ${overdue.length}</b>`);
    lines.push(...overdue.slice(0, 5).map((t) => `${taskLine(t)} <i>(${t.date.slice(8)}.${t.date.slice(5, 7)})</i>`));
  }
  if (habits.length) {
    lines.push("", "<b>Звички</b>", ...habits.map((h) => habitLine(h, day)));
    const best = Math.max(...habits.map((h) => habitStreak(h, day)));
    lines.push("", best >= 3 ? "Серії ростуть — не відпускай їх сьогодні." : "Маленький крок щодня — і звичка складеться.");
  } else {
    lines.push("", "Гарного дня!");
  }
  return lines.join("\n");
}
