const https = require("https");

// Обеспечим fetch в Node.js
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Безопасно получаем переменные окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;

exports.handler = async function (event) {
  const { key } = event.queryStringParameters || {};
  const ua = event.headers["user-agent"] || "";
  const referer = event.headers["referer"] || "";

  // Базовая защита от внешнего вызова и ботов
  if (
    key !== SECRET_KEY ||
    ua.includes("TelegramBot") ||
    !referer.includes("andreyflat.space")
  ) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "Forbidden" }),
    };
  }

  const timestamp = new Date().toISOString();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0] || "unknown";

  // Краткий User-Agent: определим OS и браузер
  let os = "Unknown OS";
  let browser = "Unknown Browser";

  if (ua.includes("Win")) os = "Windows";
  else if (ua.includes("Mac")) os = "macOS";
  else if (ua.includes("X11") || ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

  if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Chrome/") && !ua.includes("Chromium")) browser = "Chrome";
  else if (ua.includes("Safari/") && !ua.includes("Chrome/")) browser = "Safari";
  else if (ua.includes("Chromium/")) browser = "Chromium";

  const shortUA = `${os} / ${browser}`;

  // Определение локации по IP
  let location = "Unknown";
  try {
    const geoRes = await fetch(`https://ipapi.co/${ip}/json/`);
    if (geoRes.ok) {
      const geo = await geoRes.json();
      if (geo.city && geo.country_name) {
        location = `${geo.country_name}, ${geo.city}`;
      } else if (geo.country_name) {
        location = geo.country_name;
      }
    } else {
      location = `Geo lookup failed (${geoRes.status})`;
    }
  } catch (e) {
    location = "Lookup error";
  }

  // Текст уведомления
  const message =
`🔔 *New View Logged*
📍 ${location}
🌍 IP: \`${ip}\`
📱 ${shortUA}`;

  const data = JSON.stringify({
    chat_id: CHAT_ID,
    text: message,
    parse_mode: "Markdown",
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": data.length,
    },
  };

  // Отправляем сообщение в Telegram
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        resolve({
          statusCode: 200,
          body: JSON.stringify({ status: "sent securely" }),
        });
      });
    });
    req.on("error", (e) => {
      reject({
        statusCode: 500,
        body: JSON.stringify({ error: e.message }),
      });
    });
    req.write(data);
    req.end();
  });
};
