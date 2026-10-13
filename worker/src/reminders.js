// Нагадування (Cron щохвилини):
//  • через 30 хв після знайомства — запрошення заповнити планер (якщо людина нічого не додала);
//  • 9:00 — план дня (тим, хто користується планером);
//  • за 15 хв до справи з часом — «Незабаром»;
//  • 21:00 — «Підсумки дня» одним повідомленням.
// Під кожним повідомленням лише кнопка «Відкрити Ritmoza» — справи змінюють у застосунку.
import { localNow, addDays } from "./time.js";
import { tg } from "./telegram.js";
import { morningText, inviteText, eveningText, openKeyboard, reminderKeyboard, esc } from "./views.js";

const INVITE_DELAY_MS = 30 * 60 * 1000;

async function send(env, chatId, text, webappUrl, hash) {
  await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text, reply_markup: openKeyboard(webappUrl, hash) });
}

async function checkUser(env, store, user, webappUrl) {
  const now = localNow(user.tz, env.DEFAULT_TZ);
  const before = Number(env.REMIND_BEFORE_MIN || 15);
  const active = await store.hasActivity(user.id);

  // 1) Запрошення через 30 хвилин після першого /start — один раз і лише якщо нічого не додано
  if (!user.welcome_sent && user.started_at && Date.now() - Date.parse(user.started_at) >= INVITE_DELAY_MS) {
    await store.markWelcomeSent(user.id);
    if (!active) await send(env, user.chat_id, inviteText(now.hour, user.first_name), webappUrl);
  }
  if (!active) return; // далі — лише для тих, хто користується планером

  // 2) За N хвилин до справи з часом — про кожну справу окремо
  for (const t of await store.timedUnreminded(user.id, now.date)) {
    const [h, m] = t.time.split(":").map(Number);
    const due = h * 60 + m;
    if (now.minutes > due + 60) {
      await store.markReminded(t.id); // давно минуло — не спамимо, скажемо ввечері
    } else if (now.minutes >= due - before) {
      const late = now.minutes > due;
      const res = await tg(env, "sendMessage", {
        chat_id: user.chat_id, parse_mode: "HTML",
        text: `${late ? "Час минув" : "Незабаром"}: <b>${esc(t.title)}</b> о ${t.time}` + (t.note ? `\n<i>${esc(t.note)}</i>` : ""),
        reply_markup: reminderKeyboard(t, webappUrl),
      });
      const at = `${now.tz} ${now.date} ${Math.floor(now.minutes / 60)}:${String(now.minutes % 60).padStart(2, "0")}`;
      // Відмічаємо «надіслано» лише коли Telegram підтвердив. Збій мережі чи перевантаження —
      // спробуємо ще раз наступної хвилини. Якщо людина заблокувала бота (403) — більше не пробуємо.
      if (res.ok || res.error_code === 403 || res.error_code === 400) {
        await store.markReminded(t.id);
        console.log(`reminder ${res.ok ? "sent" : "dropped " + res.error_code}: user ${user.id}, task ${t.id} at ${t.time} (${at})`);
      } else {
        console.log(`reminder FAILED, will retry: user ${user.id}, task ${t.id} at ${t.time} (${at}):`, JSON.stringify(res).slice(0, 200));
      }
    }
  }

  // 3) Зранку — план дня, хвости і серії звичок (у межах 3 годин від MORNING_HOUR, раз на день)
  const morning = Number(env.MORNING_HOUR || 9);
  if (now.hour >= morning && now.hour < morning + 3 && user.last_morning_date !== now.date) {
    await store.setLastMorning(user.id, now.date);
    const [tasks, overdue, habits] = await Promise.all([
      store.tasksBetween(user.id, now.date, now.date),
      store.overdue(user.id, now.date),
      store.habits(user.id),
    ]);
    await send(env, user.chat_id, morningText(now.date, tasks, overdue, habits.filter((h) => h.start_date <= now.date)), webappUrl);
  }

  // 4) Ввечері — «Підсумки дня» одним повідомленням (якщо є що сказати)
  if (now.hour >= Number(env.EVENING_HOUR || 21) && user.last_evening_date !== now.date) {
    await store.setLastEvening(user.id, now.date);
    const tomorrow = addDays(now.date, 1);
    const [tasks, habits, tomorrowTasks] = await Promise.all([
      store.tasksBetween(user.id, now.date, now.date),
      store.unmarkedHabits(user.id, now.date),
      store.tasksBetween(user.id, tomorrow, tomorrow),
    ]);
    const text = eveningText(tasks, habits, tomorrowTasks.length === 0);
    if (text) await send(env, user.chat_id, text, webappUrl);
  }
}

export async function runReminders(env, store, webappUrl) {
  const users = await store.usersWithChat();
  for (const user of users) {
    try { await checkUser(env, store, user, webappUrl); }
    catch (e) { console.log("reminder error for", user.id, e?.stack || e); }
  }
}
