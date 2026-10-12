// Тексти та клавіатури повідомлень бота.
import { humanDay } from "./time.js";

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
