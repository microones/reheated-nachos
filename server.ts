import { auth, db, BASE, PORT, createUserWithTempPassword, resetPassword } from "./auth";

// old address of the app, redirected to BASE
const OLD_BASE = "/demo";

const FOODS = ["natxos"];
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS timer_user_import ON timer (userId, importId) WHERE importId IS NOT NULL");

type Timer = { id: number; label: string; startedAt: number; endedAt: number | null };

const q = {
  running: db.query<Timer, [string]>(
    "SELECT id, label, startedAt, endedAt FROM timer WHERE userId = ? AND endedAt IS NULL LIMIT 1"),
  all: db.query<{ label: string; startedAt: number; endedAt: number }, [string]>(
    "SELECT label, startedAt, endedAt FROM timer WHERE userId = ? AND endedAt IS NOT NULL ORDER BY startedAt"),
  // LIMIT -1 = no limit in SQLite
  recent: db.query<Timer, [string, number]>(
    "SELECT id, label, startedAt, endedAt FROM timer WHERE userId = ? AND endedAt IS NOT NULL ORDER BY startedAt DESC LIMIT ?"),
  finished: db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM timer WHERE userId = ? AND endedAt IS NOT NULL"),
  start: db.query<Timer, [string, string, string, number]>(
    "INSERT INTO timer (userId, label, food, startedAt) VALUES (?, ?, ?, ?) RETURNING id, label, startedAt, endedAt"),
  stop: db.query<Timer, [number, string, string]>(
    "UPDATE timer SET endedAt = ?, label = ? WHERE userId = ? AND endedAt IS NULL RETURNING id, label, startedAt, endedAt"),
  edit: db.query<Timer, [string, number, number, number, string]>(
    "UPDATE timer SET label = ?, startedAt = ?, endedAt = ? WHERE id = ? AND userId = ? AND endedAt IS NOT NULL RETURNING id, label, startedAt, endedAt"),
  importOne: db.query<{ id: number }, [string, string, number, number, string]>(
    "INSERT OR IGNORE INTO timer (userId, label, startedAt, endedAt, importId) VALUES (?, ?, ?, ?, ?) RETURNING id"),
  remove: db.query<{ id: number }, [number, string]>(
    "DELETE FROM timer WHERE id = ? AND userId = ? AND endedAt IS NOT NULL RETURNING id"),
  relabel: db.query<Timer, [string, string]>(
    "UPDATE timer SET label = ? WHERE userId = ? AND endedAt IS NULL RETURNING id, label, startedAt, endedAt"),
};

const cleanLabel = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 100) : "");
const json = (data: unknown, status = 200) => Response.json(data, { status });

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { return ((await req.json()) ?? {}) as Record<string, unknown>; } catch { return {}; }
}

// ---- admin panel API: only for users with isAdmin ----
type AdminUser = { id: string; email: string; name: string; createdAt: number; isAdmin: number; mustChangePassword: number; plats: number };
const listUsers = db.query<AdminUser, []>(`
  SELECT u.id, u.email, u.name, u.createdAt, u.isAdmin, u.mustChangePassword,
         (SELECT COUNT(*) FROM timer t WHERE t.userId = u.id) AS plats
  FROM user u ORDER BY u.createdAt`);
const userExists = db.query<{ id: string }, [string]>("SELECT id FROM user WHERE id = ?");

