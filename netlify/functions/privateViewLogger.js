import https from "https";
import CryptoJS from "crypto-js";
import { createClient } from "@supabase/supabase-js";
import geoip from "geoip-lite";

// node-fetch для Node 18 ESM
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const BOT_TOKEN   = process.env.BOT_TOKEN;
const CHAT_ID     = process.env.CHAT_ID;
const SECRET_KEY  = process.env.SECRET_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// извлекаем IP из заголовков (Netlify-надёжный порядок)
function extractIp(headers) {
  return (
    headers["x-nf-client-connection-ip"] ||
    (headers["x-forwarded-for"] || "").split(",")[0]?.trim() ||
    headers["client-ip"] ||
    headers["x-real-ip"] ||
    ""
  );
}

// приватные IP не геокодируем; вернём null
function isPrivateIp(ip) {
  if (!ip) return true;
  const cleaned = ip.replace(/^\[?([^\]]+)\]?(:\d+)?$/, "$1");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned)) {
    const [a,b] = cleaned.split(".").map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  if (cleaned === "::1" || cleaned.toLowerCase().startsWith("fc") || cleaned.toLowerCase().startsWith("fd")) return true;
  return false;
}

// простая нарезка UA
function parseUA(ua = "") {
  let os = "Unknown OS", browser = "Unknown Browser";
  if (/\bWindows\b/i.test(ua)) os = "Windows";
  else if (/\bMac OS X|Macintosh\b/i.test(ua)) os = "macOS";
  else if (/\bAndroid\b/i.test(ua)) os = "Android";
  else if (/\biPhone|iPad\b/i.test(ua)) os = "iOS";
  else if (/\bX11|Linux\b/i.test(ua)) os = "Linux";

  if (/Firefox\/\d+/i.test(ua)) browser = "Firefox";
  else if (/\bEdg\/\d+/i.test(ua)) browser = "Edge";
  else if (/Chrome\/\d+/i.test(ua) && !/Chromium/i.test(ua)) browser = "Chrome";
  else if (/Safari\/\d+/i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";
  else if (/Chromium\/\d+/i.test(ua)) browser = "Chromium";

  return { os, browser };
}

// отправка в Telegram (опционально)
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return { ok: true };
  const data = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, (res) => {
      res.on("data", ()=>{});
      res.on("end", ()=> resolve({ ok: res.statusCode === 200, status: res.statusCode }));
    });
    req.on("error", () => resolve({ ok: false }));
    req.write(data); req.end();
  });
}

export async function handler(event) {
  // защита: секрет обязателен; блокируем TelegramBot UA; реферер по возможности
  const { key, path = "" } = event.queryStringParameters || {};
  const headers  = event.headers || {};
  const ua       = headers["user-agent"] || "";
  const referer  = (headers["referer"] || "").toLowerCase();

  if (key !== SECRET_KEY || ua.includes("TelegramBot")) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }
  if (referer && !referer.includes("andreyflat.space")) {
    return { statusCode: 403, body: JSON.stringify({ error: "Bad referer" }) };
  }

  // IP и гео (локально, без внешних API)
  const ipRaw = extractIp(headers) || "unknown";
  let country = null, city = null;

  if (ipRaw !== "unknown" && !isPrivateIp(ipRaw)) {
    const geo = geoip.lookup(ipRaw);
    // geoip-lite возвращает { country: 'US', region: 'CA', city: 'San Francisco', ... } (город может быть null)
    if (geo?.country) country = geo.country; // ISO-2 код, например "US"
    if (geo?.city)    city    = geo.city;
  }

  // если города нет — можно мягко попытаться ipapi.co (с таймаутом), чтобы хоть иногда добирать city
  if (!city && ipRaw !== "unknown" && !isPrivateIp(ipRaw)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(()=> ctrl.abort(), 3000);
      const r = await fetch(`https://ipapi.co/${ipRaw}/json/`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        city = j.city || city;
        country = j.country_name || j.country || country;
      }
    } catch {}
  }

  const { os, browser } = parseUA(ua);
  const ip_hash = CryptoJS.SHA256(`${ipRaw}|${SECRET_KEY}`).toString();

  // запись в базу
  const { error } = await supabase.from("pageviews").insert([{
    path,
    referrer: headers["referer"] || null,
    ip_hash,
    country: country || null,
    city: city || null,
    ua_os: os,
    ua_browser: browser
  }]);

  // сообщение в тг (опционально)
  const loc = country ? (city ? `${country}, ${city}` : country) : "Unknown";
  const text =
`🔔 *New View*
📍 ${loc}
🧭 path: ${path || "/"}
🌍 IP(hash): \`${ip_hash.slice(0,12)}…\`
📱 ${os} / ${browser}`;

  if (!error) await sendTelegram(text);

  return error
    ? { statusCode: 500, body: JSON.stringify({ error: error.message }) }
    : { statusCode: 200, body: JSON.stringify({ ok: true }) };
}
