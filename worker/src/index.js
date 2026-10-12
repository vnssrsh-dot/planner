// Ritmoza на Cloudflare Workers: вебхук бота, API Mini App, статика, нагадування за розкладом.
import { ensureSchema, Store } from "./db.js";
import { handleApi, HttpError } from "./api.js";
import { handleUpdate } from "./bot.js";
import { runReminders } from "./reminders.js";
import { tg, webhookSecret } from "./telegram.js";

async function setup(env, store, origin) {
  const secret = await webhookSecret(env.BOT_TOKEN);
  const results = {
    webhook: await tg(env, "setWebhook", {
      url: `${origin}/telegram`, secret_token: secret,
      allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
    }),
    commands: await tg(env, "setMyCommands", {
      commands: [
        { command: "today", description: "План на сьогодні" },
        { command: "add", description: "Додати завдання на сьогодні" },
        { command: "tomorrow", description: "Додати завдання на завтра" },
      ],
    }),
    menu: await tg(env, "setChatMenuButton", {
      menu_button: { type: "web_app", text: "Ritmoza", web_app: { url: origin } },
    }),
    short: await tg(env, "setMyShortDescription", {
      short_description: "Ritmoza — плануй · живи · розвивайся. Справи, календар і звички в Telegram.",
    }),
    description: await tg(env, "setMyDescription", {
      description: "Ritmoza — твій спокійний планер.\n\n• план на сьогодні та календар\n" +
        "• звички й прогрес регулярності\n• нагадування, коли день добігає кінця\n\nНатисни «Почати», щоб розпочати.",
    }),
  };
  await store.setSetting("webapp_url", origin);
  const ok = results.webhook.ok;
  const me = await tg(env, "getMe");
  const link = me.ok ? `https://t.me/${me.result.username}` : null;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ritmoza</title><body style="font:16px/1.5 system-ui;padding:24px;max-width:520px;margin:auto;background:#F4F2EE;color:#26302A">
<h2>${ok ? "Готово! Ritmoza підключено ✓" : "Не вдалося підключити бота"}</h2>
${ok && link ? `<p>Посилання для користувачів:<br><a href="${link}" style="font-size:20px;color:#607567">${link}</a></p>` : ""}
${ok ? "<p>Надішліть боту /start, щоб перевірити.</p>" : `<p>Перевірте секрет BOT_TOKEN у налаштуваннях Worker.</p><pre style="white-space:pre-wrap">${JSON.stringify(results.webhook)}</pre>`}
</body>`;
  return new Response(html, { status: ok ? 200 : 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Mini App посилається на /static/... — віддаємо файли з ../webapp (працює й без токена)
    if (url.pathname.startsWith("/static/")) {
      return env.ASSETS.fetch(new Request(new URL(url.pathname.slice(7), url.origin), req));
    }
    try {
      if (!env.BOT_TOKEN) {
        return new Response("Ritmoza: додайте секрет BOT_TOKEN у Settings → Variables and Secrets.", {
          status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      await ensureSchema(env.DB);
      const store = new Store(env.DB);

      if (url.pathname === "/telegram" && req.method === "POST") {
        if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env.BOT_TOKEN))) {
          return new Response("forbidden", { status: 403 });
        }
        const update = await req.json();
        // відповідаємо Telegram одразу, обробку доводимо у фоні
        ctx.waitUntil(handleUpdate(env, store, update, url.origin).catch((e) => console.log("update error", e?.stack || e)));
        return new Response("ok");
      }
      if (url.pathname === "/setup") return setup(env, store, url.origin);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, env, store);

      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return new Response(e.message, { status: e.status });
      console.log("error", e?.stack || e);
      return new Response("internal error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.BOT_TOKEN) return;
    await ensureSchema(env.DB);
    const store = new Store(env.DB);
    const webappUrl = env.WEBAPP_URL || (await store.getSetting("webapp_url"));
    await runReminders(env, store, webappUrl);
  },
};
