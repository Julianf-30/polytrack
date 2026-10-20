# Polytrack
Polytrack is a racing game based off of Trackmania. The game is developed by Kodub and is active on Itch.io. This is version 0.4 of Polytrack, and new updates will not be posted because I am lazy.

## Self-hosted online leaderboard

The game now sends leaderboard, profile, and replay requests to the same origin that serves the game. Run the game and API together with Node.js 22 or newer:

```sh
npm install
npm start
```

Open `http://localhost:3000`. The SQLite database is created at `data/leaderboard.sqlite`; set `LEADERBOARD_DB_PATH` to move it to a persistent disk and `PORT` to change the listening port. Deploy the app behind HTTPS and attach persistent storage to the database path so scores survive restarts.

Each player has one best time per track. The existing client only submits scores when its determinism check allows it, but this server does not independently verify replays. Scores are therefore marked unverified, and a public deployment can be cheated; do not treat the rankings as authoritative without adding server-side replay verification and abuse controls.
