const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../server");

test("leaderboards store each player's best and serve the associated replay", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polytrack-leaderboard-"));
	const app = createApp({ dbPath: path.join(directory, "leaderboard.sqlite") });
	const server = app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const playerToken = "test-player-token";
	const playerTokenHash = crypto.createHash("sha256").update(playerToken).digest("hex");

	async function submit(trackId, frames, recording) {
		const form = new URLSearchParams({
			userToken: playerToken,
			name: "Test Driver",
			carColors: "[]",
			trackId,
			frames: String(frames),
		});
		const response = await fetch(`${baseUrl}/api/leaderboard`, {
			method: "POST",
			headers: { "content-type": "text/plain;charset=UTF-8" },
			body: `${form}&recording=${recording}`,
		});
		assert.equal(response.status, 200);
		return Number(await response.text());
	}

	try {
		const firstId = await submit("track-1", 1800, "first&part=1+raw");
		assert.equal(await submit("track-1", 1900, "slower replay"), firstId);
		assert.equal(await submit("track-1", 1700, "best&part=2+raw"), firstId);
		await submit("track-2", 1600, "other track replay");
		const profileUrl = `${baseUrl}/api/user?userToken=${encodeURIComponent(playerToken)}`;
		assert.equal((await (await fetch(profileUrl)).json()).name, "Test Driver");
		const profileUpdate = new URLSearchParams({ userToken: playerToken, name: "Fast Driver", carColors: "000000000000000000000000" });
		assert.equal((await fetch(`${baseUrl}/api/user`, { method: "POST", body: profileUpdate })).status, 200);
		assert.equal((await (await fetch(profileUrl)).json()).name, "Fast Driver");

		const response = await fetch(`${baseUrl}/api/leaderboard?trackId=track-1&skip=0&amount=20&onlyVerified=false&userTokenHash=${playerTokenHash}`);
		const board = await response.json();
		assert.equal(board.total, 1);
		assert.equal(board.entries[0].frames, 1700);
		assert.equal(board.entries[0].isSelf, true);
		assert.equal(board.entries[0].verifiedState, false);
		assert.deepEqual(board.userEntry, { id: firstId, frames: 1700, position: 1 });

		const replay = await fetch(`${baseUrl}/api/recording?recordingId=${firstId}`);
		assert.equal((await replay.json()).recording, "best&part=2+raw");

		const verifiedOnly = await fetch(`${baseUrl}/api/leaderboard?trackId=track-1&skip=0&amount=20&onlyVerified=true`);
		assert.equal((await verifiedOnly.json()).total, 0);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		app.locals.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});