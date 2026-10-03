import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// --- Configuración (variables de entorno) ---
const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
// Modelos seleccionables en la interfaz: MODEL (por defecto) + los de MODELS (separados por comas)
const MODEL_IDS = [
  ...new Set([
    MODEL,
    ...(process.env.MODELS || "claude-haiku-4-5-20251001")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]),
];
// Configuración propia de cada modelo
function modelParams(model) {
  // Solo sonnet soporta effort parameter
  if (model === "claude-sonnet-5-5") {
    return {
      max_tokens: 64000,
      output_config: { effort: "low" },
    };
  }
  // Otros modelos: sin effort, configuración mínima
  return { max_tokens: 16000 };
}

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

// --- Proyectos de GitHub (uno por conversación; el token vive solo en el servidor) ---
const PROJECTS_DIR = process.env.PROJECTS_DIR || "/data/projects";
await fs.mkdir(PROJECTS_DIR, { recursive: true });
const projectFile = (id) => path.join(PROJECTS_DIR, id + ".json");
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,100}$/;

async function loadProject(id) {
  if (!id) return null;
  try {
    return JSON.parse(await fs.readFile(projectFile(id), "utf8"));
  } catch {
    return null;
  }
}

async function saveProject(id, project) {
  await fs.writeFile(projectFile(id), JSON.stringify(project), { mode: 0o600 });
}

