import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

// shared by the web server (server.ts) and the command-line scripts (crea-usuari.ts)
export const PORT = Number(process.env.PORT ?? 3002);
// the app lives under this prefix (nginx proxies /app/ here unchanged)
export const BASE = (process.env.BASE_PATH ?? "/app").replace(/\/$/, "");
export const db = new Database(process.env.DB_PATH ?? new URL("./reheated-nachos.db", import.meta.url).pathname, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

export const auth = betterAuth({
  database: db,
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${PORT}`,
  basePath: `${BASE}/api/auth`,
  // new accounts are closed for now; users are created with crea-usuari.ts
  emailAndPassword: { enabled: true, disableSignUp: true },
  // limit requests per IP (Better Auth only does it by default when NODE_ENV=production);
  // sign-in gets a stricter built-in limit. nginx passes the visitor's IP in X-Forwarded-For.
  rateLimit: { enabled: true },
  user: {
    additionalFields: {
      // set by crea-usuari.ts: the user must pick a new password after the first sign-in
      mustChangePassword: { type: "boolean", defaultValue: false, input: false },
      // can open the admin panel (create users, reset passwords, delete users)
      isAdmin: { type: "boolean", defaultValue: false, input: false },
    },
  },
});

// Better Auth's own tables (user, session, account, verification)
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();

db.exec(`
  CREATE TABLE IF NOT EXISTS timer (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    label     TEXT    NOT NULL DEFAULT '',
    startedAt INTEGER NOT NULL,
    endedAt   INTEGER
  );
  CREATE INDEX IF NOT EXISTS timer_user_started ON timer (userId, startedAt DESC);
`);
// importId = id of the session in an imported backup, so importing the same file twice adds nothing
if (!db.query<{ name: string }, []>("PRAGMA table_info(timer)").all().some((c) => c.name === "importId")) {
  db.exec("ALTER TABLE timer ADD COLUMN importId TEXT");
}
// food = what was being reheated; only nachos for now, more kinds will come
if (!db.query<{ name: string }, []>("PRAGMA table_info(timer)").all().some((c) => c.name === "food")) {
  db.exec("ALTER TABLE timer ADD COLUMN food TEXT NOT NULL DEFAULT 'natxos'");
}

// ---- user management, shared by crea-usuari.ts and the admin panel ----

// 16 characters without look-alikes (0/O, 1/l/I), in groups of 4 so it's easy to read out
export function randomPassword(): string {
  const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join("").replace(/(.{4})(?=.)/g, "$1-");
}

export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;

// creates a user with a random password they must change after their first sign-in
export async function createUserWithTempPassword(email: string, name = "", isAdmin = false) {
  email = email.trim().toLowerCase();
  if (!validEmail(email)) throw new Error("El correu no és vàlid.");
  const ctx = await auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(email)) throw new Error(`Ja hi ha un compte amb el correu ${email}.`);
  const password = randomPassword();
  const user = await ctx.internalAdapter.createUser({
    email,
    name: name.trim().slice(0, 100) || email.split("@")[0] || email,
    emailVerified: false,
    mustChangePassword: true,
    isAdmin,
  }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(password),
  });
  return { user, password };
}

// gives the user a new random password, signs them out everywhere and makes them change it
export async function resetPassword(userId: string) {
  const ctx = await auth.$context;
  const password = randomPassword();
  await ctx.internalAdapter.updatePassword(userId, await ctx.password.hash(password));
  await ctx.internalAdapter.updateUser(userId, { mustChangePassword: true });
  await ctx.internalAdapter.deleteUserSessions(userId);
  return password;
}
