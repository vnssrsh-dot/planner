// Нагадування (Cron щохвилини):
//  • через 30 хв після знайомства — запрошення заповнити планер (якщо людина нічого не додала);
//  • 9:00 — план дня (тим, хто користується планером);
//  • за 15 хв до справи з часом — «Незабаром», через 30 хв після, якщо не відмічено, — «Час минув»;
//  • 21:00 — «Підсумки дня» одним повідомленням.
// Під кожним повідомленням лише кнопка «Відкрити Ritmoza» — справи змінюють у застосунку.
import { localNow, addDays } from "./time.js";
import { tg } from "./telegram.js";
import { morningText, inviteText, eveningText, openKeyboard, reminderKeyboard, esc } from "./views.js";

const INVITE_DELAY_MS = 30 * 60 * 1000;
const FOLLOW_UP_MIN = 30; // «Час минув» — через стільки хвилин після часу справи

// «через 3 год», «через 1 год 20 хв», «через 45 хв»
function untilText(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${h} год` : "", m ? `${m} хв` : ""].filter(Boolean).join(" ") || "кілька хвилин";
}

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

  // 2) Справи з часом — два кроки:
  //    • за 15 хв до часу — «Незабаром»;
  //    • через 30 хв після часу, якщо справу не відмічено, — «Час минув».
  //    Справу, записану вже після її часу, не нагадуємо. Задача о 23:50 отримає «Час минув» після півночі.
  const yesterday = addDays(now.date, -1), tomorrow = addDays(now.date, 1);
  for (const t of await store.timedPending(user.id, yesterday, tomorrow)) {
    const [h, m] = t.time.split(":").map(Number);
    const dayShift = t.date === now.date ? 0 : t.date === yesterday ? -1440 : 1440;
    const due = dayShift + h * 60 + m;                           // хвилини від початку сьогоднішньої доби
    const remind = t.remind_before ?? before;                    // «Нагадати за», обране людиною
    const sinceDue = now.minutes - due;                          // >0 — час уже минув
    const dueMs = Date.now() - sinceDue * 60000;

    if (t.scheduled_at && Date.parse(t.scheduled_at) >= dueMs) { await store.markFollowedUp(t.id); continue; }
    if (sinceDue > 180) { await store.markFollowedUp(t.id); continue; } // давно — скаже вечірня зведення

    let kind = null;
    if (!t.followed_up && sinceDue >= FOLLOW_UP_MIN) kind = "late";
    else if (!t.reminded && sinceDue >= -remind && sinceDue < FOLLOW_UP_MIN) kind = "soon";
    if (!kind) continue;

    const text = kind === "soon"
      ? `<b>${sinceDue > 0 ? "Вже час" : remind > 60 ? "Нагадування" : "Незабаром"}:</b> ${esc(t.title)} ` +
        `${t.date === tomorrow ? "завтра " : ""}о ${t.time}` +
        (sinceDue < 0 && remind > 60 ? ` <i>(через ${untilText(-sinceDue)})</i>` : "") +
        (t.note ? `\n<i>${esc(t.note)}</i>` : "")
      : `<b>Час минув:</b> ${esc(t.title)} о ${t.time}\nЯкщо вже зроблено — відміть ✓. Якщо ні — перенеси в Ritmoza.`;
    const res = await tg(env, "sendMessage", {
      chat_id: user.chat_id, parse_mode: "HTML", text, reply_markup: reminderKeyboard(t, webappUrl),
    });
    const at = `${now.tz} ${now.date} ${Math.floor(now.minutes / 60)}:${String(now.minutes % 60).padStart(2, "0")}`;
    // «надіслано» — лише після підтвердження Telegram; збій мережі — повторимо наступної хвилини;
    // людина заблокувала бота (403) чи помилка запиту (400) — більше не пробуємо
    if (res.ok || res.error_code === 403 || res.error_code === 400) {
      await (kind === "soon" ? store.markReminded(t.id) : store.markFollowedUp(t.id));
      console.log(`reminder ${kind} ${res.ok ? "sent" : "dropped " + res.error_code}: user ${user.id}, task ${t.id} ${t.date} ${t.time} (${at})`);
    } else {
      console.log(`reminder ${kind} FAILED, will retry: user ${user.id}, task ${t.id} (${at}):`, JSON.stringify(res).slice(0, 200));
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
