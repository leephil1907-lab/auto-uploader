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