async function adminApi(req: Request, path: string): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return json({ error: "No has iniciat sessió" }, 401);
  const me = session.user as typeof session.user & { isAdmin?: boolean; mustChangePassword?: boolean };
  if (!me.isAdmin) return json({ error: "No tens permís" }, 403);
  if (me.mustChangePassword) return json({ error: "Abans has de canviar la contrasenya" }, 403);

  if (req.method === "GET" && path === "/api/admin/users") return json(listUsers.all());
  if (req.method === "POST" && path === "/api/admin/users") {
    const { email, name } = await readBody(req);
    if (typeof email !== "string") return json({ error: "Falta el correu" }, 400);
    try {
      const { user, password } = await createUserWithTempPassword(email, typeof name === "string" ? name : "");
      return json({ email: user.email, password }, 201);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  const m = path.match(/^\/api\/admin\/users\/([\w-]+)\/(reset|delete)$/);
  if (req.method === "POST" && m) {
    const [, id, action] = m as unknown as [string, string, string];
    if (!userExists.get(id)) return json({ error: "Aquest usuari no existeix" }, 404);
    if (id === me.id) return json({ error: "No ho pots fer amb el teu propi compte" }, 400);
    if (action === "reset") return json({ password: await resetPassword(id) });
    // deletes the user; sessions, accounts and timers go with it (ON DELETE CASCADE)
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUserSessions(id);
    await ctx.internalAdapter.deleteUser(id);
    return json({ ok: true });
  }
  return json({ error: "No trobat" }, 404);
}

// change the password (needs the current one) and clear the "must change password" mark
async function passwordApi(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "No trobat" }, 404);
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return json({ error: "No has iniciat sessió" }, 401);
  const { currentPassword, newPassword } = await readBody(req);
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return json({ error: "Falten contrasenyes" }, 400);
  }
  if (newPassword === currentPassword) return json({ error: "La contrasenya nova ha de ser diferent de l'actual" }, 400);
  let headers: Headers;
  try {
    // signs out every other device; the new session cookie comes back in these headers
    ({ headers } = await auth.api.changePassword({
      body: { currentPassword, newPassword, revokeOtherSessions: true },
      headers: req.headers,
      returnHeaders: true,
    }));
  } catch (e) {
    const code = (e as { body?: { code?: string } }).body?.code;
    const msg: Record<string, string> = {
      INVALID_PASSWORD: "La contrasenya actual no és correcta.",
      PASSWORD_TOO_SHORT: "La contrasenya nova ha de tenir almenys 8 caràcters.",
      PASSWORD_TOO_LONG: "La contrasenya nova és massa llarga.",
    };
    return json({ error: (code && msg[code]) || "No s'ha pogut canviar la contrasenya" }, 400);
  }
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(session.user.id, { mustChangePassword: false });
  const res = json({ ok: true });
  for (const c of headers.getSetCookie()) res.headers.append("set-cookie", c);
  return res;
}

