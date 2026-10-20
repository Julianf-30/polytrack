const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const Database = require("better-sqlite3");

const STATIC_PATHS = [
	"a82f15d48dbc61b6edeb.woff2",
	"audio",
	"forced_square.json",
	"images",
	"index.html",
	"lib",
	"main.bundle.js",
	"manifest.json",
	"models",
	"simulation_worker.bundle.js",
	"tracks",
];

function tokenHash(token) {
	return crypto.createHash("sha256").update(token).digest("hex");
}

function readForm(req) {
	const body = typeof req.body === "string" ? req.body : "";
	const recordingMarker = "&recording=";
	const recordingIndex = body.indexOf(recordingMarker);
	if (recordingIndex !== -1) {
		const form = new URLSearchParams(body.slice(0, recordingIndex));
		form.set("recording", body.slice(recordingIndex + recordingMarker.length));
		return form;
	}
	return new URLSearchParams(body);
}

function requiredString(form, key, maxLength) {
	const value = form.get(key);
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		return null;
	}
	return value;
}

function createApp({ dbPath = process.env.LEADERBOARD_DB_PATH || path.join(__dirname, "data", "leaderboard.sqlite") } = {}) {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS profiles (
			token_hash TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			car_colors TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS scores (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			track_id TEXT NOT NULL,
			user_hash TEXT NOT NULL,
			name TEXT NOT NULL,
			car_colors TEXT NOT NULL,
			frames INTEGER NOT NULL,
			recording TEXT NOT NULL,
			verified_state INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			UNIQUE(track_id, user_hash)
		);
		CREATE INDEX IF NOT EXISTS scores_track_rank ON scores(track_id, frames, id);
	`);

	const app = express();
	app.disable("x-powered-by");
	app.use(express.text({ type: ["text/plain", "application/x-www-form-urlencoded"], limit: "256kb" }));
	app.locals.close = () => db.close();

	app.get("/api/leaderboard", (req, res) => {
		const trackId = req.query.trackId;
		const skip = Number(req.query.skip ?? 0);
		const amount = Number(req.query.amount ?? 20);
		if (typeof trackId !== "string" || trackId.length === 0 || trackId.length > 128 ||
			!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(amount) || amount < 1 || amount > 100) {
			return res.status(400).json({ error: "Invalid leaderboard query" });
		}

		const verifiedOnly = req.query.onlyVerified === "true" || req.query.onlyVerified === "1";
		const verifiedClause = verifiedOnly ? " AND verified_state = 1" : "";
		const total = db.prepare(`SELECT COUNT(*) AS total FROM scores WHERE track_id = ?${verifiedClause}`).get(trackId).total;
		const rows = db.prepare(`
			SELECT id, name, frames, car_colors, verified_state, user_hash
			FROM scores WHERE track_id = ?${verifiedClause}
			ORDER BY frames ASC, id ASC LIMIT ? OFFSET ?
		`).all(trackId, amount, skip);

		let userEntry = null;
		const userTokenHash = req.query.userTokenHash;
		if (typeof userTokenHash === "string") {
			const own = db.prepare("SELECT id, frames FROM scores WHERE track_id = ? AND user_hash = ?" + verifiedClause)
				.get(trackId, userTokenHash);
			if (own) {
				const ahead = db.prepare(`
					SELECT COUNT(*) AS count FROM scores
					WHERE track_id = ?${verifiedClause} AND (frames < ? OR (frames = ? AND id < ?))
				`).get(trackId, own.frames, own.frames, own.id).count;
				userEntry = { id: own.id, frames: own.frames, position: ahead + 1 };
			}
		}

		res.json({
			total,
			entries: rows.map((row) => ({
				id: row.id,
				name: row.name,
				frames: row.frames,
				carColors: row.car_colors,
				verifiedState: false,
				isSelf: row.user_hash === userTokenHash,
			})),
			userEntry,
		});
	});

	app.get("/api/recording", (req, res) => {
		const id = Number(req.query.recordingId);
		if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid recording id" });
		const row = db.prepare("SELECT recording, frames, car_colors FROM scores WHERE id = ?").get(id);
		if (!row) return res.status(404).json({ error: "Recording not found" });
		res.json({ recording: row.recording, frames: row.frames, carColors: row.car_colors, verifiedState: false });
	});

	app.post("/api/leaderboard", (req, res) => {
		const form = readForm(req);
		const token = requiredString(form, "userToken", 512);
		const name = requiredString(form, "name", 50);
		const carColors = requiredString(form, "carColors", 2048);
		const trackId = requiredString(form, "trackId", 128);
		const recording = requiredString(form, "recording", 10000);
		const frames = Number(form.get("frames"));
		if (!token || !name || !carColors || !trackId || !recording ||
			!Number.isSafeInteger(frames) || frames < 1) {
			return res.status(400).type("text/plain").send("Invalid score submission");
		}

		const userHash = tokenHash(token);
		const existing = db.prepare("SELECT id, frames FROM scores WHERE track_id = ? AND user_hash = ?")
			.get(trackId, userHash);
		let id = existing?.id;
		if (!existing) {
			const result = db.prepare(`
				INSERT INTO scores (track_id, user_hash, name, car_colors, frames, recording, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(trackId, userHash, name, carColors, frames, recording, Date.now());
			id = Number(result.lastInsertRowid);
		} else if (frames < existing.frames) {
			db.prepare(`
				UPDATE scores SET name = ?, car_colors = ?, frames = ?, recording = ?, created_at = ?
				WHERE id = ?
			`).run(name, carColors, frames, recording, Date.now(), existing.id);
		}
		db.prepare(`
			INSERT INTO profiles (token_hash, name, car_colors) VALUES (?, ?, ?)
			ON CONFLICT(token_hash) DO UPDATE SET name = excluded.name, car_colors = excluded.car_colors
		`).run(userHash, name, carColors);
		res.type("text/plain").send(String(id));
	});

	app.get("/api/user", (req, res) => {
		const token = req.query.userToken;
		if (typeof token !== "string" || token.length === 0 || token.length > 512) return res.json(null);
		const profile = db.prepare("SELECT name, car_colors FROM profiles WHERE token_hash = ?").get(tokenHash(token));
		res.json(profile ? { name: profile.name, carColors: profile.car_colors, isVerifier: false } : null);
	});

	app.post("/api/user", (req, res) => {
		const form = readForm(req);
		const token = requiredString(form, "userToken", 512);
		const name = requiredString(form, "name", 50);
		const carColors = requiredString(form, "carColors", 2048);
		if (!token || !name || !carColors) return res.status(400).json({ error: "Invalid profile" });
		db.prepare(`
			INSERT INTO profiles (token_hash, name, car_colors) VALUES (?, ?, ?)
			ON CONFLICT(token_hash) DO UPDATE SET name = excluded.name, car_colors = excluded.car_colors
		`).run(tokenHash(token), name, carColors);
		res.sendStatus(200);
	});

	app.post("/api/verifyRecordings", (_req, res) => {
		res.json({ unverifiedRecordings: [], exhaustive: true });
	});

	const staticFiles = express.static(__dirname, { dotfiles: "deny", index: "index.html", fallthrough: true });
	app.use((req, res, next) => {
		if (req.method !== "GET" && req.method !== "HEAD") return next();
		const pathname = new URL(req.originalUrl, "http://localhost").pathname;
		const allowed = STATIC_PATHS.some((entry) => pathname === `/${entry}` || pathname.startsWith(`/${entry}/`));
		if (pathname !== "/" && !allowed) return res.sendStatus(404);
		staticFiles(req, res, next);
	});

	app.use((req, res) => res.status(404).json({ error: "Not found" }));
	return app;
}

if (require.main === module) {
	const app = createApp();
	const port = Number(process.env.PORT || 3000);
	app.listen(port, "0.0.0.0", () => console.log(`Polytrack server listening on port ${port}`));
}

module.exports = { createApp };