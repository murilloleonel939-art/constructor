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
const ID_RE = /^[0-9a-f-]{36}\$/;
const fileOf = (id) => path.join(DATA_DIR, id + ".json");

function titleOf(messages) {
  const c = messages?.content;
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
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,100}\$/;

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
    const r = await fetch(`https://github.com{project.repo}${apiPath}`, {
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
  if (typeof url !== "string") return "URL no válida";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return `Error ${r.status} al leer la URL`;
    const text = await r.text();
    const clean = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return clean.slice(0, 15_000);
  } catch (e) {
    return `Error al conectar con la URL: ${e.message}`;
  }
}

// --- Rutas del Servidor ---
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));

// Endpoint de verificación requerido por Coolify (Healthcheck)
app.get("/", (req, res) => {
  res.send("Servidor OK");
});

// Endpoint de Login para validar la contraseña de la app
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password === APP_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Contraseña incorrecta" });
});

// Middleware de autenticación con cookies sencillas
function auth(req, res, next) {
  const cookies = req.headers.cookie || "";
  if (cookies.includes(`${COOKIE_NAME}=true`)) {
    return next();
  }
  res.status(401).json({ error: "No autorizado" });
}

// Iniciar servidor Express
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});



