# Shorts Studio API scaffold

This directory is a server-side integration scaffold. It is **not deployed or connected to the live Pages app yet**. The public frontend does not contain or receive Google client secrets or refresh tokens.

## What it implements

- Google OAuth authorization-code flow with a signed state cookie.
- Owner-account allowlist via `OWNER_EMAIL`.
- Refresh-token encryption (AES-256-GCM) before storing it in Firestore.
- YouTube channel connection check, video upload, optional future publish time, and YouTube Analytics query.
- Uploads default to **private**. A future `publishAt` schedules a private video through YouTube; it does not render a video or find topics.

## Required before deployment

1. Deploy this service to HTTPS Cloud Run in the same Google Cloud project. Enable Firestore and grant the Cloud Run service account only the Firestore access needed for this token record.
2. Set Cloud Run environment variables: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `API_BASE_URL` (Cloud Run HTTPS service URL), `APP_ORIGIN` (the exact GitHub Pages origin), `OWNER_EMAIL` (the Google account that owns the channel), `COOKIE_SECRET` (long random secret), `TOKEN_ENCRYPTION_KEY` (base64 of 32 random bytes), and `GOOGLE_CLOUD_PROJECT`. Store secrets in Secret Manager; do not commit them or paste them into the frontend.
3. Create a Google OAuth **Web application** client. Add `API_BASE_URL/oauth2callback` as its authorized redirect URI. Add `APP_ORIGIN` as its authorized JavaScript origin. Put the client ID and secret in Cloud Run Secret Manager bindings.
4. Add OAuth scopes shown in `index.js` under Google Auth Platform → Data access. Keep the app in Testing and add the owner as a test user until the consent app is ready for the intended audience.
5. Connect YouTube by opening `API_BASE_URL/auth` and approving the requested channel/analytics access. Review the Google consent screen carefully.
6. Wire the frontend to `API_BASE_URL` with `credentials: "include"` and a deliberate user action for upload. Do not expose an admin token or OAuth token in browser JavaScript.
7. Confirm YouTube API quota and account eligibility. YouTube may restrict API-uploaded videos from unverified projects to private visibility.

## Limits

This scaffold does not discover or verify trends, write scripts, generate voice/video/thumbnail assets, or run a daily job. Cloud Run has no worker schedule configured here. A private upload/scheduled publish call is not proof that a video will trend. Review claims, rights, and the final video before scheduling.

## Local run

Node.js 20+:
```sh
npm install
npm start
```
All required secrets and Google Cloud ADC/Firestore access must be configured first. Never use real production secrets for local debugging or put them in Git.
