// Дати як рядки YYYY-MM-DD у часовому поясі користувача.

// Intl.DateTimeFormat дорогий у створенні, а Cron на безкоштовному плані має ліміт ~10 мс CPU.
// Тому форматери створюємо один раз на часовий пояс і перевикористовуємо.
const formatters = new Map();
function formatterFor(zone) {
  let f = formatters.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      });
    } catch {
      f = null; // невідомий часовий пояс
    }
    formatters.set(zone, f);
  }
  return f;
}

export function validZone(tz) {
  return !!tz && !!formatterFor(tz);
}

export function localNow(tz, fallback) {
  const zone = validZone(tz) ? tz : validZone(fallback) ? fallback : "UTC";
  const parts = {};
  for (const p of formatterFor(zone).formatToParts(new Date())) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return {
    tz: zone,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minutes: hour * 60 + Number(parts.minute),
  };
}

export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const WEEKDAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

export function humanDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]}, ${d} ${MONTHS_GEN[m - 1]}`;
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
