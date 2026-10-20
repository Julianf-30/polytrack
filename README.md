# Polytrack
Polytrack is a racing game based off of Trackmania. The game is developed by Kodub and is active on Itch.io. This is version 0.4 of Polytrack, and new updates will not be posted because I am lazy.

## Supabase leaderboard

The game sends leaderboard, profile, and replay requests to the Supabase Edge Function configured in `supabase-config.js`. To initialize the project:

```sh
npx supabase login
npx supabase link --project-ref eyseryoizzihcrdlbfgq
npx supabase functions deploy polytrack
```

First run `supabase/schema.sql` in the Supabase SQL Editor to create the tables and score-submission function. Supabase supplies the Edge Function's server credentials; never put a service-role key in the game. `supabase-config.js` contains the browser-safe publishable key.

For local play, run `npm ci` and `npm start`, then open `http://localhost:3000`. In GitHub Codespaces, `.devcontainer/devcontainer.json` installs dependencies on creation, starts the game server whenever the Codespace starts, and forwards port 3000. A stopped Codespace cannot serve the game, but the Supabase leaderboard remains available independently.

Each player has one best time per track. The game runs its client-side determinism check before uploading, but the Edge Function does not independently verify replays. Scores are marked unverified and can be spoofed; don’t treat the rankings as authoritative without adding server-side replay verification and abuse controls.
