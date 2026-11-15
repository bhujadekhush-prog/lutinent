# Shorts Studio Worker

Cloudflare Worker backend plus same-origin static interface for YouTube Shorts upload and Analytics. It uses D1 database `shorts-studio-db` (binding already configured).

## Current capabilities

- Connect the owner Google account with OAuth.
- Check the connected YouTube channel.
- Upload an owner-provided MP4/WebM/MOV (app limit 90 MB), private by default; optionally schedule a future publish time.
- Read channel-level YouTube Analytics for the last 28 days.
- Serve the interface and API from the same Worker origin.

This does **not** discover current trends, fact-check topics, generate scripts/video/audio/thumbnail assets, or run a daily auto-upload schedule. A user must provide and review the final video. No virality guarantee.

## Cloudflare deployment

Create a GitHub-connected Worker from `bhujadekhush-prog/lutinent`, with:

- Worker name: `shorts-studio-api`
- Root directory: `server-worker`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`
- D1 database binding is in `wrangler.jsonc`.

After deploy, note the exact `https://shorts-studio-api.<account-subdomain>.workers.dev` URL and check `/healthz`.

In Worker Settings → Variables and Secrets, add these as **secrets** (never commit them):

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OWNER_EMAIL` (channel owner Google account)
- `TOKEN_ENCRYPTION_KEY` (base64 for exactly 32 cryptographically random bytes)

Add `APP_ORIGIN` as a variable with the Worker origin, for example `https://shorts-studio-api.<account-subdomain>.workers.dev`. If Worker hostname differs, use the exact deployed origin.

PowerShell encryption key command:
```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```
Keep the output private and store directly in Cloudflare Secrets.

## Google OAuth client

In Google Cloud project **Shorts Studio Upload**, Google Auth Platform → Clients → Create client → Web application:

- Authorized redirect URI: `<WORKER_ORIGIN>/oauth2callback`
- JavaScript origin: `<WORKER_ORIGIN>`

Add the OAuth scopes in Google Auth Platform → Data access: `openid`, `email`, `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly`, `https://www.googleapis.com/auth/yt-analytics.readonly`. Keep the app in Testing and add only the owner as a test user. Do not paste the client secret into chat, GitHub, or frontend code.

Once secrets are set and deployment is healthy, open `<WORKER_ORIGIN>/auth`; the owner must inspect Google's consent screen and approve. The app then returns to the Worker interface.

## Important limits

- Upload is a direct multipart request with an app-level 90 MB limit; use YouTube Studio for larger files.
- Scheduled public release is handled through YouTube's `publishAt` semantics (the video remains private before that time).
- Google's API quota, OAuth testing/verification state, account eligibility, and Cloudflare free plan limits apply.
- No scheduled job or automatic media-generation service is configured.
