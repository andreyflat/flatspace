const https = require("https");

const BOT_TOKEN = "8176012401:AAGNX5Xplfvoq_xvWMGSaMfTPGLzjXaf61o"; // ← Вставь сюда
const CHAT_ID = "258874908";
const SECRET_KEY = "flat_secret_123";

exports.handler = async function (event) {
  const { key } = event.queryStringParameters || {};
  if (key !== SECRET_KEY) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "Forbidden" }),
    };
  }

  const timestamp = new Date().toISOString();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  const ua = event.headers["user-agent"] || "unknown";
  const url = event.rawUrl || "unknown";

  // Получаем геолокацию по IP
  let location = "Unknown";
  try {
    const geoRes = await fetch(`https://ipapi.co/${ip}/json/`);
    const geo = await geoRes.json();
    if (geo && geo.city && geo.country_name) {
      location = `${geo.country_name}, ${geo.city}`;
    } else if (geo && geo.country_name) {
      location = geo.country_name;
    }
  } catch (e) {
    location = "Lookup error";
  }

  const message = `
🔔 *New View Logged*
📍 ${location}
🌍 IP: \`${ip}\`
🔗 URL: ${url}
📱 UA: _${ua}_
`;

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

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        resolve({
          statusCode: 200,
          body: JSON.stringify({ status: "sent with geo" }),
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

