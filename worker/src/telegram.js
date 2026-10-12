// Виклики Bot API і перевірка підпису initData з Mini App.

export async function tg(env, method, payload = {}) {
  const base = env.TELEGRAM_API || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.log(`Telegram ${method} failed:`, JSON.stringify(data).slice(0, 300));
  return data;
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function verifyInitData(initData, botToken, maxAgeSec = 7 * 24 * 3600) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", botToken);
  const calc = hex(await hmac(secret, check));
  if (calc.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (maxAgeSec && Date.now() / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get("user")); } catch { return null; }
}

// Секрет вебхука: Telegram надсилає його в заголовку, сторонні запити відкидаємо
export async function webhookSecret(botToken) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode("ritmoza-webhook:" + botToken))).slice(0, 48);
}
