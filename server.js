import crypto from "node:crypto";
import fs from "node:fs/promises";
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

// Límites de imágenes
const MAX_IMAGES = 5; // imágenes máximas por petición
const MAX_IMAGE_B64 = 7_000_000; // ~5 MB por imagen (en base64)
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const client = new Anthropic(); // lee ANTHROPIC_API_KEY automáticamente
const app = express();
app.set("trust proxy", true); // Coolify pone un proxy delante
app.use(express.json({ limit: "25mb" }));

// --- Guardado de conversaciones (archivos JSON en el volumen) ---
const DATA_DIR = process.env.DATA_DIR || "/data/conversations";
await fs.mkdir(DATA_DIR, { recursive: true });
const ID_RE = /^[0-9a-f-]{36}$/;
const fileOf = (id) => path.join(DATA_DIR, id + ".json");

function titleOf(messages) {
  const c = messages[0]?.content;
  const t = typeof c === "string" ? c : c?.find((b) => b.type === "text")?.text;
  return (t || "Conversación").slice(0, 60);
}

// messages = lo que muestra la interfaz; history = lo que ve el modelo (con herramientas)
async function saveConversation(id, messages, answer, history) {
  const full = [...messages, { role: "assistant", content: answer }];
  await fs.writeFile(
    fileOf(id),
    JSON.stringify({ id, title: titleOf(full), updatedAt: Date.now(), messages: full, history })
  );
}

// Si hay historial con herramientas guardado y coincide con lo que manda el cliente, lo usa
async function loadHistory(id, messages) {
  if (!id) return [...messages];
  try {
    const saved = JSON.parse(await fs.readFile(fileOf(id), "utf8"));
    if (saved.history && saved.messages?.length === messages.length - 1) {
      return [...saved.history, messages.at(-1)];
    }
  } catch {}
  return [...messages];
}

// --- Herramienta para leer URLs ---
const TOOLS = [
  {
    name: "leer_url",
    description: "Descarga y lee el texto de una página web a partir de su URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL completa, con http:// o https://" },
      },
      required: ["url"],
    },
  },
];

async function leerUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "URL no válida";
  try {
    // Jina Reader descarga la página por nosotros (así tu servidor no accede a redes internas)
    const r = await fetch("https://r.jina.ai/" + url, {
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    return text.slice(0, 15000) || "La página no devolvió contenido";
  } catch (e) {
    return "Error al leer la URL: " + e.message;
  }
}

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

// --- Conversaciones guardadas ---
app.get("/api/conversations", requireAuth, async (req, res) => {
  const list = [];
  for (const f of await fs.readdir(DATA_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const { id, title, updatedAt } = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), "utf8"));
      list.push({ id, title, updatedAt });
    } catch {}
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

app.get("/api/conversations/:id", requireAuth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "ID no válido" });
  try {
    res.json(JSON.parse(await fs.readFile(fileOf(req.params.id), "utf8")));
  } catch {
    res.status(404).json({ error: "No encontrada" });
  }
});

app.delete("/api/conversations/:id", requireAuth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "ID no válido" });
  await fs.rm(fileOf(req.params.id), { force: true });
  res.json({ ok: true });
});

// Acepta texto (string) o una lista de bloques de texto e imagen
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (messages.length > MAX_MESSAGES) return null;
  let total = 0;
  let images = 0;
  const clean = [];
  for (const [i, m] of messages.entries()) {
    const expectedRole = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== expectedRole) return null;

    if (typeof m.content === "string") {
      const content = m.content.trim();
      if (!content) return null;
      total += content.length;
      clean.push({ role: m.role, content });
      continue;
    }

    // Bloques (solo el usuario puede mandar imágenes)
    if (m.role !== "user" || !Array.isArray(m.content) || m.content.length === 0) return null;
    const blocks = [];
    for (const b of m.content) {
      if (b?.type === "text" && typeof b.text === "string") {
        const text = b.text.trim();
        if (!text) continue;
        total += text.length;
        blocks.push({ type: "text", text });
      } else if (
        b?.type === "image" &&
        b.source?.type === "base64" &&
        IMAGE_TYPES.includes(b.source.media_type) &&
        typeof b.source.data === "string" &&
        b.source.data.length <= MAX_IMAGE_B64
      ) {
        images++;
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: b.source.media_type, data: b.source.data },
        });
      } else {
        return null;
      }
    }
    if (blocks.length === 0) return null;
    clean.push({ role: m.role, content: blocks });
  }
  if (images > MAX_IMAGES || total > MAX_CHARS || clean.at(-1).role !== "user") return null;
  return clean;
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const messages = validateMessages(req.body?.messages);
  if (!messages) return res.status(400).json({ error: "Mensajes no válidos" });
  const convId = ID_RE.test(req.body?.id) ? req.body.id : null;

  // Respuesta en vivo: una línea JSON por cada trozo de texto
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  // Conversación de trabajo (incluye resultados de herramientas de vueltas anteriores)
  const convo = await loadHistory(convId, messages);
  let currentStream = null;
  let answer = "";
  let finished = false;

  res.on("close", () => {
    if (!res.writableEnded) currentStream?.abort();
  });

  try {
    // Bucle de herramientas (máximo 5 vueltas)
    for (let turn = 0; turn < 5; turn++) {
      // Separa el texto de vueltas distintas
      if (turn > 0 && answer && !answer.endsWith("\n")) {
        answer += "\n\n";
        send({ type: "text", text: "\n\n" });
      }

      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        output_config: { effort: "low" },
        // Si el filtro de seguridad rechaza la petición, Anthropic la reintenta con otro modelo
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: TOOLS,
        messages: convo,
      });
      currentStream = stream;
      stream.on("text", (text) => {
        answer += text;
        send({ type: "text", text });
      });
      const final = await stream.finalMessage();

      if (final.stop_reason === "tool_use") {
        convo.push({ role: "assistant", content: final.content });
        const results = [];
        for (const block of final.content) {
          if (block.type === "tool_use") {
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: await leerUrl(block.input?.url),
            });
          }
        }
        convo.push({ role: "user", content: results });
        continue; // vuelve a llamar al modelo con el resultado
      }

      convo.push({ role: "assistant", content: final.content });
      finished = true;

      if (final.stop_reason === "refusal") {
        send({ type: "error", error: "La IA no puede responder a esta petición." });
      } else if (final.stop_reason === "max_tokens") {
        send({ type: "error", error: "La respuesta se cortó por ser demasiado larga." });
      }
      break;
    }

    if (!finished) {
      send({
        type: "error",
        error: "Se alcanzó el límite de lecturas de páginas. La respuesta puede estar incompleta.",
      });
    }
    if (convId && answer) {
      // Si no terminó, convo acaba en un mensaje de usuario: no se guarda history
      await saveConversation(convId, messages, answer, finished ? convo : undefined);
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
