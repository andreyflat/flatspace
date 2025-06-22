const fs = require("fs");
const path = require("path");

const SECRET_KEY = "flat4ers"; // замените на свой

// Файл, где будет лог
const LOG_PATH = path.join(__dirname, "views-log.json");

exports.handler = async function (event, context) {
  const { key } = event.queryStringParameters || {};

  if (key !== SECRET_KEY) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "Forbidden" }),
    };
  }

  let log = [];
  if (fs.existsSync(LOG_PATH)) {
    try {
      log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    } catch (err) {
      console.error("Ошибка чтения лога:", err);
    }
  }

  const newEntry = {
    timestamp: new Date().toISOString(),
    path: event.rawUrl || "unknown",
    ip: event.headers["x-forwarded-for"] || "unknown",
    ua: event.headers["user-agent"] || "unknown",
  };

  log.push(newEntry);

  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));

  return {
    statusCode: 200,
    body: JSON.stringify({ status: "logged", total: log.length }),
  };
};
