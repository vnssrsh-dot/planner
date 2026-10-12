// Нагадування (Cron щохвилини): перед справою з часом і ввечері про невиконане.
import { localNow, plural } from "./time.js";
import { tg } from "./telegram.js";
import { dayText, tasksKeyboard, habitsText, habitsKeyboard, morningText, esc } from "./views.js";

async function checkUser(env, store, user, webappUrl) {
  const now = localNow(user.tz, env.DEFAULT_TZ);
  const before = Number(env.REMIND_BEFORE_MIN || 15);

  // 1) За N хвилин до справи з часом
  for (const t of await store.timedUnreminded(user.id, now.date)) {
    const [h, m] = t.time.split(":").map(Number);
    const due = h * 60 + m;
    if (now.minutes > due + 60) {
      await store.markReminded(t.id); // давно минуло — не спамимо, скажемо ввечері
    } else if (now.minutes >= due - before) {
      const late = now.minutes > due;
      await tg(env, "sendMessage", {
        chat_id: user.chat_id, parse_mode: "HTML",
        text: `${late ? "Час минув" : "Незабаром"}: <b>${esc(t.title)}</b> о ${t.time}` +
          (t.note ? `\n<i>${esc(t.note)}</i>` : ""),
        reply_markup: tasksKeyboard([t], null, { withTomorrow: true }),
      });
      await store.markReminded(t.id);
    }
  }

  // 2) Зранку: план на день і зведення звичок (одне повідомлення, в межах 3 годин від MORNING_HOUR)
  const morning = Number(env.MORNING_HOUR || 9);
  if (now.hour >= morning && now.hour < morning + 3 && user.last_morning_date !== now.date) {
    await store.setLastMorning(user.id, now.date);
    const [tasks, overdue, habits] = await Promise.all([
      store.tasksBetween(user.id, now.date, now.date),
      store.overdue(user.id, now.date),
      store.habits(user.id),
    ]);
    const active = habits.filter((h) => h.start_date <= now.date);
    if (tasks.some((t) => !t.done) || overdue.length || active.length) {
      await tg(env, "sendMessage", {
        chat_id: user.chat_id, parse_mode: "HTML",
        text: morningText(now.date, tasks, overdue, active),
        reply_markup: tasksKeyboard(tasks, webappUrl),
      });
    }
  }

  // 3) Ввечері: день добігає кінця, а справи «горять»; і невідмічені звички
  if (now.hour >= Number(env.EVENING_HOUR || 21) && user.last_evening_date !== now.date) {
    await store.setLastEvening(user.id, now.date);
    const tasks = await store.tasksBetween(user.id, now.date, now.date);
    const open = tasks.filter((t) => !t.done);
    if (open.length) {
      await tg(env, "sendMessage", {
        chat_id: user.chat_id, parse_mode: "HTML",
        text: `<b>День добігає кінця, а ${open.length} ${plural(open.length, "завдання", "завдання", "завдань")} ще не виконано.</b>\n` +
          "Позначте зроблене або перенесіть на завтра.\n\n" + dayText(now.date, tasks),
        reply_markup: tasksKeyboard(tasks, webappUrl, { withTomorrow: true }),
      });
    }
    const habits = await store.unmarkedHabits(user.id, now.date);
    if (habits.length) {
      await tg(env, "sendMessage", {
        chat_id: user.chat_id, parse_mode: "HTML",
        text: habitsText(habits), reply_markup: habitsKeyboard(habits, now.date, webappUrl),
      });
    }
  }
}

export async function runReminders(env, store, webappUrl) {
  for (const user of await store.usersWithChat()) {
    try { await checkUser(env, store, user, webappUrl); }
    catch (e) { console.log("reminder error for", user.id, e?.stack || e); }
  }
}
