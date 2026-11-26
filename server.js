import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const root = import.meta.dirname;
const dataDirectory = resolve(process.env.GATHER_DATA_DIR || join(root, "data"));
const uploadDirectory = resolve(process.env.GATHER_UPLOAD_DIR || join(root, "uploads"));
const databasePath = resolve(dataDirectory, "gather.sqlite");
const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseUrlConfigured = Object.hasOwn(process.env, "DATABASE_URL");
const usePostgres = Boolean(databaseUrl);
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseBucket = process.env.SUPABASE_STORAGE_BUCKET || "gather-media";
const useSupabaseStorage = Boolean(supabaseUrl && supabaseServiceRoleKey);
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";
const sessionCookie = "gather_session";
const sessionLifetimeSeconds = 60 * 60 * 24 * 14;
const maxImageBytes = 10 * 1024 * 1024;
const maxJsonBytes = 1024 * 1024;
const pageSize = 20;

if (process.env.NODE_ENV === "production" && databaseUrlConfigured && !databaseUrl) {
  throw new Error("DATABASE_URL is set but empty; refusing to fall back to SQLite in production.");
}

function postgresSql(sql) {
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  let converted = sql
    .replace(/(\b[\w.]+)\s*=\s*\?\s*COLLATE\s+NOCASE/gi, "LOWER($1) = LOWER(?)")
    .replace(/\s+COLLATE\s+NOCASE/gi, "")
    .replace(/\bLIKE\b/gi, "ILIKE")
    .replace(/\bAS\s+([a-z_][a-z0-9_]*)/gi, (match, alias) =>
      /[A-Z]/.test(alias) ? `AS "${alias}"` : match)
    .replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO")
    .trim()
    .replace(/;$/, "");
  converted = converted.replace(/\?/g, (_, offset) => `$${(converted.slice(0, offset).match(/\?/g) || []).length + 1}`);
  if (ignore) converted += " ON CONFLICT DO NOTHING";
  return converted;
}

function createPostgresDatabase(client) {
  const execute = (sql, parameters = []) => client.query(postgresSql(sql), parameters);
  return {
    async exec(sql) {
      await execute(sql);
    },
    prepare(sql) {
      return {
        async get(...parameters) {
          const result = await execute(sql, parameters);
          return result.rows[0];
        },
        async all(...parameters) {
          const result = await execute(sql, parameters);
          return result.rows;
        },
        async run(...parameters) {
          const result = await execute(sql, parameters);
          return { changes: result.rowCount };
        }
      };
    },
    async transaction(operation) {
      const connection = await client.connect();
      const transaction = createPostgresDatabase(connection);
      try {
        await connection.query("BEGIN");
        const result = await operation(transaction);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() {
      await client.end();
    }
  };
}

function createSqliteDatabase(connection) {
  return {
    async exec(sql) {
      connection.exec(sql);
    },
    prepare(sql) {
      const statement = connection.prepare(sql);
      return {
        async get(...parameters) {
          return statement.get(...parameters);
        },
        async all(...parameters) {
          return statement.all(...parameters);
        },
        async run(...parameters) {
          return statement.run(...parameters);
        }
      };
    },
    async transaction(operation) {
      connection.exec("BEGIN IMMEDIATE");
      try {
        const result = await operation(this);
        connection.exec("COMMIT");
        return result;
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    },
    async close() {
      connection.close();
    }
  };
}

if (Boolean(supabaseUrl) !== Boolean(supabaseServiceRoleKey)) {
  throw new Error("Configure both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable Supabase Storage.");
}
if (process.env.NODE_ENV === "production" && usePostgres && !useSupabaseStorage) {
  throw new Error("Production DATABASE_URL requires Supabase Storage credentials for durable media storage.");
}

let sqliteDatabase;
let postgresPool;
let database;
if (usePostgres) {
  postgresPool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: true } });
  database = createPostgresDatabase(postgresPool);
  await postgresPool.query("SELECT 1");
} else {
  await mkdir(dataDirectory, { recursive: true });
  sqliteDatabase = new DatabaseSync(databasePath);
  sqliteDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database = createSqliteDatabase(sqliteDatabase);
}
if (!useSupabaseStorage) await mkdir(uploadDirectory, { recursive: true });

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_private INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_suspended INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL UNIQUE REFERENCES media(id) ON DELETE RESTRICT,
    caption TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS likes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_post_idx ON comments(post_id, created_at);
  CREATE TABLE IF NOT EXISTS saved_posts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS follow_requests (
    follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
  );
  CREATE INDEX IF NOT EXISTS follow_requests_inbox_idx ON follow_requests(followee_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
    caption TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    is_hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS stories_expiry_idx ON stories(expires_at);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('post', 'user', 'story')),
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'actioned')),
    created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id),
    reviewed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at DESC);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (user_low, user_high),
    CHECK (user_low < user_high)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at DESC);
`;

if (usePostgres) {
  const postgresSchema = schema
    .replace("username TEXT NOT NULL UNIQUE COLLATE NOCASE", "username TEXT NOT NULL")
    .replace("email TEXT UNIQUE COLLATE NOCASE", "email TEXT")
    .replaceAll("expires_at INTEGER NOT NULL", "expires_at BIGINT NOT NULL")
    .replaceAll(" COLLATE NOCASE", "");
  await database.exec(postgresSchema);
  await database.exec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0
  `);
  await database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx ON users (LOWER(username))");
  await database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email)) WHERE email IS NOT NULL");
} else {
  sqliteDatabase.exec(schema);
}

