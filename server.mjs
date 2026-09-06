import http from "node:http";
import crypto from "node:crypto";
import { URL, URLSearchParams } from "node:url";

const port = Number(process.env.PORT || 8787);
const maxBodyBytes = 32 * 1024;
const maxPromptChars = 6000;
const timestampWindowSeconds = 300;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Shopify app proxy signing: remove signature, group duplicate keys with commas,
// sort key/value pairs, concatenate without separators, then HMAC-SHA256.
function verifyAppProxy(url) {
  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!secret) return { ok: false, status: 503, error: "SHOPIFY_APP_SECRET no configurado" };

  const params = new URLSearchParams(url.search);
  const signature = params.get("signature");
  const timestamp = params.get("timestamp");
  const shop = params.get("shop");
  if (!signature || !timestamp || !shop) {
    return { ok: false, status: 401, error: "Firma de app proxy incompleta" };
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > timestampWindowSeconds) {
    return { ok: false, status: 401, error: "Solicitud de app proxy caducada" };
  }

  const expectedShop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (expectedShop && shop !== expectedShop) {
    return { ok: false, status: 403, error: "Tienda no autorizada" };
  }

  const grouped = new Map();
  for (const [key, value] of params) {
    if (key === "signature") continue;
    const values = grouped.get(key) || [];
    values.push(value);
    grouped.set(key, values);
  }
  const message = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");
  const calculated = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return constantTimeEqual(calculated, signature)
    ? { ok: true, shop, customerId: params.get("logged_in_customer_id") || null }
    : { ok: false, status: 401, error: "Firma de app proxy inválida" };
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) throw Object.assign(new Error("Cuerpo demasiado grande"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function generateWithGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) {
    throw Object.assign(new Error("Gemini no está configurado en el backend"), { status: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error("Gemini rechazó la solicitud"), { status: 502 });
    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!text) throw Object.assign(new Error("Gemini devolvió una respuesta vacía"), { status: 502 });
    return text;
  } catch (error) {
    if (error.name === "AbortError") throw Object.assign(new Error("Tiempo de espera agotado"), { status: 504 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/api")) {
    return json(res, 200, {
      ok: true,
      service: "chambau-gemini-backend",
      message: "Backend de ChambaU activo. Usa /api/gemini para las solicitudes de IA.",
    });
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, service: "chambau-gemini-backend" });
  }
  if (req.method !== "POST" || url.pathname !== "/api/gemini") {
    return json(res, 404, { error: "Ruta no encontrada" });
  }

  const devMode = process.env.ALLOW_DEV_ENDPOINT === "true";
  const proxy = verifyAppProxy(url);
  if (!proxy.ok && !(devMode && proxy.status === 503)) {
    return json(res, proxy.status || 401, { error: proxy.error || "Solicitud no autorizada" });
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt || prompt.length > maxPromptChars) {
      return json(res, 400, { error: "Envía un prompt de texto válido de hasta 6000 caracteres" });
    }
    const answer = await generateWithGemini(prompt);
    return json(res, 200, { answer });
  } catch (error) {
    const status = Number(error.status) || 500;
    return json(res, status, { error: status >= 500 ? "No se pudo completar la solicitud" : error.message });
  }
});

server.listen(port, () => {
  console.log(`ChambaU Gemini backend escuchando en puerto ${port}`);
});