async function gh(project, method, apiPath, body) {
  try {
    const r = await fetch(`https://api.github.com/repos/${project.repo}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${project.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "chat-app",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: e.message } };
  }
}

function safePath(p) {
  if (typeof p !== "string") return null;
  const clean = p.replace(/^\/+/, "");
  if (!clean || clean.length > 300) return null;
  if (clean.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  if (clean.toLowerCase().startsWith(".github/")) return null; // no tocar workflows
  return clean;
}
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const ghError = (r) => `Error ${r.status}: ${r.data?.message || "desconocido"}`;

const GITHUB_TOOLS = [
  {
    name: "github_listar",
    description: "Lista los archivos del repositorio de GitHub vinculado a este proyecto.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "github_leer",
    description:
      "Lee un archivo del repositorio vinculado. Si el resultado aparece recortado, no lo sobrescribas.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Ruta, por ejemplo src/app.js" } },
      required: ["path"],
    },
  },
  {
    name: "github_guardar",
    description:
      "Crea o reemplaza UN archivo completo en el repositorio vinculado, con un commit. " +
      "Envía el contenido completo del archivo, no solo el fragmento cambiado.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Contenido completo del archivo" },
        message: { type: "string", description: "Mensaje del commit" },
      },
      required: ["path", "content", "message"],
    },
  },
  {
    name: "github_editar",
    description:
      "Modifica un archivo EXISTENTE reemplazando un fragmento de texto exacto por otro. " +
      "Úsala para cambios pequeños: solo envías el fragmento, no el archivo entero. " +
      "'buscar' debe aparecer exactamente una vez en el archivo; incluye líneas de contexto si hace falta.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        buscar: { type: "string", description: "Texto exacto a reemplazar (debe ser único)" },
        reemplazar: { type: "string", description: "Texto nuevo" },
        message: { type: "string", description: "Mensaje del commit" },
      },
      required: ["path", "buscar", "reemplazar", "message"],
    },
  },
];

async function runGithubTool(name, input, project, ctx) {
  if (name === "github_listar") {
    const r = await gh(project, "GET", `/git/trees/${encodeURIComponent(project.branch)}?recursive=1`);
    if (!r.ok) return ghError(r);
    const files = r.data.tree.filter((t) => t.type === "blob").map((t) => `${t.path} (${t.size} bytes)`);
    let out = files.slice(0, 500).join("\n");
    if (files.length > 500) out += `\n... y ${files.length - 500} más`;
    if (r.data.truncated) out += "\n(lista incompleta)";
    return out || "El repositorio está vacío";
  }

  const p = safePath(input?.path);
  if (!p) return "Ruta no válida";
  const ref = `?ref=${encodeURIComponent(project.branch)}`;

  if (name === "github_leer") {
    const r = await gh(project, "GET", `/contents/${encPath(p)}${ref}`);
    if (!r.ok) return ghError(r);
    if (Array.isArray(r.data) || r.data.type !== "file") return "No es un archivo";
    if (!r.data.content) return "El archivo está vacío o es demasiado grande";
    const text = Buffer.from(r.data.content, "base64").toString("utf8");
    return text.length > 20000 ? text.slice(0, 20000) + "\n[... RECORTADO ...]" : text;
  }

  if (name === "github_guardar") {
    if (ctx.usedWeb) {
      return "Bloqueado por seguridad: en esta petición se leyó una página web externa. Pide el cambio de nuevo en un mensaje aparte.";
    }
    const { content, message } = input || {};
    if (typeof content !== "string" || content.length > 200_000) return "Contenido no válido o demasiado grande";
    if (typeof message !== "string" || !message.trim()) return "Falta el mensaje del commit";
    const cur = await gh(project, "GET", `/contents/${encPath(p)}${ref}`);
    if (!cur.ok && cur.status !== 404) return ghError(cur);
    const body = {
      message: message.trim().slice(0, 200),
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: project.branch,
    };
    if (cur.ok && cur.data.sha) body.sha = cur.data.sha;
    const r = await gh(project, "PUT", `/contents/${encPath(p)}`, body);
    return r.ok ? `Guardado ${p} (commit ${r.data.commit?.sha?.slice(0, 7)})` : ghError(r);
  }

  if (name === "github_editar") {
    if (ctx.usedWeb) {
      return "Bloqueado por seguridad: en esta petición se leyó una página web externa. Pide el cambio de nuevo en un mensaje aparte.";
    }
    const { buscar, reemplazar, message } = input || {};
    if (typeof buscar !== "string" || !buscar) return "Falta el fragmento a buscar";
    if (typeof reemplazar !== "string" || reemplazar.length > 100_000) return "Texto de reemplazo no válido";
    if (typeof message !== "string" || !message.trim()) return "Falta el mensaje del commit";

    const cur = await gh(project, "GET", `/contents/${encPath(p)}${ref}`);
    if (!cur.ok) return ghError(cur);
    if (Array.isArray(cur.data) || cur.data.type !== "file" || !cur.data.content) {
      return "No se puede editar: no es un archivo, está vacío o es demasiado grande";
    }
    const text = Buffer.from(cur.data.content, "base64").toString("utf8");
    const count = text.split(buscar).length - 1;
    if (count === 0) {
      return "No se encontró el fragmento. Debe coincidir exactamente (espacios y saltos de línea). Lee el archivo y vuelve a intentarlo.";
    }
    if (count > 1) {
      return `El fragmento aparece ${count} veces. Amplíalo con líneas de contexto para que sea único.`;
    }
    const nuevo = text.replace(buscar, () => reemplazar);
    const r = await gh(project, "PUT", `/contents/${encPath(p)}`, {
      message: message.trim().slice(0, 200),
      content: Buffer.from(nuevo, "utf8").toString("base64"),
      branch: project.branch,
      sha: cur.data.sha,
    });
    return r.ok ? `Editado ${p} (commit ${r.data.commit?.sha?.slice(0, 7)})` : ghError(r);
  }

  return "Herramienta no disponible";
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

app.get("/api/models", requireAuth, (req, res) => {
  res.json({ models: MODEL_IDS, default: MODEL });
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
  try {
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
  } catch (e) {
    console.error("No se pudieron leer las conversaciones:", e);
    res.status(500).json({ error: "No se pudieron leer las conversaciones" });
  }
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
  await fs.rm(projectFile(req.params.id), { force: true }); // borra también el token del proyecto
  res.json({ ok: true });
});

// --- Proyecto de GitHub vinculado a una conversación ---
app.get("/api/conversations/:id/project", requireAuth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "ID no válido" });
  const p = await loadProject(req.params.id);
  res.json(p ? { repo: p.repo, branch: p.branch } : {}); // nunca devuelve el token
});

app.put("/api/conversations/:id/project", requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "ID no válido" });
  const repo = req.body?.repo;
  const branch = req.body?.branch || "main";
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    return res.status(400).json({ error: "Repo no válido (usa dueño/nombre)" });
  }
  if (typeof branch !== "string" || !BRANCH_RE.test(branch)) {
    return res.status(400).json({ error: "Rama no válida" });
  }
  const old = await loadProject(id);
  const given = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const token = given || old?.token;
  if (!token) return res.status(400).json({ error: "Falta el token" });

  const project = { repo, branch, token };
  const check = await gh(project, "GET", `/branches/${encodeURIComponent(branch)}`);
  if (!check.ok) {
    return res
      .status(400)
      .json({ error: `No se pudo acceder (${check.status}). Revisa repo, rama y token.` });
  }
  await saveProject(id, project);
  res.json({ ok: true, repo, branch });
});

app.delete("/api/conversations/:id/project", requireAuth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "ID no válido" });
  await fs.rm(projectFile(req.params.id), { force: true });
  res.json({ ok: true });
});

// Acepta texto (string) o una lista de bloques de texto e imagen
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (messages.length > MAX_MESSAGES) {
    console.error("Mensajes no válidos: demasiados mensajes", messages.length);
    return null;
  }
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
  if (images > MAX_IMAGES || total > MAX_CHARS || clean.at(-1).role !== "user") {
    console.error("Mensajes no válidos: límite superado", {
      mensajes: messages.length,
      caracteres: total,
      imagenes: images,
    });
    return null;
  }
  return clean;
}

// --- Confirmación de commits: el usuario aprueba cada guardar/editar ---
const pendingConfirms = new Map(); // id -> { done }
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

// Envía la petición al cliente y espera su respuesta. Sin respuesta, desconexión o timeout = rechazo
function askConfirm(res, info) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (approved) => {
      clearTimeout(timer);
      pendingConfirms.delete(id);
      resolve(approved);
    };
    const timer = setTimeout(() => done(false), CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, { done });
    res.once("close", () => done(false));
    res.write(JSON.stringify({ type: "confirm", id, ...info }) + "\n");
  });
}

app.post("/api/confirm", requireAuth, (req, res) => {
  const entry = typeof req.body?.id === "string" ? pendingConfirms.get(req.body.id) : null;
  if (!entry) return res.status(404).json({ error: "Confirmación no encontrada o caducada" });
  entry.done(req.body?.approve === true);
  res.json({ ok: true });
});

app.get("/api/models", requireAuth, (req, res) => {
  res.json({ models: MODEL_IDS, default: MODEL });
});

app.post("/api/chat", requireAuth, async (req, res) => {
  const messages = validateMessages(req.body?.messages);
  if (!messages) return res.status(400).json({ error: "Mensajes no válidos" });
  const convId = ID_RE.test(req.body?.id) ? req.body.id : null;
  // Solo se aceptan modelos de la lista permitida
  const requestedModel = req.body?.model;
  const model = MODEL_IDS.includes(requestedModel) ? requestedModel : MODEL;
  console.log(`[/api/chat] Modelos disponibles: ${MODEL_IDS.join(", ")}. Solicitado: "${requestedModel}". Usando: "${model}"`);

  // Proyecto de GitHub vinculado (si existe)
  const project = await loadProject(convId);
  const tools = project ? [...TOOLS, ...GITHUB_TOOLS] : TOOLS;
  const system = project
    ? SYSTEM_PROMPT +
      `\n\nEsta conversación es un proyecto vinculado al repositorio privado ${project.repo} (rama ${project.branch}). ` +
      "Si es el primer mensaje, lee PROYECTO.md si existe. Antes de modificar un archivo, léelo. " +
      "Para cambios pequeños en archivos existentes usa github_editar (solo envías el fragmento); " +
      "usa github_guardar solo para archivos nuevos o reescrituras completas. Usa mensajes de commit claros. " +
      "Si un archivo se leyó recortado, no lo sobrescribas con github_guardar. " +
      "Cuando hagas cambios importantes, actualiza PROYECTO.md con el contexto y las decisiones."
    : SYSTEM_PROMPT;
  const ctx = { usedWeb: false };
  // Solo se pide confirmación si el cliente la soporta (así los clientes antiguos no se quedan esperando)
  const canConfirm = req.body?.canConfirm === true;

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
    for (let turn = 0; turn < 6; turn++) {
      // Separa el texto de vueltas distintas
      if (turn > 0 && answer && !answer.endsWith("\n")) {
        answer += "\n\n";
        send({ type: "text", text: "\n\n" });
      }

      const stream = client.beta.messages.stream({
        model,
        ...modelParams(model),
        system,
        tools,
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

        // Si en esta vuelta se lee una web, se bloquea guardar en GitHub durante esta petición
        if (final.content.some((b) => b.type === "tool_use" && b.name === "leer_url")) {
          ctx.usedWeb = true;
        }

        const results = [];
        for (const block of final.content) {
          if (block.type !== "tool_use") continue;
          let content;
          if (block.name === "leer_url") {
            content = await leerUrl(block.input?.url);
          } else if (project && block.name.startsWith("github_")) {
            const writes = block.name === "github_guardar" || block.name === "github_editar";
            let approved = true;
            if (writes && canConfirm && !ctx.usedWeb) {
              const i = block.input || {};
              const cut = (s) => (typeof s === "string" ? s.slice(0, 3000) : "");
              approved = await askConfirm(res, {
                tool: block.name,
                path: cut(i.path),
                commit: cut(i.message),
                buscar: cut(i.buscar),
                reemplazar: cut(i.reemplazar),
                content: cut(i.content),
              });
            }
            content = approved
              ? await runGithubTool(block.name, block.input, project, ctx)
              : "El usuario rechazó este cambio (o no respondió a tiempo). No lo reintentes sin que lo pida.";
          } else {
            content = "Herramienta no disponible";
          }
          results.push({ type: "tool_result", tool_use_id: block.id, content });
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
        error: "Se alcanzó el límite de herramientas por mensaje. La respuesta puede estar incompleta.",
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
    } else if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError) {
      message = `El modelo ${model} no está disponible o rechazó la petición. Prueba con otro.`;
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