async function addColumnIfMissing(table, column, declaration) {
  if (usePostgres) {
    await database.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`);
  } else {
    const columns = await database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(existing => existing.name === column)) {
      await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }
}

await addColumnIfMissing("users", "email", "TEXT");
await addColumnIfMissing("users", "is_private", "INTEGER NOT NULL DEFAULT 0");
await addColumnIfMissing("users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
await addColumnIfMissing("users", "is_suspended", "INTEGER NOT NULL DEFAULT 0");
await addColumnIfMissing("posts", "is_hidden", "INTEGER NOT NULL DEFAULT 0");
await database.exec(usePostgres
  ? "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email)) WHERE email IS NOT NULL"
  : "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users(email COLLATE NOCASE) WHERE email IS NOT NULL");
if (process.env.ADMIN_USERNAME) {
  await database.prepare("UPDATE users SET is_admin = 1 WHERE username = ? COLLATE NOCASE").run(process.env.ADMIN_USERNAME.trim());
}

const prepared = {
  userById: database.prepare("SELECT id, username, email, display_name AS displayName, created_at AS createdAt, is_private AS isPrivate, is_admin AS isAdmin FROM users WHERE id = ?"),
  userByUsername: database.prepare("SELECT id, username, email, display_name AS displayName, password_hash AS passwordHash, is_private AS isPrivate, is_admin AS isAdmin FROM users WHERE username = ? COLLATE NOCASE"),
  userByEmail: database.prepare("SELECT id, username, email FROM users WHERE email = ? COLLATE NOCASE"),
  insertUser: database.prepare("INSERT INTO users (id, username, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  updatePassword: database.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  deleteUserResetTokens: database.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?"),
  insertResetToken: database.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  resetTokenUser: database.prepare("SELECT users.id, password_reset_tokens.expires_at AS expiresAt FROM password_reset_tokens JOIN users ON users.id = password_reset_tokens.user_id WHERE password_reset_tokens.token_hash = ?"),
  deleteResetToken: database.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?"),
  setProfilePrivacy: database.prepare("UPDATE users SET is_private = ?, email = ? WHERE id = ?"),
  insertSession: database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  sessionUser: database.prepare(`
    SELECT users.id, users.username, users.email, users.display_name AS displayName, users.created_at AS createdAt,
           users.is_private AS isPrivate, users.is_admin AS isAdmin, users.is_suspended AS isSuspended,
           sessions.token_hash AS tokenHash
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `),
  deleteSession: database.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: database.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  mediaById: database.prepare("SELECT id, owner_id AS ownerId, mime_type AS mimeType FROM media WHERE id = ?"),
  deleteMedia: database.prepare("DELETE FROM media WHERE id = ? AND owner_id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.media_id = media.id)"),
  mediaForPost: database.prepare("SELECT media.id, media.owner_id AS ownerId, media.mime_type AS mimeType FROM media JOIN posts ON posts.media_id = media.id WHERE posts.id = ?"),
  insertMedia: database.prepare("INSERT INTO media (id, owner_id, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?)"),
  insertPost: database.prepare("INSERT INTO posts (id, author_id, media_id, caption, created_at) VALUES (?, ?, ?, ?, ?)"),
  postOwnedBy: database.prepare("SELECT id FROM posts WHERE id = ? AND author_id = ?"),
  deletePost: database.prepare("DELETE FROM posts WHERE id = ? AND author_id = ?"),
  insertLike: database.prepare("INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)"),
  deleteLike: database.prepare("DELETE FROM likes WHERE user_id = ? AND post_id = ?"),
  insertSave: database.prepare("INSERT OR IGNORE INTO saved_posts (user_id, post_id, created_at) VALUES (?, ?, ?)"),
  deleteSave: database.prepare("DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?"),
  insertFollow: database.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)"),
  deleteFollow: database.prepare("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?"),
  userExists: database.prepare("SELECT id FROM users WHERE id = ?"),
  insertComment: database.prepare("INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)"),
  createPost: database.prepare(`
    SELECT posts.id, posts.author_id AS authorId, users.username, users.display_name AS displayName,
           media.id AS mediaId, posts.caption, posts.created_at AS createdAt
    FROM posts JOIN users ON users.id = posts.author_id
    JOIN media ON media.id = posts.media_id WHERE posts.id = ?
  `)
};

const authAttempts = new Map();
const mimeByExtension = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
const publicFiles = new Set(["/index.html", "/app.css", "/app.js"]);
const mimeBySignature = [
  { mime: "image/jpeg", extension: ".jpg", test: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: "image/png", extension: ".png", test: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", extension: ".webp", test: bytes => bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" }
];

function storageObjectUrl(mediaId, extension) {
  const objectName = `${mediaId}${extension}`;
  return {
    objectName,
    url: `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucket)}/${encodeURIComponent(objectName)}`
  };
}

async function storeMedia(mediaId, extension, bytes, mimeType) {
  if (!useSupabaseStorage) {
    await writeFile(join(uploadDirectory, `${mediaId}${extension}`), bytes, { flag: "wx" });
    return;
  }
  const { url } = storageObjectUrl(mediaId, extension);
  const result = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      apikey: supabaseServiceRoleKey,
      "Content-Type": mimeType,
      "x-upsert": "false"
    },
    body: bytes
  });
  if (!result.ok) throw new HttpError(502, "Photo storage is temporarily unavailable. Please try again.");
}

async function readStoredMedia(mediaId, extension) {
  if (!useSupabaseStorage) return readFile(join(uploadDirectory, `${mediaId}${extension}`));
  const { url } = storageObjectUrl(mediaId, extension);
  const result = await fetch(url, {
    headers: {
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      apikey: supabaseServiceRoleKey
    }
  });
  if (!result.ok) throw new HttpError(result.status === 404 ? 404 : 502, "Photo file could not be retrieved.");
  return Buffer.from(await result.arrayBuffer());
}

async function deleteStoredMedia(mediaId, extension) {
  if (!useSupabaseStorage) {
    try {
      await unlink(join(uploadDirectory, `${mediaId}${extension}`));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }
  const { url } = storageObjectUrl(mediaId, extension);
  const result = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      apikey: supabaseServiceRoleKey
    }
  });
  if (!result.ok && result.status !== 404) throw new Error("Supabase Storage could not delete the photo object.");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function requireMethod(request, method) {
  if (request.method !== method) throw new HttpError(405, "Method not allowed.");
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "Request origin was rejected.");
  }
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const requestProtocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
  if (parsedOrigin.host !== request.headers.host || parsedOrigin.protocol !== `${requestProtocol}:`) {
    throw new HttpError(403, "Cross-origin requests are not allowed.");
  }
}

function checkRateLimit(request, key, maximum = 10) {
  const client = request.socket.remoteAddress || "unknown";
  const mapKey = `${key}:${client}`;
  const now = Date.now();
  const current = authAttempts.get(mapKey);
  if (!current || now - current.startedAt > 15 * 60 * 1000) {
    authAttempts.set(mapKey, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > maximum) throw new HttpError(429, "Too many attempts. Please wait a little before trying again.");
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send this request as JSON.");
  }
  const body = await readBody(request, maxJsonBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function validString(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function validEmail(value) {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isAdmin(user) {
  if (!user.isAdmin) throw new HttpError(403, "Administrator access is required.");
}

async function canMessage(userId, otherUserId) {
  return Boolean(await database.prepare(`
    SELECT 1 FROM follows
    WHERE (follower_id = ? AND followee_id = ?)
       OR (follower_id = ? AND followee_id = ?)
  `).get(userId, otherUserId, otherUserId, userId));
}

async function canSeePost(userId, postId) {
  return Boolean(await database.prepare(`
    SELECT 1 FROM posts
    JOIN users ON users.id = posts.author_id
    WHERE posts.id = ?
      AND users.is_suspended = 0
      AND (posts.is_hidden = 0 OR posts.author_id = ?)
      AND (posts.author_id = ? OR users.is_private = 0
        OR EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = posts.author_id))
  `).get(postId, userId, userId, userId));
}

async function cleanupExpiredStories() {
  const expired = await database.prepare(`
    SELECT stories.media_id AS mediaId, media.mime_type AS mimeType
    FROM stories JOIN media ON media.id = stories.media_id
    WHERE stories.expires_at <= ?
  `).all(new Date().toISOString());
  if (!expired.length) return;
  await database.prepare("DELETE FROM stories WHERE expires_at <= ?").run(new Date().toISOString());
  const removeMedia = database.prepare(`
    DELETE FROM media WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.media_id = media.id)
  `);
  for (const story of expired) {
    const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[story.mimeType];
    if (!Number((await removeMedia.run(story.mediaId)).changes) || !extension) continue;
    await deleteStoredMedia(story.mediaId, extension);
  }
}

function orderedParticipants(firstId, secondId) {
  return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
}

async function findOrCreateConversation(firstId, secondId) {
  const [userLow, userHigh] = orderedParticipants(firstId, secondId);
  const id = randomUUID();
  await database.prepare("INSERT OR IGNORE INTO conversations (id, user_low, user_high, created_at) VALUES (?, ?, ?, ?)").run(
    id, userLow, userHigh, new Date().toISOString()
  );
  return database.prepare(`
    SELECT id, user_low AS userLow, user_high AS userHigh
    FROM conversations WHERE user_low = ? AND user_high = ?
  `).get(userLow, userHigh);
}

async function persistMessage(conversation, user, body) {
  const message = {
    id: randomUUID(),
    conversationId: conversation.id,
    senderId: user.id,
    senderUsername: user.username,
    body,
    createdAt: new Date().toISOString()
  };
  await database.prepare("INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    message.id, conversation.id, user.id, body, message.createdAt
  );
  broadcastToUser(conversation.userLow, { type: "message.created", message });
  broadcastToUser(conversation.userHigh, { type: "message.created", message });
  return message;
}

function sendResetEmail(request, email, token) {
  const origin = process.env.APP_BASE_URL || `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
  const resetUrl = new URL("/", origin);
  resetUrl.searchParams.set("reset", token);
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    return fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [email],
        subject: "Reset your Gather password",
        text: `Use this link within 30 minutes to reset your Gather password:\n\n${resetUrl.toString()}\n\nIf you didn't request this, you can ignore this email.`
      })
    }).then(response => {
      if (!response.ok) throw new HttpError(502, "Password reset email could not be sent. Please try again later.");
    });
  }
  if (process.env.NODE_ENV === "production") {
    throw new HttpError(503, "Password recovery email is not configured yet.");
  }
  console.info(`Password reset link for ${email}: ${resetUrl.toString()}`);
  return Promise.resolve();
}

