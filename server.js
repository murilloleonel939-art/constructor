import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

// --- Configuración (variables de entorno) ---
const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Falta la variable ANTHROPIC_API_KEY");
  process.exit(1);
}
if (!APP_PASSWORD) {
  console.error("Falta la variable APP_PASSWORD");
  process.exit(1);
}

const SYSTEM_PROMPT =
  "Eres un asistente útil y amable. Responde en el idioma en que te escriba el usuario, " +
  "de forma clara y concisa.";

const COOKIE_NAME = "chat_session";
const SESSION_DAYS = 7;
const MAX_MESSAGES = 100; // límite de mensajes de historial por petición
const MAX_CHARS = 200_000; // límite total de caracteres del historial

const client = new Anthropic(); // lee ANTHROPIC_API_KEY automáticamente
const app = express();
app.set("trust proxy", true); // Coolify pone un proxy delante
app.use(express.json({ limit: "1mb" }));

// --- Sesión: cookie firmada con la contraseña (si cambias la contraseña, todos salen) ---
const signingKey = crypto.createHash("sha256").update("session:" + APP_PASSWORD).digest();

function sign(value) {
  return crypto.createHmac("sha256", signingKey).update(value).digest("base64url");
}

function createToken() {
  const expires = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return `${expires}.${sign(expires)}`;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isValidToken(token) {
  if (!token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature) return false;
  if (!safeEqual(signature, sign(expires))) return false;
  return Number(expires) > Date.now();
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (req.secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function requireAuth(req, res, next) {
  if (isValidToken(getCookie(req, COOKIE_NAME))) return next();
  res.status(401).json({ error: "No autorizado" });
}

// --- Límite de intentos de contraseña por IP ---
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(ip) {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) if (entry.resetAt < now) attempts.delete(ip);
}, WINDOW_MS).unref();

// --- Rutas ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/session", (req, res) => {
  res.json({ authenticated: isValidToken(getCookie(req, COOKIE_NAME)) });
});

app.post("/api/login", (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(password, APP_PASSWORD)) {
    recordFailure(ip);
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  attempts.delete(ip);
  setSessionCookie(req, res, createToken(), SESSION_DAYS * 24 * 60 * 60);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  setSessionCookie(req, res, "", 0);
  res.json({ ok: true });
});

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (messages.length > MAX_MESSAGES) return null;
  let total = 0;
  const clean = [];
  for (const [i, m] of messages.entries()) {
    const expectedRole = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== expectedRole || typeof m.content !== "string") return null;
    const content = m.content.trim();
    if (!content) return null;
    total += content.length;
    clean.push({ role: m.role, content });
  }
  if (total > MAX_CHARS || clean.at(-1).role !== "user") return null;
  return clean;
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const messages = validateMessages(req.body?.messages);
  if (!messages) return res.status(400).json({ error: "Mensajes no válidos" });

  // Respuesta en vivo: una línea JSON por cada trozo de texto
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "low" },
    // Si el filtro de seguridad rechaza la petición, Anthropic la reintenta con otro modelo
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages,
  });

  res.on("close", () => {
    if (!res.writableEnded) stream.abort();
  });

  try {
    stream.on("text", (text) => send({ type: "text", text }));
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      send({ type: "error", error: "La IA no puede responder a esta petición." });
    } else if (final.stop_reason === "max_tokens") {
      send({ type: "error", error: "La respuesta se cortó por ser demasiado larga." });
    }
    send({ type: "done" });
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) return;
    console.error("Error de la API de Anthropic:", err);
    let message = "Error al contactar con la IA. Inténtalo de nuevo.";
    if (err instanceof Anthropic.AuthenticationError) {
      message = "La clave ANTHROPIC_API_KEY no es válida.";
    } else if (err instanceof Anthropic.RateLimitError) {
      message = "Demasiadas peticiones. Espera un momento.";
    } else if (err instanceof Anthropic.APIConnectionError) {
      message = "No se pudo conectar con Anthropic.";
    }
    send({ type: "error", error: message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Chat escuchando en el puerto ${PORT} (modelo: ${MODEL})`);
});
