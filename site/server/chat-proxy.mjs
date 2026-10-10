// Прокси между чатом на сайте и Claude API. Ключ хранится только на сервере.
// Запуск: ANTHROPIC_API_KEY=sk-... ALLOW_ORIGIN=https://ваш-сайт node chat-proxy.mjs
// Потом в index.html укажите: window.KD_CHAT_ENDPOINT = "https://адрес-прокси/chat";
// И добавьте этот адрес в connect-src в vercel.json (Content-Security-Policy).
import http from "node:http";
import { readFile } from "node:fs/promises";

const PORT = process.env.PORT || 8787;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN; // обязателен, например https://kd.example
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY || !ALLOW_ORIGIN) {
  console.error("Нужны переменные окружения ANTHROPIC_API_KEY и ALLOW_ORIGIN");
  process.exit(1);
}
const SYSTEM = await readFile(new URL("./chat-agent-prompt.md", import.meta.url), "utf8");

const MAX_BODY = 20000;       // байт на запрос
const MAX_MESSAGES = 20;      // сообщений в истории
const MAX_CHARS = 1000;       // символов в сообщении
const RATE_LIMIT = 20;        // запросов с одного IP за окно
const RATE_WINDOW_MS = 60_000;
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  rec.push(now);
  hits.set(ip, rec);
  if (hits.size > 10000) hits.clear(); // защита от разрастания памяти
  return rec.length > RATE_LIMIT;
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
  res.end(obj ? JSON.stringify(obj) : undefined);
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return send(res, 204);
  if (req.method !== "POST" || req.url !== "/chat") return send(res, 404);
  if (req.headers.origin !== ALLOW_ORIGIN) return send(res, 403, { error: "forbidden" });

  // За прокси (Vercel, nginx) настоящий адрес приходит в x-forwarded-for
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "too_many_requests" });

  try {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) return send(res, 413, { error: "too_large" }); }
    const { messages } = JSON.parse(raw);
    if (!Array.isArray(messages) || messages.length === 0) return send(res, 400, { error: "bad_request" });

    const clean = messages.slice(-MAX_MESSAGES).map(m => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String(m && m.content || "").slice(0, MAX_CHARS)
    }));
    if (clean[clean.length - 1].role !== "user") return send(res, 400, { error: "bad_request" });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 400, system: SYSTEM, messages: clean })
    });
    if (!r.ok) throw new Error("upstream " + r.status);
    const data = await r.json();
    const reply = data.content.filter(b => b.type === "text").map(b => b.text).join("");
    send(res, 200, { reply });
  } catch (e) {
    console.error("chat error:", e.message); // детали только в логе, клиенту общий ответ
    send(res, 500, { error: "chat_failed" });
  }
}).listen(PORT, () => console.log("KD chat proxy on :" + PORT));