async function getUser(request, required = true) {
  const token = parseCookies(request.headers.cookie).get(sessionCookie);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    if (required) throw new HttpError(401, "Please sign in to continue.");
    return null;
  }
  const session = await prepared.sessionUser.get(hashToken(token), Date.now());
  if (!session) {
    await prepared.deleteSession.run(hashToken(token));
    if (required) throw new HttpError(401, "Your session expired. Please sign in again.");
    return null;
  }
  if (session.isSuspended) throw new HttpError(403, "This account is currently suspended.");
  return {
    id: session.id,
    username: session.username,
    displayName: session.displayName,
    email: session.email,
    isPrivate: Boolean(session.isPrivate),
    isAdmin: Boolean(session.isAdmin),
    createdAt: session.createdAt
  };
}

async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + sessionLifetimeSeconds * 1000;
  await prepared.insertSession.run(hashToken(token), userId, expiresAt);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    token,
    cookie: `${sessionCookie}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionLifetimeSeconds}${secure}`
  };
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!/^[a-f0-9]{32}$/.test(saltHex || "") || !/^[a-f0-9]{128}$/.test(hashHex || "")) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), 64));
  const expected = Buffer.from(hashHex, "hex");
  return timingSafeEqual(actual, expected);
}

function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator < 0) throw new Error("Missing cursor separator");
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!Number.isFinite(Date.parse(createdAt)) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid cursor");
    return { createdAt, id };
  } catch {
    throw new HttpError(400, "That feed cursor is invalid. Refresh and try again.");
  }
}

function serializePost(row, userId, comments) {
  const firstName = row.displayName.split(/\s+/)[0] || row.username;
  return {
    id: row.id,
    authorId: row.authorId,
    name: row.displayName,
    username: row.username,
    initial: firstName[0].toUpperCase(),
    color: row.authorId === userId ? "avatar-you" : "",
    location: "",
    image: `/media/${row.mediaId}`,
    alt: `Photo shared by ${row.username}`,
    caption: row.caption,
    time: row.createdAt,
    likes: Number(row.likes),
    liked: Boolean(row.liked),
    saved: Boolean(row.saved),
    commentCount: Number(row.commentCount),
    isPrivate: Boolean(row.isPrivate),
    comments: comments.get(row.id) || []
  };
}

