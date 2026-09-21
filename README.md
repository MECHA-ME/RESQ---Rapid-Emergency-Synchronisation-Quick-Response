<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/110791e5-0448-4c86-80c6-f9dc7493e86f

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Secure Dispatch API

The repository also includes a Python service under `backend/` for production-oriented dispatch workflows:

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
```

It provides JWT authentication, role-based incident access, encrypted incident condition data, an async MySQL connection health check, a QUBO/QAOA-compatible dispatch contract with a deterministic classical fallback, QPSO-style route scoring, ETA prediction, and an outbox for reliable event delivery. Set `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and `INCIDENT_ENCRYPTION_KEY` in `.env` for deployment; the service remains usable with its in-memory fallback during local development.

The web client is installable as a PWA and queues mutating requests while offline. The service worker is registered from `src/main.tsx`, and the reusable queue helper is in `src/utils/offlineSync.ts`.
