/**
 * /meet — join rooms on the local pi-meet hub from any Pi session.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HUB = process.env.PI_MEET_URL || "http://127.0.0.1:8790";
const STATE = join(homedir(), ".pi", "meet", "client.json");

type State = { roomId?: string; memberId?: string; name?: string; role?: string; since?: number };

function load(): State {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}
async function save(s: State) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(homedir(), ".pi", "meet"), { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2));
}

async function api(path: string, init?: RequestInit) {
  const r = await fetch(HUB + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;

  async function drain() {
    const s = load();
    if (!s.roomId || !s.memberId) return;
    try {
      const j = await api(`/api/rooms/${s.roomId}/events?since=${s.since || 0}`);
      const events = j.events || [];
      if (events.length) {
        s.since = events[events.length - 1].seq;
        await save(s);
        const lines: string[] = [];
        for (const e of events) {
          if (e.type === "message" && e.memberId !== s.memberId) {
            let line = `[meet ${j.room?.id}] ${e.name}${e.role ? ` (${e.role})` : ""}: ${e.text || ""}`;
            if (e.files?.length) {
              line += "\nFiles:\n" + e.files.map((f: { name: string; path?: string; text?: string }) =>
                `- ${f.name}${f.path ? ` @ ${f.path}` : ""}${f.text ? `\n${f.text.slice(0, 2000)}` : ""}`).join("\n");
            }
            lines.push(line);
          }
          if (e.type === "join" && e.memberId !== s.memberId) {
            lines.push(`[meet] ${e.name} joined as ${e.role || "undecided role"}`);
          }
        }
        if (lines.length) {
          const prompt = lines.join("\n") + (s.role
            ? `\nYou are in this room as ${s.name} (${s.role}). Reply with the meet_say tool if you should speak. Use meet_role if you want to change role. Use meet_share to attach a file.`
            : `\nYou joined without a role. Call meet_role with who you are in this room (e.g. sales, reviewer, chair), then meet_say if you should talk.`);
          try {
            pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          } catch {
            pi.sendUserMessage(prompt);
          }
        }
      }
    } catch {
      /* hub down */
    }
  }

  function startPoll() {
    if (timer) return;
    timer = setInterval(() => void drain(), 1000);
  }

  pi.on("session_start", async () => {
    startPoll();
    const s = load();
    if (s.roomId) void drain();
  });

  pi.registerCommand("meet", {
    description: "Room hub: /meet create|rooms|join|role|leave|say",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const extra = rest.join(" ");
      try {
        if (!cmd || cmd === "rooms") {
          const j = await api("/api/rooms");
          const list = (j.rooms || []).map((r: { id: string; name: string; members: unknown[] }) =>
            `${r.id}  ${r.name}  (${r.members.length} in)`).join("\n") || "(no rooms)";
          ctx.ui.notify(list, "info");
          return;
        }
        if (cmd === "create") {
          const name = extra || "room";
          const r = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name }) });
          ctx.ui.notify(`created ${r.id} — /meet join ${r.id}`, "info");
          return;
        }
        if (cmd === "join") {
          const parts = extra.split(/\s+/);
          const roomId = parts[0];
          const role = parts.slice(1).join(" ");
          if (!roomId) {
            ctx.ui.notify("Usage: /meet join <room> [role]", "warning");
            return;
          }
          const name = process.env.PI_MEET_NAME || process.env.USER || "pi";
          const j = await api(`/api/rooms/${roomId}/join`, {
            method: "POST",
            body: JSON.stringify({ kind: "pi", name, role }),
          });
          const s: State = { roomId, memberId: j.member.id, name, role: j.member.role, since: j.room.seq };
          await save(s);
          startPoll();
          ctx.ui.notify(`joined ${roomId} as ${name}${role ? ` (${role})` : " — pick a role with /meet role"}`, "info");
          if (!role) {
            pi.sendUserMessage(`[meet ${roomId}] You just joined. Call meet_role to decide your role in this room, then wait for people to speak.`);
          }
          return;
        }
        if (cmd === "role") {
          const s = load();
          if (!s.roomId || !s.memberId) {
            ctx.ui.notify("Join a room first", "warning");
            return;
          }
          if (!extra) {
            ctx.ui.notify("Usage: /meet role <role>", "warning");
            return;
          }
          await api(`/api/rooms/${s.roomId}/role`, {
            method: "POST",
            body: JSON.stringify({ memberId: s.memberId, role: extra }),
          });
          s.role = extra;
          await save(s);
          ctx.ui.notify(`role: ${extra}`, "info");
          return;
        }
        if (cmd === "leave") {
          const s = load();
          if (s.roomId && s.memberId) {
            await api(`/api/rooms/${s.roomId}/leave`, {
              method: "POST",
              body: JSON.stringify({ memberId: s.memberId }),
            });
          }
          await save({});
          ctx.ui.notify("left", "info");
          return;
        }
        if (cmd === "say") {
          const s = load();
          if (!s.roomId || !s.memberId) {
            ctx.ui.notify("Join first", "warning");
            return;
          }
          if (!extra) return;
          await api(`/api/rooms/${s.roomId}/messages`, {
            method: "POST",
            body: JSON.stringify({ memberId: s.memberId, text: extra }),
          });
          ctx.ui.notify("said", "info");
          return;
        }
        ctx.ui.notify("Usage: /meet create|rooms|join|role|leave|say", "warning");
      } catch (e) {
        ctx.ui.notify(String((e as Error).message || e), "error");
      }
    },
  });

  pi.registerTool({
    name: "meet_say",
    label: "Meet say",
    description: "Speak in the joined pi-meet room. Use when you should talk in the meeting.",
    parameters: Type.Object({ text: Type.String({ description: "What to say (1-4 sentences)" }) }),
    async execute(_id, params) {
      const s = load();
      if (!s.roomId || !s.memberId) return { content: [{ type: "text", text: "Not in a room. /meet join first." }], details: {} };
      await api(`/api/rooms/${s.roomId}/messages`, {
        method: "POST",
        body: JSON.stringify({ memberId: s.memberId, text: params.text }),
      });
      return { content: [{ type: "text", text: `said: ${params.text}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "meet_role",
    label: "Meet role",
    description: "Choose or change your role in the joined room (sales, chair, reviewer, etc.).",
    parameters: Type.Object({ role: Type.String({ description: "Role name" }) }),
    async execute(_id, params) {
      const s = load();
      if (!s.roomId || !s.memberId) return { content: [{ type: "text", text: "Not in a room." }], details: {} };
      await api(`/api/rooms/${s.roomId}/role`, {
        method: "POST",
        body: JSON.stringify({ memberId: s.memberId, role: params.role }),
      });
      s.role = params.role;
      await save(s);
      return { content: [{ type: "text", text: `role is now ${params.role}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "meet_share",
    label: "Meet share",
    description: "Share a local file into the joined meet room.",
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      caption: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const s = load();
      if (!s.roomId || !s.memberId) return { content: [{ type: "text", text: "Not in a room." }], details: {} };
      let text = "";
      try {
        text = readFileSync(params.path, "utf8").slice(0, 20000);
      } catch (e) {
        return { content: [{ type: "text", text: `cannot read ${params.path}: ${e}` }], details: {} };
      }
      await api(`/api/rooms/${s.roomId}/files`, {
        method: "POST",
        body: JSON.stringify({
          memberId: s.memberId,
          name: basename(params.path),
          text,
          caption: params.caption || `shared ${basename(params.path)}`,
        }),
      });
      return { content: [{ type: "text", text: `shared ${params.path}` }], details: {} };
    },
  });
}