async function listPosts(user, url) {
  const view = url.searchParams.get("view") || "home";
  if (!["home", "explore", "saved", "profile"].includes(view)) throw new HttpError(400, "That feed view is not supported.");
  const query = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const clauses = [];
  const parameters = [];

  if (view === "home") {
    clauses.push("(posts.author_id = ? OR EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = posts.author_id))");
    parameters.push(user.id, user.id);
  } else if (view === "profile") {
    clauses.push("posts.author_id = ?");
    parameters.push(user.id);
  } else if (view === "saved") {
    clauses.push("EXISTS (SELECT 1 FROM saved_posts WHERE saved_posts.post_id = posts.id AND saved_posts.user_id = ?)");
    parameters.push(user.id);
  }

  clauses.push("(posts.is_hidden = 0 OR posts.author_id = ?)");
  parameters.push(user.id);
  clauses.push("(users.is_suspended = 0 OR posts.author_id = ?)");
  parameters.push(user.id);
  clauses.push("(users.is_private = 0 OR posts.author_id = ? OR EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = posts.author_id))");
  parameters.push(user.id, user.id);

  if (query) {
    clauses.push("(users.username LIKE ? ESCAPE '\\' OR users.display_name LIKE ? ESCAPE '\\' OR posts.caption LIKE ? ESCAPE '\\')");
    const escaped = query.replace(/[\\%_]/g, character => `\\${character}`);
    parameters.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
  }
  if (cursor) {
    clauses.push("(posts.created_at < ? OR (posts.created_at = ? AND posts.id < ?))");
    parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await database.prepare(`
    SELECT posts.id, posts.author_id AS authorId, users.username, users.display_name AS displayName,
           posts.caption, posts.created_at AS createdAt, media.id AS mediaId,
           (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS likes,
           EXISTS (SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_id = ?) AS liked,
           EXISTS (SELECT 1 FROM saved_posts WHERE saved_posts.post_id = posts.id AND saved_posts.user_id = ?) AS saved,
           (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS commentCount,
           users.is_private AS isPrivate
    FROM posts
    JOIN users ON users.id = posts.author_id
    JOIN media ON media.id = posts.media_id
    ${where}
    ORDER BY posts.created_at DESC, posts.id DESC
    LIMIT ?
  `).all(user.id, user.id, ...parameters, pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const commentsByPost = new Map();
  if (page.length) {
    const placeholders = page.map(() => "?").join(",");
    const commentRows = await database.prepare(`
      SELECT comments.post_id AS postId, users.username, comments.body
      FROM comments JOIN users ON users.id = comments.author_id
      WHERE comments.post_id IN (${placeholders})
      ORDER BY comments.created_at DESC
    `).all(...page.map(row => row.id));
    for (const row of commentRows) {
      const comments = commentsByPost.get(row.postId) || [];
      if (comments.length < 2) comments.unshift({ name: row.username, text: row.body });
      commentsByPost.set(row.postId, comments);
    }
  }
  const last = page.at(-1);
  const nextCursor = hasMore && last
    ? Buffer.from(`${last.createdAt}|${last.id}`).toString("base64url")
    : null;
  return {
    posts: page.map(row => serializePost(row, user.id, commentsByPost)),
    nextCursor
  };
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  if (!publicFiles.has(requested)) throw new HttpError(404, "Not found.");
  const filePath = resolve(root, `.${requested}`);
  if (!filePath.startsWith(`${root}${sep}`) || extname(filePath) === "") {
    throw new HttpError(404, "Not found.");
  }
  let content;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") throw new HttpError(404, "Not found.");
    throw error;
  }
  response.writeHead(200, {
    "Content-Type": mimeByExtension[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(content);
}

function ensureSameOriginMutation(request) {
  assertSameOrigin(request);
  const contentType = request.headers["content-type"] || "";
  if (request.method !== "DELETE" && !contentType) throw new HttpError(415, "Content type is required.");
}

async function handleApi(request, response, url) {
  const path = url.pathname;
  if (path === "/api/health") {
    requireMethod(request, "GET");
    return sendJson(response, 200, { status: "ok" });
  }

  if (path === "/api/auth/register") {
    requireMethod(request, "POST");
    ensureSameOriginMutation(request);
    checkRateLimit(request, "register");
    const body = await readJson(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = body.password;
    if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new HttpError(400, "Username must be 3–24 characters: letters, numbers, or underscores.");
    if (!validString(displayName, 60)) throw new HttpError(400, "Add a display name of up to 60 characters.");
    if (!validEmail(email)) throw new HttpError(400, "Enter a valid email address for account recovery.");
    if (typeof password !== "string" || password.length < 10 || password.length > 128) {
      throw new HttpError(400, "Password must be between 10 and 128 characters.");
    }
    if (await prepared.userByUsername.get(username)) throw new HttpError(409, "That username is already taken.");
    if (await prepared.userByEmail.get(email)) throw new HttpError(409, "That email address is already associated with an account.");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    try {
      await prepared.insertUser.run(id, username, email, displayName, passwordHash, createdAt);
      if (process.env.ADMIN_USERNAME?.trim().toLowerCase() === username) {
        await database.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(id);
      }
    } catch (error) {
      if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") throw new HttpError(409, "That username or email is already in use.");
      throw error;
    }
    const session = await createSession(id);
    const user = await prepared.userById.get(id);
    return sendJson(response, 201, { user: { ...user, isPrivate: Boolean(user.isPrivate), isAdmin: Boolean(user.isAdmin) } }, { "Set-Cookie": session.cookie });
  }

  if (path === "/api/auth/login") {
    requireMethod(request, "POST");
    ensureSameOriginMutation(request);
    checkRateLimit(request, "login");
    const body = await readJson(request);
    if (!validString(body.username, 80) || typeof body.password !== "string" || body.password.length > 128) {
      throw new HttpError(400, "Enter your username and password.");
    }
    const user = await prepared.userByUsername.get(body.username.trim());
    const passwordMatches = user ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !passwordMatches) throw new HttpError(401, "Username or password is incorrect.");
    const session = await createSession(user.id);
    return sendJson(response, 200, {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        isPrivate: Boolean(user.isPrivate),
        isAdmin: Boolean(user.isAdmin)
      }
    }, { "Set-Cookie": session.cookie });
  }

  if (path === "/api/auth/forgot-password") {
    requireMethod(request, "POST");
    ensureSameOriginMutation(request);
    checkRateLimit(request, "password-reset");
    const body = await readJson(request);
    if (!validEmail(body.email)) throw new HttpError(400, "Enter the email address on your account.");
    if (process.env.NODE_ENV === "production" && !(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)) {
      throw new HttpError(503, "Password recovery email is not configured yet.");
    }
    const account = await prepared.userByEmail.get(body.email.trim().toLowerCase());
    if (account) {
      const token = randomBytes(32).toString("hex");
      await prepared.deleteUserResetTokens.run(account.id);
      await prepared.insertResetToken.run(hashToken(token), account.id, Date.now() + 30 * 60 * 1000);
      try {
        await sendResetEmail(request, account.email, token);
      } catch (error) {
        await prepared.deleteResetToken.run(hashToken(token));
        console.error("Could not deliver password recovery email:", error);
      }
    }
    return sendJson(response, 200, { ok: true, message: "If an account uses that email, a reset link is on its way." });
  }

  if (path === "/api/auth/reset-password") {
    requireMethod(request, "POST");
    ensureSameOriginMutation(request);
    checkRateLimit(request, "password-reset");
    const body = await readJson(request);
    if (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) {
      throw new HttpError(400, "That reset link is invalid or has expired.");
    }
    if (typeof body.password !== "string" || body.password.length < 10 || body.password.length > 128) {
      throw new HttpError(400, "Choose a password between 10 and 128 characters.");
    }
    const tokenHash = hashToken(body.token);
    const reset = await prepared.resetTokenUser.get(tokenHash);
    if (!reset || reset.expiresAt <= Date.now()) {
      if (reset) await prepared.deleteResetToken.run(tokenHash);
      throw new HttpError(400, "That reset link is invalid or has expired.");
    }
    const passwordHash = await hashPassword(body.password);
    await database.transaction(async transaction => {
      await transaction.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, reset.id);
      await transaction.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(reset.id);
      await transaction.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.id);
    });
    return sendJson(response, 200, { ok: true, message: "Your password was reset. Please sign in with the new password." }, {
      "Set-Cookie": clearSessionCookie()
    });
  }

  if (path === "/api/auth/logout") {
    requireMethod(request, "POST");
    ensureSameOriginMutation(request);
    const token = parseCookies(request.headers.cookie).get(sessionCookie);
    if (token && /^[a-f0-9]{64}$/.test(token)) await prepared.deleteSession.run(hashToken(token));
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  if (path === "/api/me" && request.method === "GET") {
    const me = await getUser(request, false);
    if (me) return sendJson(response, 200, { user: me });
    return sendJson(response, 200, { user: null });
  }

  const user = await getUser(request);

  if (path === "/api/me" && request.method === "PATCH") {
    ensureSameOriginMutation(request);
    const body = await readJson(request);
    if (typeof body.isPrivate !== "boolean" || !validEmail(body.email)) {
      throw new HttpError(400, "Choose a privacy setting and enter a valid recovery email.");
    }
    const email = body.email.trim().toLowerCase();
    const duplicate = await prepared.userByEmail.get(email);
    if (duplicate && duplicate.id !== user.id) throw new HttpError(409, "That email address is already associated with another account.");
    await prepared.setProfilePrivacy.run(body.isPrivate ? 1 : 0, email, user.id);
    const updatedUser = await prepared.userById.get(user.id);
    return sendJson(response, 200, {
      user: { ...updatedUser, isPrivate: Boolean(updatedUser.isPrivate), isAdmin: Boolean(updatedUser.isAdmin) }
    });
  }

  if (path === "/api/feed") {
    requireMethod(request, "GET");
    return sendJson(response, 200, await listPosts(user, url));
  }

  if (path === "/api/suggestions") {
    requireMethod(request, "GET");
    const suggestions = await database.prepare(`
      SELECT users.id, users.username, users.display_name AS displayName,
             users.is_private AS isPrivate,
             EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = users.id) AS following,
             EXISTS (SELECT 1 FROM follow_requests WHERE follower_id = ? AND followee_id = users.id) AS requested
      FROM users
      WHERE users.id <> ?
        AND users.is_suspended = 0
      ORDER BY following DESC, users.created_at DESC
      LIMIT 8
    `).all(user.id, user.id, user.id);
    return sendJson(response, 200, { users: suggestions });
  }

  if (path === "/api/stories" && request.method === "GET") {
    const stories = await database.prepare(`
      SELECT stories.id, stories.caption, stories.created_at AS createdAt,
             stories.expires_at AS expiresAt, media.id AS mediaId,
             users.id AS authorId, users.username, users.display_name AS displayName
      FROM stories
      JOIN users ON users.id = stories.author_id
      JOIN media ON media.id = stories.media_id
      WHERE stories.expires_at > ?
        AND stories.is_hidden = 0
        AND users.is_suspended = 0
        AND (users.id = ? OR users.is_private = 0 OR EXISTS (
          SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = users.id
        ))
      ORDER BY stories.created_at DESC
      LIMIT 100
    `).all(new Date().toISOString(), user.id, user.id);
    return sendJson(response, 200, { stories: stories.map(story => ({
      ...story,
      image: `/media/${story.mediaId}`,
      initial: (story.displayName.trim()[0] || story.username[0]).toUpperCase()
    })) });
  }

  if (path === "/api/stories" && request.method === "POST") {
    ensureSameOriginMutation(request);
    const body = await readJson(request);
    if (typeof body.mediaId !== "string" || !/^[a-f0-9-]{36}$/.test(body.mediaId)) {
      throw new HttpError(400, "Choose a photo before sharing your story.");
    }
    const caption = typeof body.caption === "string" ? body.caption.trim() : "";
    if (caption.length > 200) throw new HttpError(400, "Story captions can be up to 200 characters.");
    const media = await prepared.mediaById.get(body.mediaId);
    if (!media || media.ownerId !== user.id) throw new HttpError(404, "That uploaded photo is no longer available.");
    const now = new Date();
    const id = randomUUID();
    await database.prepare(`
      INSERT INTO stories (id, author_id, media_id, caption, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user.id, body.mediaId, caption, now.toISOString(), new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());
    return sendJson(response, 201, { story: { id, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() } });
  }

  if (path === "/api/follow-requests" && request.method === "GET") {
    const requests = await database.prepare(`
      SELECT users.id AS userId, users.username, users.display_name AS displayName,
             follow_requests.created_at AS createdAt
      FROM follow_requests JOIN users ON users.id = follow_requests.follower_id
      WHERE follow_requests.followee_id = ?
      ORDER BY follow_requests.created_at DESC
    `).all(user.id);
    return sendJson(response, 200, { requests });
  }

  const requestMatch = path.match(/^\/api\/follow-requests\/([a-f0-9-]{36})(?:\/accept)?$/);
  if (requestMatch) {
    ensureSameOriginMutation(request);
    const followerId = requestMatch[1];
    const pending = await database.prepare(`
      SELECT follower_id FROM follow_requests
      WHERE follower_id = ? AND followee_id = ?
    `).get(followerId, user.id);
    if (!pending) throw new HttpError(404, "That follow request is no longer available.");
    if (request.method === "POST" && path.endsWith("/accept")) {
      await database.transaction(async transaction => {
        await transaction.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)").run(
          followerId, user.id, new Date().toISOString()
        );
        await transaction.prepare("DELETE FROM follow_requests WHERE follower_id = ? AND followee_id = ?").run(followerId, user.id);
      });
      return sendJson(response, 200, { accepted: true });
    }
    if (request.method === "DELETE" && !path.endsWith("/accept")) {
      await database.prepare("DELETE FROM follow_requests WHERE follower_id = ? AND followee_id = ?").run(followerId, user.id);
      return sendJson(response, 200, { rejected: true });
    }
    throw new HttpError(405, "Method not allowed.");
  }

  if (path === "/api/reports" && request.method === "POST") {
    ensureSameOriginMutation(request);
    checkRateLimit(request, "report");
    const body = await readJson(request);
    if (!["post", "user", "story"].includes(body.targetType)) throw new HttpError(400, "Choose a valid item to report.");
    if (typeof body.targetId !== "string" || !/^[a-f0-9-]{36}$/.test(body.targetId)) throw new HttpError(400, "That report target is invalid.");
    if (!validString(body.reason, 500)) throw new HttpError(400, "Tell us why you’re reporting this (up to 500 characters).");
    const targetTable = { post: "posts", user: "users", story: "stories" }[body.targetType];
    if (!await database.prepare(`SELECT id FROM ${targetTable} WHERE id = ?`).get(body.targetId)) {
      throw new HttpError(404, "That report target could not be found.");
    }
    const id = randomUUID();
    await database.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user.id, body.targetType, body.targetId, body.reason.trim(), new Date().toISOString());
    return sendJson(response, 201, { reportId: id });
  }

  if (path === "/api/admin/reports" && request.method === "GET") {
    isAdmin(user);
    const reports = await database.prepare(`
      SELECT reports.id, reports.target_type AS targetType, reports.target_id AS targetId,
             reports.reason, reports.status, reports.created_at AS createdAt,
             reporter.username AS reporterUsername,
             CASE reports.target_type
               WHEN 'post' THEN (SELECT users.username FROM posts JOIN users ON users.id = posts.author_id WHERE posts.id = reports.target_id)
               WHEN 'story' THEN (SELECT users.username FROM stories JOIN users ON users.id = stories.author_id WHERE stories.id = reports.target_id)
               WHEN 'user' THEN (SELECT username FROM users WHERE id = reports.target_id)
             END AS targetUsername
      FROM reports JOIN users AS reporter ON reporter.id = reports.reporter_id
      ORDER BY CASE reports.status WHEN 'open' THEN 0 ELSE 1 END, reports.created_at DESC
      LIMIT 100
    `).all();
    return sendJson(response, 200, { reports });
  }

  const moderationMatch = path.match(/^\/api\/admin\/reports\/([a-f0-9-]{36})$/);
  if (moderationMatch && request.method === "POST") {
    isAdmin(user);
    ensureSameOriginMutation(request);
    const body = await readJson(request);
    const report = await database.prepare("SELECT target_type AS targetType, target_id AS targetId FROM reports WHERE id = ? AND status = 'open'").get(moderationMatch[1]);
    if (!report) throw new HttpError(404, "That open report could not be found.");
    const reviewedAt = new Date().toISOString();
    if (body.action === "dismiss") {
      await database.prepare("UPDATE reports SET status = 'resolved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(user.id, reviewedAt, moderationMatch[1]);
    } else if (body.action === "hide" && report.targetType === "post") {
      await database.prepare("UPDATE posts SET is_hidden = 1 WHERE id = ?").run(report.targetId);
      await database.prepare("UPDATE reports SET status = 'actioned', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(user.id, reviewedAt, moderationMatch[1]);
    } else if (body.action === "hide" && report.targetType === "story") {
      await database.prepare("UPDATE stories SET is_hidden = 1 WHERE id = ?").run(report.targetId);
      await database.prepare("UPDATE reports SET status = 'actioned', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(user.id, reviewedAt, moderationMatch[1]);
    } else if (body.action === "suspend" && report.targetType === "user") {
      if (report.targetId === user.id) throw new HttpError(400, "You cannot suspend your own administrator account.");
      await database.prepare("UPDATE users SET is_suspended = 1 WHERE id = ?").run(report.targetId);
      await database.prepare("UPDATE reports SET status = 'actioned', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(user.id, reviewedAt, moderationMatch[1]);
    } else {
      throw new HttpError(400, "That moderation action is not valid for this report.");
    }
    return sendJson(response, 200, { ok: true });
  }

  if (path === "/api/media") {
    requireMethod(request, "POST");
    ensureSameOriginMutation(request);
    const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const bytes = await readBody(request, maxImageBytes);
    if (bytes.length < 12) throw new HttpError(400, "That image file is empty or incomplete.");
    const detected = mimeBySignature.find(candidate => candidate.test(bytes));
    if (!detected || detected.mime !== contentType) throw new HttpError(415, "Upload a valid JPEG, PNG, or WebP image.");
    const id = randomUUID();
    await storeMedia(id, detected.extension, bytes, detected.mime);
    try {
      await prepared.insertMedia.run(id, user.id, detected.mime, bytes.length, new Date().toISOString());
    } catch (error) {
      await deleteStoredMedia(id, detected.extension);
      throw error;
    }
    return sendJson(response, 201, { mediaId: id });
  }

  if (path === "/api/posts") {
    requireMethod(request, "POST");
    ensureSameOriginMutation(request);
    const body = await readJson(request);
    if (!validString(body.caption, 500)) throw new HttpError(400, "Write a caption of up to 500 characters.");
    if (typeof body.mediaId !== "string" || !/^[a-f0-9-]{36}$/.test(body.mediaId)) {
      throw new HttpError(400, "Choose a photo before sharing your post.");
    }
    const media = await database.prepare("SELECT id FROM media WHERE id = ? AND owner_id = ?").get(body.mediaId, user.id);
    if (!media) throw new HttpError(404, "That uploaded photo is no longer available. Please choose it again.");
    const id = randomUUID();
    await prepared.insertPost.run(id, user.id, body.mediaId, body.caption.trim(), new Date().toISOString());
    return sendJson(response, 201, { post: await prepared.createPost.get(id) });
  }

  const mediaMatch = path.match(/^\/media\/([a-f0-9-]{36})$/);
  if (mediaMatch) {
    requireMethod(request, "GET");
    const media = await database.prepare(`
      SELECT media.id, media.owner_id AS ownerId, media.mime_type AS mimeType,
             users.is_private AS isPrivate
      FROM media JOIN users ON users.id = media.owner_id
      WHERE media.id = ? AND users.is_suspended = 0
    `).get(mediaMatch[1]);
    if (!media) throw new HttpError(404, "Photo not found.");
    const ownsMedia = media.ownerId === user.id;
    const canSeePost = Boolean(await database.prepare(`
      SELECT 1 FROM posts
      WHERE media_id = ? AND is_hidden = 0
        AND (author_id = ? OR (SELECT is_private FROM users WHERE id = author_id) = 0
          OR EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = posts.author_id))
    `).get(media.id, user.id, user.id));
    const canSeeStory = Boolean(await database.prepare(`
      SELECT 1 FROM stories
      JOIN users AS story_author ON story_author.id = stories.author_id
      WHERE media_id = ? AND expires_at > ? AND is_hidden = 0
        AND (stories.author_id = ? OR story_author.is_private = 0
          OR EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = stories.author_id))
    `).get(media.id, new Date().toISOString(), user.id, user.id));
    if (!ownsMedia && !canSeePost && !canSeeStory) throw new HttpError(404, "Photo not found.");
    const fileExtension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[media.mimeType];
    if (!fileExtension) throw new HttpError(415, "Unsupported photo type.");
    if (useSupabaseStorage) {
      const bytes = await readStoredMedia(media.id, fileExtension);
      response.writeHead(200, {
        "Content-Type": media.mimeType,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin"
      });
      response.end(bytes);
      return;
    }
    const filePath = join(uploadDirectory, `${media.id}${fileExtension}`);
    response.writeHead(200, {
      "Content-Type": media.mimeType,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin"
    });
    createReadStream(filePath).on("error", error => {
      console.error("Could not read uploaded image:", error);
      if (!response.headersSent) sendJson(response, 404, { error: "Photo file not found." });
      else response.destroy(error);
    }).pipe(response);
    return;
  }

  const mediaDeleteMatch = path.match(/^\/api\/media\/([a-f0-9-]{36})$/);
  if (mediaDeleteMatch) {
    requireMethod(request, "DELETE");
    ensureSameOriginMutation(request);
    const media = await prepared.mediaById.get(mediaDeleteMatch[1]);
    if (!media || media.ownerId !== user.id) throw new HttpError(404, "That uploaded photo could not be found.");
    const fileExtension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[media.mimeType];
    const deleted = await prepared.deleteMedia.run(media.id, user.id);
    if (!Number(deleted.changes)) throw new HttpError(409, "That photo is already attached to a post.");
    if (fileExtension) {
      await deleteStoredMedia(media.id, fileExtension);
    }
    return sendJson(response, 200, { ok: true });
  }

  const postMatch = path.match(/^\/api\/posts\/([a-f0-9-]{36})(?:\/(like|save|comments))?$/);
  if (postMatch) {
    const [, postId, operation] = postMatch;
    if (!await canSeePost(user.id, postId)) throw new HttpError(404, "That post could not be found.");
    if (operation === "like") {
      ensureSameOriginMutation(request);
      if (request.method === "PUT") await prepared.insertLike.run(user.id, postId, new Date().toISOString());
      else if (request.method === "DELETE") await prepared.deleteLike.run(user.id, postId);
      else throw new HttpError(405, "Method not allowed.");
      return sendJson(response, 200, { liked: request.method === "PUT" });
    }
    if (operation === "save") {
      ensureSameOriginMutation(request);
      if (request.method === "PUT") await prepared.insertSave.run(user.id, postId, new Date().toISOString());
      else if (request.method === "DELETE") await prepared.deleteSave.run(user.id, postId);
      else throw new HttpError(405, "Method not allowed.");
      return sendJson(response, 200, { saved: request.method === "PUT" });
    }
    if (operation === "comments") {
      requireMethod(request, "POST");
      ensureSameOriginMutation(request);
      const body = await readJson(request);
      if (!validString(body.body, 280)) throw new HttpError(400, "Write a comment of up to 280 characters.");
      const id = randomUUID();
      await prepared.insertComment.run(id, postId, user.id, body.body.trim(), new Date().toISOString());
      return sendJson(response, 201, {
        comment: { id, name: user.username, text: body.body.trim() }
      });
    }
    if (!operation && request.method === "DELETE") {
      ensureSameOriginMutation(request);
      const media = await prepared.mediaForPost.get(postId);
      const deleted = await prepared.deletePost.run(postId, user.id);
      if (!Number(deleted.changes)) throw new HttpError(403, "You can only delete your own posts.");
      if (media) {
        const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[media.mimeType];
        await database.prepare("DELETE FROM media WHERE id = ?").run(media.id);
        if (extension) await deleteStoredMedia(media.id, extension);
      }
      return sendJson(response, 200, { ok: true });
    }
    throw new HttpError(405, "Method not allowed.");
  }

  const followMatch = path.match(/^\/api\/users\/([a-f0-9-]{36})\/follow$/);
  if (followMatch) {
    ensureSameOriginMutation(request);
    const followeeId = followMatch[1];
    if (followeeId === user.id) throw new HttpError(400, "You cannot follow yourself.");
    if (!await prepared.userExists.get(followeeId)) throw new HttpError(404, "That account could not be found.");
    const target = await database.prepare("SELECT is_private AS isPrivate FROM users WHERE id = ?").get(followeeId);
    if (request.method === "POST") {
      if (target.isPrivate) {
        const alreadyFollowing = await database.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?").get(user.id, followeeId);
        if (!alreadyFollowing) {
          await database.prepare("INSERT OR IGNORE INTO follow_requests (follower_id, followee_id, created_at) VALUES (?, ?, ?)").run(user.id, followeeId, new Date().toISOString());
        }
        return sendJson(response, 200, { following: Boolean(alreadyFollowing), requested: !alreadyFollowing });
      }
      await prepared.insertFollow.run(user.id, followeeId, new Date().toISOString());
    } else if (request.method === "DELETE") {
      await prepared.deleteFollow.run(user.id, followeeId);
      await database.prepare("DELETE FROM follow_requests WHERE follower_id = ? AND followee_id = ?").run(user.id, followeeId);
    } else {
      throw new HttpError(405, "Method not allowed.");
    }
    return sendJson(response, 200, { following: request.method === "POST", requested: false });
  }

  if (path === "/api/conversations" && request.method === "POST") {
    ensureSameOriginMutation(request);
    checkRateLimit(request, "messages", 120);
    const body = await readJson(request);
    if (typeof body.recipientId !== "string" || !/^[a-f0-9-]{36}$/.test(body.recipientId)) {
      throw new HttpError(400, "Choose an account to message.");
    }
    if (!validString(body.body, 2000)) throw new HttpError(400, "Messages can be up to 2,000 characters.");
    if (body.recipientId === user.id) throw new HttpError(400, "You cannot start a conversation with yourself.");
    if (!await canMessage(user.id, body.recipientId)) {
      if (!await prepared.userExists.get(body.recipientId)) throw new HttpError(404, "That account could not be found.");
      throw new HttpError(403, "Follow or be followed by this account before starting a conversation.");
    }
    const conversation = await findOrCreateConversation(user.id, body.recipientId);
    const message = await persistMessage(conversation, user, body.body.trim());
    return sendJson(response, 201, { conversationId: conversation.id, message });
  }

  if (path === "/api/conversations" && request.method === "GET") {
    const conversations = await database.prepare(`
      SELECT conversations.id,
             other.id AS otherUserId, other.username AS otherUsername,
             other.display_name AS otherDisplayName, other.is_private AS otherIsPrivate,
             latest.body AS lastMessage, latest.created_at AS lastMessageAt,
             (SELECT COUNT(*) FROM messages unread
              WHERE unread.conversation_id = conversations.id
                AND unread.sender_id <> ?
                AND unread.read_at IS NULL) AS unreadCount
      FROM conversations
      JOIN users AS other ON other.id = CASE
        WHEN conversations.user_low = ? THEN conversations.user_high
        ELSE conversations.user_low
      END
      LEFT JOIN messages AS latest ON latest.id = (
        SELECT messages.id FROM messages
        WHERE messages.conversation_id = conversations.id
        ORDER BY messages.created_at DESC, messages.id DESC LIMIT 1
      )
      WHERE conversations.user_low = ? OR conversations.user_high = ?
      ORDER BY COALESCE(latest.created_at, conversations.created_at) DESC
      LIMIT 100
    `).all(user.id, user.id, user.id, user.id);
    const contacts = await database.prepare(`
      SELECT users.id AS otherUserId, users.username AS otherUsername,
             users.display_name AS otherDisplayName, users.is_private AS otherIsPrivate
      FROM users
      WHERE users.id <> ?
        AND users.is_suspended = 0
        AND (EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = users.id)
          OR EXISTS (SELECT 1 FROM follows WHERE follower_id = users.id AND followee_id = ?))
        AND NOT EXISTS (
          SELECT 1 FROM conversations
          WHERE (user_low = ? AND user_high = users.id)
             OR (user_high = ? AND user_low = users.id)
        )
      ORDER BY users.username COLLATE NOCASE
      LIMIT 100
    `).all(user.id, user.id, user.id, user.id, user.id);
    return sendJson(response, 200, { conversations, contacts });
  }

  const messageMatch = path.match(/^\/api\/conversations\/([a-f0-9-]{36})(?:\/messages)?$/);
  if (messageMatch) {
    const conversationId = messageMatch[1];
    const conversation = await database.prepare(`
      SELECT id, user_low AS userLow, user_high AS userHigh
      FROM conversations WHERE id = ? AND (user_low = ? OR user_high = ?)
    `).get(conversationId, user.id, user.id);

    if (path.endsWith("/messages") && request.method === "GET") {
      if (!conversation) throw new HttpError(404, "Conversation not found.");
      const messages = await database.prepare(`
        SELECT messages.id, messages.sender_id AS senderId, users.username AS senderUsername,
               messages.body, messages.created_at AS createdAt
        FROM messages JOIN users ON users.id = messages.sender_id
        WHERE messages.conversation_id = ?
        ORDER BY messages.created_at DESC, messages.id DESC LIMIT 100
      `).all(conversationId);
      await database.prepare(`
        UPDATE messages SET read_at = ?
        WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL
      `).run(new Date().toISOString(), conversationId, user.id);
      return sendJson(response, 200, { messages: messages.reverse() });
    }

    if (path.endsWith("/messages") && request.method === "POST") {
      ensureSameOriginMutation(request);
      checkRateLimit(request, "messages", 120);
      const body = await readJson(request);
      if (!validString(body.body, 2000)) throw new HttpError(400, "Messages can be up to 2,000 characters.");
      if (!conversation) throw new HttpError(404, "Conversation not found.");
      const message = await persistMessage(conversation, user, body.body.trim());
      return sendJson(response, 201, { message });
    }
    throw new HttpError(405, "Method not allowed.");
  }

  throw new HttpError(404, "Not found.");
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
}

const websocketClients = new Map();

function websocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendWebSocket(peer, value) {
  if (peer.socket.destroyed || !peer.socket.writable) return;
  peer.socket.write(websocketFrame(JSON.stringify(value)));
}

function broadcastToUser(userId, value) {
  const peers = websocketClients.get(userId);
  if (!peers) return;
  for (const peer of peers) sendWebSocket(peer, value);
}

function removeWebSocketPeer(peer) {
  const peers = websocketClients.get(peer.userId);
  peers?.delete(peer);
  if (peers?.size === 0) websocketClients.delete(peer.userId);
}

async function handleWebSocketEvent(peer, payload) {
  try {
    const event = JSON.parse(payload.toString("utf8"));
    if (event.type === "ping") {
      sendWebSocket(peer, { type: "pong" });
    } else if (event.type === "subscribe" && typeof event.conversationId === "string") {
      const allowed = await database.prepare(`
        SELECT id FROM conversations
        WHERE id = ? AND (user_low = ? OR user_high = ?)
      `).get(event.conversationId, peer.userId, peer.userId);
      if (allowed) {
        peer.conversations.add(event.conversationId);
        sendWebSocket(peer, { type: "subscribed", conversationId: event.conversationId });
      } else {
        sendWebSocket(peer, { type: "error", error: "Conversation not found." });
      }
    } else {
      sendWebSocket(peer, { type: "error", error: "Unsupported WebSocket event." });
    }
  } catch {
    sendWebSocket(peer, { type: "error", error: "WebSocket messages must be valid JSON." });
  }
}

function handleWebSocketData(peer, chunk) {
  peer.buffer = Buffer.concat([peer.buffer, chunk]);
  while (peer.buffer.length >= 2) {
    const first = peer.buffer[0];
    const second = peer.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if ((first & 0x70) !== 0 || !masked) {
      peer.socket.end(websocketFrame(Buffer.alloc(0), 0x8));
      return;
    }
    if (length === 126) {
      if (peer.buffer.length < 4) return;
      length = peer.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      peer.socket.end(websocketFrame(Buffer.alloc(0), 0x8));
      return;
    }
    if (length > 4096) {
      peer.socket.end(websocketFrame(Buffer.alloc(0), 0x8));
      return;
    }
    if (peer.buffer.length < offset + 4 + length) return;
    const mask = peer.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(peer.buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    peer.buffer = peer.buffer.subarray(offset + length);

    if (opcode === 0x8) {
      peer.socket.end(websocketFrame(payload, 0x8));
      return;
    }
    if (opcode === 0x9) {
      peer.socket.write(websocketFrame(payload, 0xA));
      continue;
    }
    if (opcode === 0xA) {
      peer.isAlive = true;
      continue;
    }
    if (opcode !== 0x1 || !fin) {
      peer.socket.end(websocketFrame(Buffer.alloc(0), 0x8));
      return;
    }
    handleWebSocketEvent(peer, payload).catch(error => {
      console.error("Could not process WebSocket event:", error);
      sendWebSocket(peer, { type: "error", error: "The WebSocket request could not be completed." });
    });
  }
}

const server = createServer(async (request, response) => {
  applySecurityHeaders(response);
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    await serveStatic(url.pathname, response);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error("Request failed:", error);
    if (!response.headersSent) sendJson(response, status, {
      error: status === 500 ? "Something went wrong on the server. Please try again." : error.message
    });
    else response.destroy(error);
  }
});

server.on("upgrade", async (request, socket, head) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!request.headers.origin) throw new HttpError(403, "WebSocket origin is required.");
    assertSameOrigin(request);
    if (request.headers.upgrade?.toLowerCase() !== "websocket" ||
        request.headers["sec-websocket-version"] !== "13" ||
        typeof request.headers["sec-websocket-key"] !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const user = await getUser(request);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n"));
    const peer = { socket, userId: user.id, buffer: Buffer.alloc(0), conversations: new Set(), isAlive: true };
    const peers = websocketClients.get(user.id) || new Set();
    peers.add(peer);
    websocketClients.set(user.id, peers);
    socket.on("data", chunk => handleWebSocketData(peer, chunk));
    socket.on("error", () => removeWebSocketPeer(peer));
    socket.on("close", () => removeWebSocketPeer(peer));
    sendWebSocket(peer, { type: "ready" });
    if (head.length) handleWebSocketData(peer, head);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  }
});

const websocketHeartbeat = setInterval(() => {
  for (const peers of websocketClients.values()) {
    for (const peer of peers) {
      if (!peer.isAlive) {
        peer.socket.destroy();
        removeWebSocketPeer(peer);
        continue;
      }
      peer.isAlive = false;
      peer.socket.write(websocketFrame(Buffer.alloc(0), 0x9));
    }
  }
}, 30_000);
websocketHeartbeat.unref();

const cleanupTimer = setInterval(() => {
  prepared.deleteExpiredSessions.run(Date.now()).catch(error => console.error("Could not clean up expired sessions:", error));
  cleanupExpiredStories().catch(error => console.error("Could not clean up expired stories:", error));
  const now = Date.now();
  for (const [key, value] of authAttempts) {
    if (now - value.startedAt > 15 * 60 * 1000) authAttempts.delete(key);
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();
cleanupExpiredStories().catch(error => console.error("Could not clean up expired stories:", error));

server.listen(port, host, () => {
  console.log(`Gather is running at http://${host}:${port}`);
  console.log(usePostgres ? "PostgreSQL database: configured" : `SQLite database: ${databasePath}`);
  console.log(useSupabaseStorage ? "Photo storage: Supabase Storage" : `Photo storage: ${uploadDirectory}`);
});

function shutdown() {
  clearInterval(cleanupTimer);
  clearInterval(websocketHeartbeat);
  server.close(() => {
    database.close().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
