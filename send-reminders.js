// Vercel Cron target: GET /api/send-reminders
// Runs on a schedule (see vercel.json). Emails students whose program has a
// live class in the next 24 hours. Uses the Supabase service role (server-side
// only) to read sessions + student emails, and Resend to send. Students are BCC'd.
export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "NCTS PureLight <onboarding@resend.dev>";

  // Optional protection: if CRON_SECRET is set, require it.
  if (process.env.CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  if (!SUPABASE_URL || !SR || !apiKey) {
    return res.status(500).json({ error: "Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or RESEND_API_KEY." });
  }

  const h = { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" };
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 3600 * 1000);

  try {
    const sUrl = `${SUPABASE_URL}/rest/v1/pl_sessions?select=*&starts_at=gte.${now.toISOString()}&starts_at=lt.${end.toISOString()}&order=starts_at.asc`;
    const sessions = await (await fetch(sUrl, { headers: h })).json();
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, note: "No classes in the next 24 hours." });
    }

    const profs = await (await fetch(`${SUPABASE_URL}/rest/v1/pl_profiles?select=email,program,role`, { headers: h })).json();
    const students = (Array.isArray(profs) ? profs : []).filter((p) => p.role === "student" && p.email);

    const fromEmail = (from.match(/<([^>]+)>/) || [null, from])[1];
    let sent = 0;
    for (const s of sessions) {
      const recips = students.filter((p) => s.program === "all" || p.program === s.program).map((p) => p.email);
      if (!recips.length) continue;
      const when = new Date(s.starts_at).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const join = s.zoom_url ? `<p><a href="${s.zoom_url}">Join the class on Zoom</a></p>` : "";
      const html = `<p>You have a class today:</p><p><b>${s.title}</b><br/>${when} (Central)${s.duration_min ? ` &middot; ${s.duration_min} min` : ""}</p>${join}${s.notes ? `<p>${s.notes}</p>` : ""}<p style="color:#888">&mdash; NCTS PureLight</p>`;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [fromEmail], bcc: recips, subject: `Class today: ${s.title}`, html }),
      });
      if (r.ok) sent++;
    }
    return res.status(200).json({ ok: true, sessions: sessions.length, sent });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
