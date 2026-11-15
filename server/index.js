import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import multer from "multer";
import jwt from "jsonwebtoken";
import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { createReadStream, unlinkSync } from "node:fs";
import { google } from "googleapis";
import { Firestore } from "@google-cloud/firestore";

const required = ["YOUTUBE_CLIENT_ID","YOUTUBE_CLIENT_SECRET","API_BASE_URL","APP_ORIGIN","OWNER_EMAIL","COOKIE_SECRET","TOKEN_ENCRYPTION_KEY","GOOGLE_CLOUD_PROJECT"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "base64");
if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be a base64 encoded 32-byte key");
const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
const app = express();
const origin = new URL(process.env.APP_ORIGIN).origin;
const callbackUrl = new URL("/oauth2callback", process.env.API_BASE_URL).toString();
const oauth = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET, callbackUrl);
const scopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors({ origin, credentials: true, methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(process.env.COOKIE_SECRET));

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(x => x.toString("base64url")).join(".");
}
function unseal(value) {
  const [iv, tag, data] = value.split(".").map(x => Buffer.from(x, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
function requireOwner(req, res, next) {
  const token = req.signedCookies.yt_session;
  if (!token) return res.status(401).json({ error: "Connect the owner YouTube account first." });
  try {
    const session = jwt.verify(token, process.env.COOKIE_SECRET);
    if (session.email !== process.env.OWNER_EMAIL) throw new Error("not owner");
    if (req.headers.origin !== origin) throw new Error("bad origin");
    req.ownerEmail = session.email;
    next();
  } catch {
    res.clearCookie("yt_session", { httpOnly: true, secure: true, sameSite: "none" });
    return res.status(401).json({ error: "Session expired or request origin is not allowed. Reconnect from Shorts Studio." });
  }
}
async function youtubeFor(email) {
  const id = createHash("sha256").update(email.toLowerCase()).digest("hex");
  const doc = await db.collection("shortsStudioOAuth").doc(id).get();
  if (!doc.exists) throw new Error("YouTube account is not connected.");
  oauth.setCredentials({ refresh_token: unseal(doc.get("refreshToken")) });
  return google.youtube({ version: "v3", auth: oauth });
}
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/auth", (_req, res) => {
  const state = randomBytes(24).toString("base64url");
  res.cookie("oauth_state", state, { signed: true, httpOnly: true, secure: true, sameSite: "lax", maxAge: 600000 });
  res.redirect(oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", include_granted_scopes: true, scope: scopes, state }));
});
app.get("/oauth2callback", async (req, res) => {
  try {
    if (!req.signedCookies.oauth_state || req.signedCookies.oauth_state !== req.query.state) throw new Error("OAuth state mismatch");
    res.clearCookie("oauth_state", { signed: true, httpOnly: true, secure: true, sameSite: "lax" });
    if (req.query.error) throw new Error(String(req.query.error));
    const { tokens } = await oauth.getToken(String(req.query.code || ""));
    oauth.setCredentials(tokens);
    const user = await google.oauth2({ version: "v2", auth: oauth }).userinfo.get();
    const email = user.data.email?.toLowerCase();
    if (!email || email !== process.env.OWNER_EMAIL.toLowerCase()) throw new Error("Connected Google account does not match OWNER_EMAIL.");
    if (tokens.refresh_token) {
      const id = createHash("sha256").update(email).digest("hex");
      await db.collection("shortsStudioOAuth").doc(id).set({ email, refreshToken: seal(tokens.refresh_token), updatedAt: new Date() });
    } else {
      const id = createHash("sha256").update(email).digest("hex");
      const existing = await db.collection("shortsStudioOAuth").doc(id).get();
      if (!existing.exists) throw new Error("Google did not return a refresh token; reconnect and approve consent.");
    }
    const session = jwt.sign({ email }, process.env.COOKIE_SECRET, { expiresIn: "7d", issuer: "shorts-studio-api", audience: origin });
    res.cookie("yt_session", session, { signed: true, httpOnly: true, secure: true, sameSite: "none", maxAge: 7 * 86400000 });
    res.redirect(origin + "/?youtube=connected");
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res.status(400).send("YouTube connection failed. Return to Shorts Studio and check the server logs.");
  }
});
app.get("/api/me", requireOwner, async (req, res) => {
  try {
    const yt = await youtubeFor(req.ownerEmail);
    const channel = await yt.channels.list({ part: ["snippet"], mine: true });
    res.json({ connected: true, channel: channel.data.items?.[0]?.snippet?.title || "Connected channel" });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
const upload = multer({ dest: "/tmp/shorts-studio", limits: { fileSize: 150 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, ["video/mp4","video/webm","video/quicktime"].includes(file.mimetype)) });
app.post("/api/upload", requireOwner, upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Attach an MP4, WebM or MOV video file." });
  try {
    const title = String(req.body.title || "").trim().slice(0, 100);
    if (!title) return res.status(400).json({ error: "A video title is required." });
    const description = String(req.body.description || "").slice(0, 5000);
    const publishAt = req.body.publishAt ? new Date(req.body.publishAt) : null;
    if (publishAt && (Number.isNaN(+publishAt) || publishAt <= new Date())) return res.status(400).json({ error: "publishAt must be a future ISO date." });
    const privacyStatus = publishAt ? "private" : (["private","unlisted","public"].includes(req.body.privacyStatus) ? req.body.privacyStatus : "private");
    const yt = await youtubeFor(req.ownerEmail);
    const result = await yt.videos.insert({
      part: ["snippet","status"],
      requestBody: { snippet: { title, description }, status: { privacyStatus, ...(publishAt ? { publishAt: publishAt.toISOString() } : {}) } },
      media: { body: createReadStream(req.file.path) }
    });
    res.json({ id: result.data.id, url: `https://youtube.com/shorts/${result.data.id}`, privacyStatus, publishAt: publishAt?.toISOString() || null });
  } catch (error) {
    console.error("YouTube upload failed:", error.message);
    res.status(502).json({ error: "YouTube upload failed. Check API quota, OAuth scope, and Cloud Run logs." });
  } finally { try { unlinkSync(req.file.path); } catch {} }
});
app.get("/api/analytics", requireOwner, async (req, res) => {
  try {
    const endDate = String(req.query.endDate || new Date().toISOString().slice(0,10));
    const startDate = String(req.query.startDate || new Date(Date.now() - 28*86400000).toISOString().slice(0,10));
    const yt = await youtubeFor(req.ownerEmail);
    const channel = await yt.channels.list({ part: ["id"], mine: true });
    const channelId = channel.data.items?.[0]?.id;
    if (!channelId) return res.status(404).json({ error: "No YouTube channel found." });
    const analytics = google.youtubeAnalytics({ version: "v2", auth: oauth });
    const report = await analytics.reports.query({ ids: `channel==${channelId}`, startDate, endDate, dimensions: "day", metrics: "views,likes,comments,estimatedMinutesWatched,averageViewDuration" });
    res.json({ startDate, endDate, rows: report.data.rows || [] });
  } catch (error) {
    console.error("Analytics query failed:", error.message);
    res.status(502).json({ error: "Analytics unavailable. Confirm consent scopes and YouTube Analytics API." });
  }
});
app.post("/api/logout", requireOwner, (_req, res) => { res.clearCookie("yt_session", { httpOnly: true, secure: true, sameSite: "none" }); res.json({ ok: true }); });
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => console.log(`Shorts Studio API listening on ${port}; OAuth callback: ${callbackUrl}`));
