const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase server environment is incomplete");
const restUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { ...corsHeaders, "Content-Type": "application/json" },
	});
}

function textResponse(value: string, status = 200): Response {
	return new Response(value, {
		status,
		headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
	});
}

function parseForm(body: string): URLSearchParams {
	const marker = "&recording=";
	const index = body.indexOf(marker);
	if (index === -1) return new URLSearchParams(body);
	const form = new URLSearchParams(body.slice(0, index));
	form.set("recording", body.slice(index + marker.length));
	return form;
}

function formString(form: URLSearchParams, key: string, maxLength: number): string | null {
	const value = form.get(key);
	return value && value.length <= maxLength ? value : null;
}

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isValidColors(value: string): boolean {
	return /^[0-9a-f]{24}$/i.test(value);
}

async function databaseRequest(path: string, init: RequestInit = {}) {
	const response = await fetch(`${restUrl}/${path}`, {
		...init,
		headers: {
			apikey: serviceRoleKey!,
			Authorization: `Bearer ${serviceRoleKey}`,
			...(init.headers ?? {}),
		},
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`Supabase database request failed (${response.status}): ${body}`);
	const range = response.headers.get("content-range")?.match(/\/(\d+|\*)$/)?.[1];
	return {
		data: body ? JSON.parse(body) : null,
		count: range && range !== "*" ? Number(range) : null,
	};
}

async function handleLeaderboardGet(url: URL): Promise<Response> {
	const trackId = url.searchParams.get("trackId");
	const skip = Number(url.searchParams.get("skip") ?? 0);
	const amount = Number(url.searchParams.get("amount") ?? 20);
	const verifiedOnly = url.searchParams.get("onlyVerified") === "true";
	if (!trackId || trackId.length > 128 || !Number.isSafeInteger(skip) || skip < 0 ||
		!Number.isSafeInteger(amount) || amount < 1 || amount > 100) {
		return jsonResponse({ error: "Invalid leaderboard query" }, 400);
	}

	const entriesParams = new URLSearchParams({
		select: "id,name,frames,car_colors,verified_state,user_hash",
		track_id: `eq.${trackId}`,
		order: "frames.asc,id.asc",
	});
	if (verifiedOnly) entriesParams.set("verified_state", "eq.true");
	const { data: rows, count } = await databaseRequest(`polytrack_scores?${entriesParams}`, {
		headers: { Prefer: "count=exact", "Range-Unit": "items", Range: `${skip}-${skip + amount - 1}` },
	});

	let userEntry = null;
	const userTokenHash = url.searchParams.get("userTokenHash");
	if (userTokenHash) {
		const ownParams = new URLSearchParams({
			select: "id,frames",
			track_id: `eq.${trackId}`,
			user_hash: `eq.${userTokenHash}`,
			limit: "1",
		});
		if (verifiedOnly) ownParams.set("verified_state", "eq.true");
		const { data: ownRows } = await databaseRequest(`polytrack_scores?${ownParams}`);
		const own = ownRows?.[0];
		if (own) {
			const aheadParams = new URLSearchParams({
				select: "id",
				track_id: `eq.${trackId}`,
				or: `(frames.lt.${own.frames},and(frames.eq.${own.frames},id.lt.${own.id}))`,
			});
			if (verifiedOnly) aheadParams.set("verified_state", "eq.true");
			const { count: ahead } = await databaseRequest(`polytrack_scores?${aheadParams}`, {
				method: "HEAD",
				headers: { Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" },
			});
			userEntry = { id: Number(own.id), frames: Number(own.frames), position: (ahead ?? 0) + 1 };
		}
	}

	return jsonResponse({
		total: count ?? 0,
		entries: (rows ?? []).map((row) => ({
			id: Number(row.id),
			name: row.name,
			frames: Number(row.frames),
			carColors: row.car_colors,
			verifiedState: row.verified_state,
			isSelf: row.user_hash === userTokenHash,
		})),
		userEntry,
	});
}

async function handleRequest(request: Request): Promise<Response> {
	if (request.method === "OPTIONS") return new Response("", { headers: corsHeaders });
	const url = new URL(request.url);
	const route = url.pathname.split("/").filter(Boolean).pop() ?? "";

	if (request.method === "GET" && route === "leaderboard") return await handleLeaderboardGet(url);

	if (request.method === "GET" && route === "recording") {
		const id = Number(url.searchParams.get("recordingId"));
		if (!Number.isSafeInteger(id) || id < 1) return jsonResponse({ error: "Invalid recording id" }, 400);
		const params = new URLSearchParams({
			select: "recording,frames,car_colors,verified_state",
			id: `eq.${id}`,
			limit: "1",
		});
		const { data: rows } = await databaseRequest(`polytrack_scores?${params}`);
		const data = rows?.[0];
		if (!data) return jsonResponse({ error: "Recording not found" }, 404);
		return jsonResponse({ recording: data.recording, frames: Number(data.frames), carColors: data.car_colors, verifiedState: false });
	}

	if (request.method === "POST" && route === "leaderboard") {
		const form = parseForm(await request.text());
		const token = formString(form, "userToken", 512);
		const name = formString(form, "name", 200);
		const carColors = formString(form, "carColors", 64);
		const trackId = formString(form, "trackId", 128);
		const recording = formString(form, "recording", 10000);
		const frames = Number(form.get("frames"));
		if (!token || !name || Array.from(name).length > 50 || !carColors || !isValidColors(carColors) ||
			!trackId || !recording || !Number.isSafeInteger(frames) || frames < 1) {
			return textResponse("Invalid score submission", 400);
		}

		const userHash = await hashToken(token);
		const { data } = await databaseRequest("rpc/submit_polytrack_score", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				p_track_id: trackId,
				p_user_hash: userHash,
				p_name: name,
				p_car_colors: carColors,
				p_frames: frames,
				p_recording: recording,
			}),
		});
		return textResponse(String(data));
	}

	if (request.method === "GET" && route === "user") {
		const token = url.searchParams.get("userToken");
		if (!token || token.length > 512) return jsonResponse(null);
		const params = new URLSearchParams({
			select: "name,car_colors",
			token_hash: `eq.${await hashToken(token)}`,
			limit: "1",
		});
		const { data: rows } = await databaseRequest(`polytrack_profiles?${params}`);
		const data = rows?.[0];
		return jsonResponse(data ? { name: data.name, carColors: data.car_colors, isVerifier: false } : null);
	}

	if (request.method === "POST" && route === "user") {
		const form = parseForm(await request.text());
		const token = formString(form, "userToken", 512);
		const name = formString(form, "name", 200);
		const carColors = formString(form, "carColors", 64);
		if (!token || !name || Array.from(name).length > 50 || !carColors || !isValidColors(carColors)) {
			return jsonResponse({ error: "Invalid profile" }, 400);
		}
		const userHash = await hashToken(token);
		const profileParams = new URLSearchParams({ on_conflict: "token_hash" });
		await databaseRequest(`polytrack_profiles?${profileParams}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
			body: JSON.stringify({
				token_hash: userHash,
				name,
				car_colors: carColors,
				updated_at: new Date().toISOString(),
			}),
		});
		const scoreParams = new URLSearchParams({ user_hash: `eq.${userHash}` });
		await databaseRequest(`polytrack_scores?${scoreParams}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
			body: JSON.stringify({ name, car_colors: carColors }),
		});
		return textResponse("");
	}

	if (request.method === "POST" && route === "verifyRecordings") {
		return jsonResponse({ unverifiedRecordings: [], exhaustive: true });
	}

	return jsonResponse({ error: "Not found" }, 404);
}

Deno.serve(async (request: Request) => {
	try {
		return await handleRequest(request);
	} catch (error) {
		console.error("Polytrack leaderboard error:", error);
		return jsonResponse({ error: "Leaderboard request failed" }, 500);
	}
});