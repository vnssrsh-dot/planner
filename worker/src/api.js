// REST API для Mini App (ті самі адреси, що й у Python-версії).
import { localNow, validZone, isDate } from "./time.js";
import { verifyInitData } from "./telegram.js";

export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const json = (data, status = 200) => Response.json(data, { status });
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function body(req) {
  let data;
  try { data = await req.json(); } catch { throw bad("bad json"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("bad json");
  return data;
}

function dateParam(v) {
  if (!isDate(v)) throw bad("bad date");
  return v;
}

function cleanTask(p, partial) {
  const out = {};
  if ("title" in p || !partial) {
    const title = String(p.title ?? "").trim();
    if (!title) throw bad("title required");
    out.title = title.slice(0, 200);
  }
  if ("date" in p || !partial) out.date = dateParam(p.date);
  if ("time" in p) {
    const t = p.time || null;
    if (t !== null && !TIME_RE.test(String(t))) throw bad("bad time");
    out.time = t;
  }
  if ("note" in p) out.note = String(p.note ?? "").slice(0, 1000);
  if ("done" in p && partial) out.done = !!p.done;
  return out;
}

function cleanHabit(p, partial) {
  const out = {};
  if ("title" in p || !partial) {
    const title = String(p.title ?? "").trim();
    if (!title) throw bad("title required");
    out.title = title.slice(0, 120);
  }
  if ("kind" in p || !partial) {
    const kind = p.kind ?? "build";
    if (!["build", "quit"].includes(kind)) throw bad("bad kind");
    out.kind = kind;
  }
  return out;
}

async function authUser(req, env, store) {
  const initData = req.headers.get("X-Telegram-Init-Data") || "";
  let user;
  if (initData) {
    user = await verifyInitData(initData, env.BOT_TOKEN);
    if (!user) throw new HttpError(401, "bad initData");
  } else if (env.DEV_USER_ID) {
    user = { id: Number(env.DEV_USER_ID), first_name: "Dev" };
  } else {
    throw new HttpError(401, "open via Telegram");
  }
  let tz = req.headers.get("X-Timezone") || null;
  if (tz && !validZone(tz)) tz = null;
  await store.upsertUser(user.id, { firstName: user.first_name ?? null, tz });
  return user.id;
}

export async function handleApi(req, env, store) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const uid = await authUser(req, env, store);
  const userToday = async () => localNow((await store.getUser(uid))?.tz, env.DEFAULT_TZ).date;
  let m;

  if (path === "/api/me" && method === "GET") {
    const user = await store.getUser(uid);
    const now = localNow(user?.tz, env.DEFAULT_TZ);
    return json({ today: now.date, tz: now.tz, first_name: user?.first_name || "" });
  }

  // ---------- справи ----------
  if (path === "/api/tasks" && method === "GET") {
    const from = dateParam(url.searchParams.get("from"));
    const to = dateParam(url.searchParams.get("to") || from);
    return json(await store.tasksBetween(uid, from, to));
  }
  if (path === "/api/overdue" && method === "GET") {
    return json(await store.overdue(uid, dateParam(url.searchParams.get("today"))));
  }
  if (path === "/api/tasks" && method === "POST") {
    return json(await store.createTask(uid, cleanTask(await body(req), false)), 201);
  }
  if ((m = path.match(/^\/api\/tasks\/(\d+)$/))) {
    if (method === "PATCH") {
      const task = await store.updateTask(uid, +m[1], cleanTask(await body(req), true));
      if (!task) throw new HttpError(404, "not found");
      return json(task);
    }
    if (method === "DELETE") {
      if (!(await store.deleteTask(uid, +m[1]))) throw new HttpError(404, "not found");
      return json({ ok: true });
    }
  }

  // ---------- звички ----------
  if (path === "/api/habits" && method === "GET") return json(await store.habits(uid));
  if (path === "/api/habits" && method === "POST") {
    const data = cleanHabit(await body(req), false);
    return json(await store.createHabit(uid, { ...data, startDate: await userToday() }), 201);
  }
  if ((m = path.match(/^\/api\/habits\/(\d+)\/marks\/([\d-]+)$/)) && (method === "PUT" || method === "DELETE")) {
    const day = dateParam(m[2]);
    if (day > (await userToday())) throw bad("future date");
    const habit = await store.setHabitMark(uid, +m[1], day, method === "PUT");
    if (!habit) throw new HttpError(404, "not found");
    return json(habit);
  }
  if ((m = path.match(/^\/api\/habits\/(\d+)$/))) {
    if (method === "PATCH") {
      const habit = await store.updateHabit(uid, +m[1], cleanHabit(await body(req), true));
      if (!habit) throw new HttpError(404, "not found");
      return json(habit);
    }
    if (method === "DELETE") {
      if (!(await store.deleteHabit(uid, +m[1]))) throw new HttpError(404, "not found");
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "not found");
}