async function timersApi(req: Request, path: string): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return json({ error: "No has iniciat sessió" }, 401);
  const userId = session.user.id;
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    return json({ error: "Abans has de canviar la contrasenya" }, 403);
  }

  // every finished timer, for the stats (grouped in the browser, in the viewer's time zone)
  if (req.method === "GET" && path === "/api/timers/all") {
    return json(q.all.all(userId));
  }
  if (req.method === "GET" && path === "/api/timers") {
    // ?limit=N: how many of the latest finished timers to send (0 = all of them)
    const n = Number(new URL(req.url).searchParams.get("limit") ?? 10);
    const limit = Number.isSafeInteger(n) && n > 0 ? n : -1;
    return json({ running: q.running.get(userId), recent: q.recent.all(userId, limit), total: q.finished.get(userId)?.n ?? 0 });
  }
  if (req.method === "POST" && path === "/api/timers/start") {
    if (q.running.get(userId)) return json({ error: "Ja hi ha un cronòmetre en marxa" }, 409);
    const { label, food = "natxos" } = await readBody(req);
    if (typeof food !== "string" || !FOODS.includes(food)) return json({ error: "Aquest menjar no existeix" }, 400);
    return json(q.start.get(userId, cleanLabel(label), food, Date.now()), 201);
  }
  if (req.method === "POST" && path === "/api/timers/stop") {
    const { label } = await readBody(req);
    const t = q.stop.get(Date.now(), cleanLabel(label), userId);
    return t ? json(t) : json({ error: "No hi ha cap cronòmetre en marxa" }, 409);
  }
  if (req.method === "POST" && path === "/api/timers/label") {
    const { label } = await readBody(req);
    const t = q.relabel.get(cleanLabel(label), userId);
    return t ? json(t) : json({ error: "No hi ha cap cronòmetre en marxa" }, 409);
  }

  // import a "focus-backup" JSON file (version 1): each session becomes a finished timer
  // labelled with its tag's name and lasting its focusedMs
  if (req.method === "POST" && path === "/api/timers/import") {
    const backup = await readBody(req);
    if (backup.format !== "focus-backup" || backup.version !== 1 || !Array.isArray(backup.sessions)) {
      return json({ error: "Aquest fitxer no és una còpia de seguretat compatible (format focus-backup, versió 1)" }, 400);
    }
    const tags = new Map<string, string>();
    for (const t of Array.isArray(backup.tags) ? backup.tags : []) {
      if (t && typeof t.id === "string") tags.set(t.id, cleanLabel(t.name));
    }
    const int = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
    let added = 0, repeated = 0, skipped = 0;
    db.transaction(() => {
      for (const s of backup.sessions as any[]) {
        if (!s || typeof s.id !== "string" || !int(s.startedAt)) { skipped++; continue; }
        const ms = int(s.focusedMs) ? s.focusedMs : int(s.endedAt) && s.endedAt > s.startedAt ? s.endedAt - s.startedAt : 0;
        if (!ms) { skipped++; continue; }
        const label = (typeof s.tagId === "string" && tags.get(s.tagId)) || "";
        if (q.importOne.get(userId, label, s.startedAt, s.startedAt + ms, s.id.slice(0, 100))) added++;
        else repeated++;
      }
    })();
    return json({ added, repeated, skipped });
  }

  // edit or delete a finished timer: /api/timers/<id>/edit, /api/timers/<id>/delete
  const m = path.match(/^\/api\/timers\/(\d+)\/(edit|delete)$/);
  if (req.method === "POST" && m) {
    const id = Number(m[1]);
    if (m[2] === "delete") {
      return q.remove.get(id, userId) ? json({ ok: true }) : json({ error: "No s'ha trobat el cronòmetre" }, 404);
    }
    const { label, startedAt, endedAt } = await readBody(req);
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
    if (!ok(startedAt) || !ok(endedAt)) return json({ error: "La data o el temps no són vàlids" }, 400);
    if (endedAt < startedAt) return json({ error: "El temps no pot ser negatiu" }, 400);
    const t = q.edit.get(cleanLabel(label), startedAt, endedAt, id, userId);
    return t ? json(t) : json({ error: "No s'ha trobat el cronòmetre" }, 404);
  }
  return json({ error: "No trobat" }, 404);
}

// nginx appends the visitor's real IP at the end of X-Forwarded-For; anything before it
// was sent by the client and can be faked. Better Auth (rate limiting) only trusts a
// single value, so keep just the last one. Only nginx can reach this server (127.0.0.1).
function withClientIp(req: Request): Request {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff || !xff.includes(",")) return req;
  const headers = new Headers(req.headers);
  headers.set("x-forwarded-for", xff.split(",").pop()!.trim());
  return new Request(req, { headers });
}

const page = Bun.file(new URL("./public/index.html", import.meta.url));

Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(req) {
    const full = new URL(req.url).pathname;
    if (full === OLD_BASE || full.startsWith(`${OLD_BASE}/`)) return Response.redirect(`${BASE}/`, 301);
    if (full === BASE) return Response.redirect(`${BASE}/`, 301);
    if (!full.startsWith(`${BASE}/`)) return new Response("No trobat", { status: 404 });
    const path = full.slice(BASE.length);
    if (path.startsWith("/api/auth/")) return auth.handler(withClientIp(req));
    if (path.startsWith("/api/admin/")) return adminApi(req, path);
    if (path.startsWith("/api/timers")) return timersApi(req, path);
    if (path === "/api/account/password") return passwordApi(req);
    if (path === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    // images next to the page (only plain file names, no subfolders)
    if (/^\/[\w-]+\.(webp|png)$/.test(path)) {
      const img = Bun.file(new URL(`./public${path}`, import.meta.url));
      if (await img.exists()) return new Response(img, { headers: { "cache-control": "public, max-age=86400" } });
    }
    return new Response("No trobat", { status: 404 });
  },
});

console.log(`reheated nachos a http://localhost:${PORT}${BASE}/`);
