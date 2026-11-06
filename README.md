# Orbit — Social Publishing Studio

A responsive, motion-led social video publishing dashboard built with React, Vite, Framer Motion, Recharts and Lucide.

## Run locally

```bash
npm install
npm run dev
```

Create a production build with `npm run build`.

## Deploy on Render

Create a **Static Site** connected to this repository:
- Build command: `npm install && npm run build`
- Publish directory: `dist`

The included `render.yaml` provides the same static-site configuration.

## Current application scope

The first frontend release includes:
- Responsive workspace navigation and overview dashboard
- Content library with search and status filters
- Video selection, caption composer and draft/schedule interactions
- Connected-channel management interface
- Calendar, analytics and workspace settings views

## Production integrations still required

The UI deliberately does not pretend that social accounts have been authenticated or that videos have been uploaded to external platforms. Real publishing requires a secure backend and platform-approved OAuth/API credentials. Before enabling production publishing, add:
1. User authentication and tenant-scoped data access.
2. Encrypted OAuth token storage and refresh handling.
3. Durable media storage and upload validation/transcoding.
4. A persistent job queue with retries, idempotency and per-platform status.
5. Official API adapters for each platform, respecting its publishing permissions and rate limits.
6. Webhooks/polling for publish status and analytics ingestion.

Never place platform client secrets or access tokens in frontend environment variables. The current demo interactions are local UI state only.

## Backend deployment requirements

The service requires a PostgreSQL database and a persistent disk. Configure these Render environment variables before the first deployment:

- `DATABASE_URL`: PostgreSQL connection string (Render PostgreSQL or Supabase).
- `APP_URL`: the public HTTPS URL of this same service.
- `ALLOWED_ORIGINS`: the same public origin.
- `TOKEN_ENCRYPTION_KEY`: a stable base64-encoded 32-byte key generated with `openssl rand -base64 32`.
- `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.
- `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
- `META_APP_ID` and `META_APP_SECRET`.

The Render blueprint creates the web service and persistent media disk, but it does not create a paid database automatically. Attach a PostgreSQL database and set `DATABASE_URL` before the health check can pass.

OAuth callback URLs to register with the providers:

- `https://YOUR-SERVICE.onrender.com/api/oauth/youtube/callback`
- `https://YOUR-SERVICE.onrender.com/api/oauth/tiktok/callback`
- `https://YOUR-SERVICE.onrender.com/api/oauth/facebook/callback`

The frontend and API are served from the same origin, so no separate frontend API URL is needed. For local development, run the Vite frontend and the API server in separate terminals; set `APP_URL` to the API origin and configure a Vite proxy before using OAuth callbacks.

