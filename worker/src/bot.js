// Обробка оновлень від Telegram (вебхук): команди та кнопки.
import { localNow, addDays, humanDay } from "./time.js";
import { tg } from "./telegram.js";
import { dayText, tasksKeyboard, habitsText, habitsKeyboard, openKeyboard, esc } from "./views.js";

async function today(store, env, uid) {
  const user = await store.getUser(uid);
  return localNow(user?.tz, env.DEFAULT_TZ).date;
}

async function sendDay(env, store, chatId, uid, webappUrl) {
  const day = await today(store, env, uid);
  const [tasks, overdue] = await Promise.all([store.tasksBetween(uid, day, day), store.overdue(uid, day)]);
  await tg(env, "sendMessage", {
    chat_id: chatId, parse_mode: "HTML", text: dayText(day, tasks, overdue),
    reply_markup: openKeyboard(webappUrl),
  });
}

function parseQuick(text) {
  const parts = text.trim().split(/\s+/);
  const m = parts[0]?.match(/^(\d{1,2})[:.](\d{2})$/);
  if (m && +m[1] < 24 && +m[2] < 60) {
    return [`${m[1].padStart(2, "0")}:${m[2]}`, parts.slice(1).join(" ").trim()];
  }
  return [null, text.trim()];
}

async function onMessage(env, store, msg, webappUrl) {
  const text = msg.text || "";
  const u = msg.from;
  const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return;
  const [, cmd, args = ""] = m;
  await store.upsertUser(u.id, { chatId: msg.chat.id, firstName: u.first_name });

  if (cmd === "start") {
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id, parse_mode: "HTML",
      text: `Привіт, ${esc(u.first_name)}! Я — <b>Ritmoza</b>.\n<i>Плануй · живи · розвивайся</i>\n\n` +
        "Щодня показую план, а ввечері нагадаю про те, що ще не зроблено.\n\n" +
        "• <b>Відкрити Ritmoza</b> — календар, справи і звички\n" +
        "• /today — план на сьогодні\n" +
        "• /add 18:30 Зателефонувати мамі — додати завдання на сьогодні\n" +
        "• /tomorrow Купити хліб — додати на завтра",
      reply_markup: openKeyboard(webappUrl),
    });
    await store.markStarted(u.id); // через 30 хв — запрошення, якщо нічого не додано
  } else if (cmd === "today") {
    await sendDay(env, store, msg.chat.id, u.id, webappUrl);
  } else if (cmd === "add" || cmd === "tomorrow") {
    const [time, title] = parseQuick(args);
    if (!title) {
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: `Напишіть завдання після команди, наприклад:\n/${cmd} 18:30 Зателефонувати мамі`,
      });
      return;
    }
    let day = await today(store, env, u.id);
    if (cmd === "tomorrow") day = addDays(day, 1);
    await store.createTask(u.id, { date: day, time, title: title.slice(0, 200) });
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id, parse_mode: "HTML",
      text: `Додано на ${humanDay(day)}${time ? ` о ${time}` : ""}: <b>${esc(title)}</b>`,
    });
  }
}

async function refreshDay(env, store, cb, webappUrl) {
  const uid = cb.from.id;
  const day = await today(store, env, uid);
  const [tasks, overdue] = await Promise.all([store.tasksBetween(uid, day, day), store.overdue(uid, day)]);
  const withTomorrow = (cb.message?.reply_markup?.inline_keyboard || [])
    .some((row) => row.some((b) => b.callback_data?.startsWith("tmrw:")));
  await tg(env, "editMessageText", {
    chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: "HTML",
    text: dayText(day, tasks, overdue), reply_markup: tasksKeyboard(tasks, webappUrl, { withTomorrow }),
  });
}

async function onCallback(env, store, cb, webappUrl) {
  const uid = cb.from.id;
  const [kind, a, b] = (cb.data || "").split(":");
  if (kind === "rdone") {
    // «✓ Виконано» під нагадуванням: відмічаємо і лишаємо в повідомленні тільки кнопку застосунку
    const task = await store.updateTask(uid, +a, { done: true });
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: task ? `Виконано: ${task.title}` : "Завдання не знайдено" });
    if (task && cb.message) {
      await tg(env, "editMessageText", {
        chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: "HTML",
        text: `✓ Виконано: <b>${esc(task.title)}</b>${task.time ? ` о ${task.time}` : ""}`,
        reply_markup: openKeyboard(webappUrl),
      });
    }
  } else if (kind === "done") {
    const task = await store.updateTask(uid, +a, { done: true });
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: task ? `Виконано: ${task.title}` : "Завдання не знайдено" });
    if (cb.message) await refreshDay(env, store, cb, webappUrl);
  } else if (kind === "tmrw") {
    const day = addDays(await today(store, env, uid), 1);
    const task = await store.updateTask(uid, +a, { date: day });
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: task ? "Перенесено на завтра" : "Завдання не знайдено" });
    if (cb.message) await refreshDay(env, store, cb, webappUrl);
  } else if (kind === "habit") {
    const habit = await store.setHabitMark(uid, +a, b, true);
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: habit ? `Відмічено: ${habit.title}` : "Звичку не знайдено" });
    if (!cb.message) return;
    const left = await store.unmarkedHabits(uid, b);
    await tg(env, "editMessageText", {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: "HTML",
      ...(left.length
        ? { text: habitsText(left), reply_markup: habitsKeyboard(left, b, webappUrl) }
        : { text: "<b>Усі звички на сьогодні відмічено.</b> Так тримати!" }),
    });
  } else {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  }
}

export async function handleUpdate(env, store, update, webappUrl) {
  if (update.message) await onMessage(env, store, update.message, webappUrl);
  else if (update.callback_query) await onCallback(env, store, update.callback_query, webappUrl);
}
