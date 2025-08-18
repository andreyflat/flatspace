// netlify/functions/privateViewLogger.js
// Требуется package.json с {"type":"module"}

import https from "https";
import { createRequire } from "module";
import CryptoJS from "crypto-js";
import { createClient } from "@supabase/supabase-js";

// geoip-lite — CommonJS, подключаем через createRequire
const require = createRequire(import.meta.url);
const geoip = require("geoip-lite");

// node-fetch (lazy import для совместимости)
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// --- ENV ---
const BOT_TOKEN     = process.env.BOT_TOKEN;             // опционально
const CHAT_ID       = process.env.CHAT_ID;               // опционально
const SECRET_KEY    = process.env.SECRET_KEY;            // обязателен
const SUPABASE_URL  = process.env.SUPABASE_URL;          // обязателен
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;  // обязателен

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ---------- helpers ----------
function extractIp(headers = {}) {
  return (
    headers["x-nf-client-connection-ip"] ||
    (headers["x-forwarded-for"] || "").split(",")[0]?.trim() ||
    headers["client-ip"] ||
    headers["x-real-ip"] ||
    ""
  );
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const cleaned = ip.replace(/^\[?([^\]]+)\]?(:\d+)?$/, "$1");
  // IPv4 private / CGNAT
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned)) {
    const [a, b] = cleaned.split(".").map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  // IPv6 localhost/ULA
  const lc = cleaned.toLowerCase();
  if (lc === "::1" || lc.startsWith("fc") || lc.startsWith("fd")) return true;
  return false;
}

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

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return { ok: true };
  const data = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.write(data);
    req.end();
  });
}

// ---------- handler ----------
export async function handler(event) {
  // --- доступ: ключ ИЛИ тот же домен; блокируем TelegramBot UA ---
  const qs = event.queryStringParameters || {};
  let path = qs.path || "";
  try {
    if (!path && event.body) {
      const body = JSON.parse(event.body);
      if (body && typeof body.path === "string") path = body.path;
    }
  } catch {}

  const { key } = qs;
  const headers = event.headers || {};
  const ua = headers["user-agent"] || "";
  const referer = (headers["referer"] || "").toLowerCase();

  const sameOrigin = referer.includes("andreyflat.space");
  const keyOk = key && SECRET_KEY && key === SECRET_KEY;

  if (ua.includes("TelegramBot") || (!keyOk && !sameOrigin)) {
    return {
      statusCode: 403,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
      body: JSON.stringify({ error: "Forbidden" }),
    };
  }

  // --- IP и гео ---
  const ipRaw = extractIp(headers) || "unknown";
  const { os, browser } = parseUA(ua);

  let country = null;
  let city = null;

  if (ipRaw !== "unknown" && !isPrivateIp(ipRaw)) {
    // оффлайн-гео
    const geo = geoip.lookup(ipRaw);
    if (geo?.country) country = geo.country; // ISO-2 код
    if (geo?.city) city = geo.city;

    // мягкая попытка добрать город из ipapi (таймаут 3с)
    if (!city) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`https://ipapi.co/${ipRaw}/json/`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          const j = await r.json();
          city = j.city || city;
          country = j.country_name || j.country || country;
        }
      } catch {
        // игнорируем
      }
    }
  }

  // --- хэш IP (а не хранение IP) ---
  const ip_hash = CryptoJS.SHA256(`${ipRaw}|${SECRET_KEY}`).toString();

  // --- запись в Supabase ---
  const insertPayload = {
    path,
    referrer: headers["referer"] || null,
    ip_hash,
    country: country || null,
    city: city || null,
    ua_os: os,
    ua_browser: browser,
  };

  const { error } = await supabase.from("pageviews").insert([insertPayload]);

  // --- уведомление в Telegram (опционально) ---
  const loc = country ? (city ? `${country}, ${city}` : country) : "Unknown";
  const text =
`🔔 *New View*
📍 ${loc}
🧭 path: ${path || "/"}
🌍 IP(hash): \`${ip_hash.slice(0, 12)}…\`
📱 ${os} / ${browser}`;

  if (!error) await sendTelegram(text);

  if (error) {
    return {
      statusCode: 500,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
      body: JSON.stringify({ error: error.message }),
    };
  }

  // --- успешный ответ + анти‑кэш ---
  return {
    statusCode: 200,
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
    body: JSON.stringify({ ok: true }),
  };
}
