// Vercel serverless function: POST /api/send-email
//
// Sends email through Resend. RESEND_API_KEY stays server-side only.
//
// SECURITY: this endpoint can send mail to arbitrary addresses (the student
// invite flow emails people who don't have accounts yet), so it MUST NOT be
// open to the public. Every request has to carry the Supabase access token of
// a signed-in staff member (admin / instructor / assistant). Anonymous callers
// and students are rejected. Without this check, anyone who found the URL could
// send mail from the school's domain and get it blacklisted as a spam relay.
//
// The check uses the project's URL + anon key. It verifies the caller's token,
// then reads that caller's own profile row using their own token, so no
// service-role key is needed here.

const STAFF_ROLES = ["admin", "instructor", "assistant"];

function supaEnv() {
  // Accept either naming; VITE_-prefixed vars are readable server-side too.
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  return { url, anon };
}

async function getStaffUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { error: "Missing authorization token." };

  const { url, anon } = supaEnv();
  if (!url || !anon) return { error: "Server auth is not configured." };

  // 1) Confirm the token is a real, unexpired Supabase session.
  const uRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  if (!uRes.ok) return { error: "Invalid or expired session." };
  const user = await uRes.json();
  if (!user || !user.id) return { error: "Invalid session." };

  // 2) Read this user's own profile with their own token. Row-level security
  //    permits a signed-in user to read profiles, so no elevated key is used.
  const pRes = await fetch(
    `${url}/rest/v1/pl_profiles?id=eq.${encodeURIComponent(user.id)}&select=role`,
    { headers: { apikey: anon, Authorization: `Bearer ${token}` } }
  );
  if (!pRes.ok) return { error: "Could not verify your account." };
  const rows = await pRes.json();
  const role = rows && rows[0] && rows[0].role;
  if (!STAFF_ROLES.includes(role)) return { error: "Not permitted." };

  return { user, role };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // --- Authorization gate -------------------------------------------------
  const who = await getStaffUser(req);
  if (who.error) return res.status(401).json({ error: who.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { to, bcc, subject, html, text } = body || {};

  if (!to || (Array.isArray(to) && to.length === 0) || !subject) {
    return res.status(400).json({ error: "Missing 'to' or 'subject'." });
  }

  // Cap the blast radius even for staff, so a mistake can't mail thousands.
  const count = (Array.isArray(to) ? to.length : 1) + (Array.isArray(bcc) ? bcc.length : bcc ? 1 : 0);
  if (count > 500) {
    return res.status(400).json({ error: "Too many recipients in one send (limit 500)." });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "RESEND_API_KEY is not configured." });
  }
  const from = process.env.EMAIL_FROM || "NCTS PureLight <onboarding@resend.dev>";

  try {
    const payload = {
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: html || `<p>${text || ""}</p>`,
    };
    if (bcc && (Array.isArray(bcc) ? bcc.length : true)) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
