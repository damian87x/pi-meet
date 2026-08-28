#!/usr/bin/env node
/**
 * Local GTM meeting room: browser mic → Whisper → Pi router → Kokoro TTS.
 * Bind: 0.0.0.0:8790 (LAN). STT/TTS stay on localhost.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttps } from "node:https";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.PI_MEET_HOST || "0.0.0.0";
const PORT = Number(process.env.PI_MEET_PORT || 8790);
const TLS_PORT = Number(process.env.PI_MEET_TLS_PORT || 8791);
const STT = process.env.PI_STT_URL || "http://127.0.0.1:10301/v1/audio/transcriptions";
const TTS = process.env.PI_TTS_URL || "http://127.0.0.1:8181/tts";
const HTML = join(ROOT, "index.html");

const COMPANIES = {
  solvie: "Solvie",
  miyahaihr: "Miyahaihr",
  autonoxis: "Autonoxis",
};
const PEOPLE = {
  chair: { name: "Chair", role: "routes the room", voice: "am_michael" },
  gtm: { name: "GTM", role: "marketing / positioning", voice: "af_bella" },
  sales: { name: "Sales", role: "pipeline, pricing, close", voice: "am_echo" },
  cs: { name: "CS", role: "customers, support", voice: "af_nicole" },
  ops: { name: "Ops", role: "process, delivery", voice: "am_onyx" },
};

function promptFor(id, company) {
  const label = COMPANIES[company] || company;
  if (id === "chair") {
    return `You are Chair of the ${label} GTM meeting. Engineering is not here.
Seats: gtm (marketing), sales, cs, ops. Operator is speaking.
Pick who answers. You may say one short routing line. Answer yourself only if it is purely process.
JSON only: {"route":"sales","text":"Sales, take it."}
route must be chair|gtm|sales|cs|ops.`;
  }
  const job = PEOPLE[id]?.role || id;
  return `You are ${PEOPLE[id].name} (${job}) in the ${label} GTM meeting.
Speak as yourself only. 1-3 spoken sentences. Plain text, no JSON, no markdown.`;
}

function send(res, status, body, type = "application/json") {
  if (res.headersSent) return;
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function ffmpegToWav(buf, ext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-meet-"));
  const inn = join(dir, `in${ext}`);
  const out = join(dir, "out.wav");
  writeFileSync(inn, buf);
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", inn, "-ac", "1", "-ar", "16000", out],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !existsSync(out)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(r.stderr?.slice(-400) || "ffmpeg failed");
  }
  const wav = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  return wav;
}

async function transcribe(wav) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("model", "tiny");
  const r = await fetch(STT, { method: "POST", body: form });
  if (!r.ok) throw new Error(`stt ${r.status}`);
  const j = await r.json();
  return String(j.text || "").trim();
}

const history = new Map();

function withHistory(company, userText) {
  const prev = history.get(company) || [];
  const ctx = prev.slice(-6).join("\n");
  return ctx ? `Recent:\n${ctx}\n\nOperator: ${userText}` : `Operator: ${userText}`;
}

function remember(company, userText, replies) {
  const prev = history.get(company) || [];
  prev.push(`Operator: ${userText}`);
  for (const r of replies) prev.push(`${r.id}: ${r.text}`);
  history.set(company, prev.slice(-16));
}

function runPi(id, company, userText) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "-nt",
      "--no-session",
      "--no-extensions",
      "--no-context-files",
      "--system-prompt",
      promptFor(id, company),
      withHistory(company, userText),
    ];
    const child = spawn("pi", args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${id} timed out`));
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(err.slice(-400) || `${id} exit ${code}`));
      resolve(out.trim());
    });
  });
}

function parseChair(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(cleaned.slice(start, end + 1));
      const route = PEOPLE[j.route] ? j.route : "chair";
      const text = String(j.text || "").trim();
      return { route, text };
    } catch {
      /* fall through */
    }
  }
  return { route: "chair", text: cleaned || "" };
}

async function runRoom(company, userText, onThink) {
  await onThink?.("chair");
  const chairRaw = await runPi("chair", company, userText);
  const chair = parseChair(chairRaw);
  const replies = [];
  if (chair.text) replies.push({ id: "chair", name: "Chair", text: chair.text });
  if (chair.route !== "chair") {
    await onThink?.(chair.route);
    const text = (await runPi(chair.route, company, userText)).replace(/^```\w*\s*|\s*```$/g, "").trim();
    replies.push({ id: chair.route, name: PEOPLE[chair.route].name, text: text || "(no reply)" });
  }
  if (!replies.length) replies.push({ id: "chair", name: "Chair", text: chairRaw || "(no reply)" });
  return replies;
}

async function speak(id, text) {
  const voice = PEOPLE[id]?.voice || "af_heart";
  const r = await fetch(TTS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed: 1.0 }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

const onRequest = async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, readFileSync(HTML, "utf8"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, companies: COMPANIES, people: PEOPLE });
  }
  if (req.method === "POST" && url.pathname === "/api/turn") {
    try {
      const company = url.searchParams.get("company") || "solvie";
      if (!COMPANIES[company]) return send(res, 400, { error: "unknown company" });
      const ctype = req.headers["content-type"] || "";
      let userText = "";
      if (ctype.includes("text/plain") || ctype.includes("application/json")) {
        const raw = (await readBody(req)).toString("utf8");
        userText = ctype.includes("json") ? JSON.parse(raw).text || "" : raw.trim();
      } else {
        const audio = await readBody(req);
        const ext = ctype.includes("webm") ? ".webm" : ctype.includes("ogg") ? ".ogg" : ".wav";
        const wav = ext === ".wav" ? audio : ffmpegToWav(audio, ext);
        userText = await transcribe(wav);
      }
      if (!userText) return send(res, 400, { error: "empty speech" });
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const emit = (obj) => res.write(JSON.stringify(obj) + "\n");
      const replies = await runRoom(company, userText, (id) => emit({ phase: "think", id }));
      remember(company, userText, replies);
      for (const r of replies) r.audio = await speak(r.id, r.text);
      emit({ phase: "done", company, userText, replies });
      res.end();
      return;
    } catch (e) {
      if (res.headersSent) {
        res.write(JSON.stringify({ error: String(e.message || e) }) + "\n");
        res.end();
        return;
      }
      return send(res, 500, { error: String(e.message || e) });
    }
  }
  send(res, 404, { error: "not found" });
};

createServer(onRequest).listen(PORT, HOST, () => {
  console.log(`pi-meet http://192.168.68.55:${PORT}`);
});
const cert = join(ROOT, "cert.pem");
const key = join(ROOT, "key.pem");
if (existsSync(cert) && existsSync(key)) {
  createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, onRequest).listen(TLS_PORT, HOST, () => {
    console.log(`pi-meet https://192.168.68.55:${TLS_PORT}  (accept the cert warning — mic needs HTTPS)`);
  });
}
