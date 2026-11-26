# Gather

Gather is an original, full-stack photo-sharing application: browser UI, Node.js HTTP/WebSocket server, and persistent SQLite data. It is not affiliated with Instagram and does not use Instagram branding or private APIs.

## Run locally

Requirements: Node.js 22.13 or newer. No npm packages are required.

```powershell
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and create an account. `npm run dev` restarts the server after source changes. The default server listens on loopback; set `HOST` and `PORT` to override.

Local data lives in `data/gather.sqlite` and uploaded images in `uploads/`. Back up both. They are excluded from Git.

## Features

- Accounts, case-insensitive unique usernames and email addresses, scrypt password hashes, HTTP-only sessions.
- Account privacy: public/private profiles, incoming follow requests, accept/decline and follow/unfollow.
- Photo posts with JPEG/PNG/WebP uploads (10 MB max), server-side signature checks, comments, likes, saves, and feed pagination.
- Explore, home, saved and personal feeds; private content is filtered in database queries and media delivery.
- Stories visible to the account owner, public-account visitors, and approved followers of private accounts. Stories expire after 24 hours and are cleaned up by the server.
- Direct messages between connected accounts, persisted to SQLite and delivered to connected users over authenticated same-origin WebSockets.
- Password reset with hashed, one-time, 30-minute reset tokens. In local development the reset link is printed to the server console. Production email delivery uses Resend when `RESEND_API_KEY` and `EMAIL_FROM` are configured.
- Content and account reporting, plus an admin queue to dismiss reports, hide posts/stories, or suspend accounts.
- Request limits, login/reset throttling, same-origin checks, security headers, parameterized SQL, and basic suspended-account checks.
- Optional free-tier deployment using Render for the Node/WebSocket server and Supabase PostgreSQL and Storage for durable production data.

## Free-tier deployment (Render + Supabase)

The app's default local mode continues to use SQLite and the local `uploads/` folder. The hosted configuration uses Supabase PostgreSQL and a private Supabase Storage bucket because Render's free server filesystem is temporary.

1. Push this project to a Git provider repository you control.
2. Create a Supabase project. In **Project Settings → Database**, copy the PostgreSQL connection string for server-side use. In **Project Settings → API**, copy the project URL and the `service_role` key. Keep the service-role key private; never put it in browser code or commit it.
3. In Supabase Storage, create a **private** bucket named `gather-media` (or choose a different bucket and set `SUPABASE_STORAGE_BUCKET` accordingly).
4. In Render, create a **Blueprint** from the repository; Render reads [`render.yaml`](./render.yaml). Set `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` as private environment values. Render's free web service may sleep when idle and WebSocket connections can be interrupted when it restarts.
5. Set `ADMIN_USERNAME` to the username that should administer reports. When that account registers, it becomes an admin. If the account already exists, redeploy after setting the variable.
6. Deploy and verify `/api/health`, then create a test account and verify image upload, private-account access, and messaging.
7. Password recovery requires Resend configuration: set `RESEND_API_KEY` and a verified `EMAIL_FROM` in Render's private environment settings. Do not send credentials in chat.

The free deployment starts with a **separate, empty cloud database**. It does not upload or copy the local `data/` database or `uploads/` photos. Existing local user data stays on this computer unless you explicitly arrange a migration.

The app uses Render's forwarded HTTPS scheme to set secure session cookies and generate password-reset links. `APP_BASE_URL` can optionally be set to the canonical public URL if you use a custom domain.

## Main API routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Register username, email, display name and password |
| `POST` | `/api/auth/login` / `/api/auth/logout` | Start or end a session |
| `POST` | `/api/auth/forgot-password` | Request a password-reset link |
| `POST` | `/api/auth/reset-password` | Consume a one-time reset token |
| `GET` / `PATCH` | `/api/me` | Read account or update recovery email/privacy |
| `GET` | `/api/feed?view=home\|explore\|profile\|saved` | Read a cursor-paginated, visibility-filtered feed |
| `GET` / `POST` | `/api/stories` | Read active stories or publish a 24-hour story |
| `POST` | `/api/media` | Upload a JPEG/PNG/WebP image |
| `POST` | `/api/posts` | Publish an uploaded image and caption |
| `PUT` / `DELETE` | `/api/posts/:id/like` | Like or unlike a post |
| `POST` | `/api/posts/:id/comments` | Add a comment |
| `PUT` / `DELETE` | `/api/posts/:id/save` | Save or unsave a post |
| `POST` / `DELETE` | `/api/users/:id/follow` | Follow, request access, unfollow or cancel request |
| `GET` / `POST` | `/api/follow-requests` | Read pending requests or accept/decline one |
| `GET` / `POST` | `/api/conversations` | List conversations or begin a message thread |
| `GET` / `POST` | `/api/conversations/:id/messages` | Read or send messages |
| `GET` / `POST` | `/api/admin/reports` | Admin-only report queue and moderation |
| WebSocket | `/ws` | Authenticated same-origin live message events |

## Production boundaries

This remains a single-instance MVP, not Instagram at global scale. The free host may sleep or restart; real-time WebSocket sessions are not guaranteed to stay connected. Free managed database and storage plans have quotas and provider-specific backup, inactivity, and availability limits; review those terms and keep independent backups before relying on user data. There is no email verification, story replies, typing/presence indicators, push notifications, audit log, automated image moderation, antivirus scanning, legal/privacy workflow, or multi-instance message broker. Before a public launch, add a moderation/support policy, tested backups and restore drills, monitoring/alerts, upload re-encoding and malware controls, stronger abuse controls, and a reviewed privacy and legal process.
