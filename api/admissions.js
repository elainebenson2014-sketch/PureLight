/* /api/admissions  —  online applications

   POST { action:"apply", full_name, email, phone, program, answers:{...}, files:[{ name, type, data(base64) }] }
        Public (no account). Saves the application and any documents (private storage),
        emails the applicant a confirmation and the office an alert.
   POST { action:"approve", id, program?, course_id? }      staff only
        Creates the student's account (or reuses an existing one), sets the program,
        enrolls them in a certificate class if one is chosen, and emails a set-password link.
   POST { action:"decline", id, note?, notify? }            staff only
        Marks the application declined; optionally emails the applicant a kind note.

   Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (or VITE_),
   RESEND_API_KEY, EMAIL_FROM, ADMIN_ALERT_EMAIL, APP_URL, VITE_SCHOOL_NAME
*/
const MAX_FILES = 3;
const MAX_BYTES = 3 * 1024 * 1024; // all documents together (keeps under Vercel's request limit)

const env = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  anon: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
});
const esc = (t) => String(t ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

function rest(e) {
  return (path, opts = {}) => fetch(`${e.url}/rest/v1/${path}`, {
    ...opts, headers: { apikey: e.service, Authorization: `Bearer ${e.service}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}

async function requireStaff(req, e) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { error: "Not signed in." };
  const u = await fetch(`${e.url}/auth/v1/user`, { headers: { apikey: e.anon || e.service, Authorization: `Bearer ${token}` } });
  if (!u.ok) return { error: "Session expired. Sign in again." };
  const user = await u.json();
  const rows = await rest(e)(`pl_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,full_name`).then((r) => r.json()).catch(() => []);
  const me = Array.isArray(rows) ? rows[0] : null;
  if (!me || !["admin", "assistant"].includes(me.role)) return { error: "Only administrators can review applications." };
  return { me };
}

function shell(school, body) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,serif;color:#1a1a1a;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
      <div style="background:#1B3A6B;padding:18px 24px;text-align:center;color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">${esc(school).toUpperCase()}</div>
      <div style="padding:24px;font-size:14px;line-height:1.6;">${body}</div></div></body></html>`;
}
async function sendMail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to.length) return false;
  const from = process.env.EMAIL_FROM || "YonaLearn <onboarding@resend.dev>";
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to, subject, html }) });
  if (!r.ok) console.error("admissions email failed", r.status, await r.text());
  return r.ok;
}
const office = () => (process.env.ADMIN_ALERT_EMAIL || "").split(",").map((x) => x.trim()).filter(Boolean);
const portal = () => process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

async function apply(body, e, res) {
  const db = rest(e);
  const sres = await db(`pl_admission_settings?id=eq.1&select=open,questions,programs`).then((r) => r.json()).catch(() => []);
  const settings = (Array.isArray(sres) && sres[0]) || { open: true, questions: [], programs: [] };
  if (!settings.open) return res.status(403).json({ error: "Applications are closed right now. Please contact the office." });

  const full_name = clip(body.full_name, 120), email = clip(body.email, 200).toLowerCase(), phone = clip(body.phone, 40), program = clip(body.program, 40);
  if (!full_name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Please enter your full name and a valid email." });
  if (body.website) return res.status(200).json({ ok: true }); // hidden field: bots fill it in

  // Answers: the standard questions plus this school's own questions.
  const raw = body.answers && typeof body.answers === "object" ? body.answers : {};
  const answers = {};
  for (const [k, v] of Object.entries(raw).slice(0, 60)) answers[clip(k, 80)] = clip(v, 4000);
  for (const q of Array.isArray(settings.questions) ? settings.questions : []) {
    if (q && q.required && !String(answers[q.label] || "").trim()) return res.status(400).json({ error: `Please answer: ${q.label}` });
  }

  // Slow down repeats: one application per email per 10 minutes.
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recent = await db(`pl_applications?email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(since)}&select=id`).then((r) => r.json()).catch(() => []);
  if (Array.isArray(recent) && recent.length) return res.status(429).json({ error: "We just received an application from this email. Please wait a few minutes before sending another." });

  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
  let bytes = 0;
  const decoded = [];
  for (const f of files) {
    const buf = Buffer.from(String(f.data || ""), "base64");
    bytes += buf.length;
    if (!buf.length) continue;
    if (bytes > MAX_BYTES) return res.status(413).json({ error: "Your documents are too large together (3 MB limit). Please send smaller files." });
    const safe = clip(f.name, 80).replace(/[^A-Za-z0-9._-]+/g, "_") || "document";
    decoded.push({ buf, name: safe, type: clip(f.type, 80) || "application/octet-stream" });
  }

  const ins = await db(`pl_applications`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ full_name, email, phone, program, answers }) });
  if (!ins.ok) return res.status(500).json({ error: "We couldn't save your application. Please try again." });
  const [appRow] = await ins.json();

  const saved = [];
  for (const f of decoded) {
    const path = `applications/${appRow.id}/${Date.now()}-${f.name}`;
    const up = await fetch(`${e.url}/storage/v1/object/purelight/${path}`, { method: "POST", headers: { apikey: e.service, Authorization: `Bearer ${e.service}`, "Content-Type": f.type, "x-upsert": "false" }, body: f.buf });
    if (up.ok) saved.push({ name: f.name, path });
    else console.error("application upload failed", up.status, await up.text());
  }
  if (saved.length) await db(`pl_applications?id=eq.${appRow.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ files: saved }) });

  const school = process.env.VITE_SCHOOL_NAME || "Our school";
  await sendMail([email], `We received your application to ${school}`, shell(school,
    `<h1 style="font-size:20px;color:#1B3A6B;margin:0 0 8px;">Thank you, ${esc(full_name)}!</h1>
     <p>Your application${program ? ` for <b>${esc(program)}</b>` : ""} has been received. Our admissions team will review it and email you with a decision.</p>
     <p>If you have questions in the meantime, simply reply to this email.</p>`)).catch(() => {});
  const rows = Object.entries(answers).map(([k, v]) => `<p><b>${esc(k)}</b><br>${esc(v).replace(/\n/g, "<br>")}</p>`).join("");
  await sendMail(office(), `New application: ${full_name}${program ? ` (${program})` : ""}`, shell(school,
    `<h1 style="font-size:19px;color:#1B3A6B;margin:0 0 8px;">New application</h1>
     <p><b>${esc(full_name)}</b> · ${esc(email)}${phone ? ` · ${esc(phone)}` : ""}${program ? `<br>Program: <b>${esc(program)}</b>` : ""}</p>
     ${rows}${saved.length ? `<p>${saved.length} document(s) attached in the portal.</p>` : ""}
     <p>Review it in the portal under <b>Admissions</b>.</p>`)).catch(() => {});
  return res.status(200).json({ ok: true });
}

async function approve(body, e, me, res) {
  const db = rest(e);
  const rows = await db(`pl_applications?id=eq.${encodeURIComponent(body.id || "")}&select=*`).then((r) => r.json()).catch(() => []);
  const a = Array.isArray(rows) ? rows[0] : null;
  if (!a) return res.status(404).json({ error: "Application not found." });
  if (a.status === "approved") return res.status(200).json({ ok: true, already: true });
  const email = a.email.toLowerCase();
  const program = clip(body.program || a.program, 40).toLowerCase() || "certificate";

  const admin = (path, opts = {}) => fetch(`${e.url}/auth/v1/admin/${path}`, { ...opts, headers: { apikey: e.service, Authorization: `Bearer ${e.service}`, "Content-Type": "application/json" } });
  let userId = null, existing = false;
  const prof = await db(`pl_profiles?email=eq.${encodeURIComponent(email)}&select=id,role`).then((r) => r.json()).catch(() => []);
  if (Array.isArray(prof) && prof[0]) { userId = prof[0].id; existing = true; }
  if (!userId) {
    const c = await admin("users", { method: "POST", body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: a.full_name } }) });
    if (c.ok) { const u = await c.json(); userId = u.id || u.user?.id || null; }
    if (!userId) return res.status(500).json({ error: "Couldn't create the student's account. They may already have one under another email." });
  }
  // Never change an existing staff member's role; just set program and status for students.
  const isStaff = existing && prof[0].role && prof[0].role !== "student";
  if (!isStaff) await db(`pl_profiles?id=eq.${userId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ full_name: a.full_name, program, status: "active" }) });
  if (body.course_id) await db(`pl_cert_enrollments`, { method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" }, body: JSON.stringify({ student_id: userId, course_id: body.course_id }) }).catch(() => {});

  await db(`pl_applications?id=eq.${a.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "approved", program, student_id: userId, reviewed_by: me.id, reviewed_at: new Date().toISOString() }) });

  const school = process.env.VITE_SCHOOL_NAME || "Our school";
  const appUrl = portal();
  let link = appUrl;
  try {
    const lr = await admin("generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email, options: { redirect_to: appUrl || undefined } }) }).then((r) => r.json());
    link = lr?.action_link || lr?.properties?.action_link || appUrl;
  } catch (err) { console.error("set-password link failed", err); }
  const sent = await sendMail([email], `Welcome to ${school}! You've been accepted`, shell(school,
    `<h1 style="font-size:20px;color:#1B3A6B;margin:0 0 8px;">Congratulations, ${esc(a.full_name)}!</h1>
     <p>Your application has been <b>accepted</b>. Your student account is ready.</p>
     ${existing ? `<p>You already have an account with this email. Sign in as usual${link ? ` at <a href="${esc(appUrl)}" style="color:#1B3A6B;">${esc(appUrl)}</a>` : ""}.</p>`
       : `<p><a href="${esc(link)}" style="display:inline-block;background:#1B3A6B;color:#fff;padding:11px 22px;border-radius:999px;text-decoration:none;font-family:Arial,sans-serif;">Set your password and sign in</a></p>
          <p style="font-size:12px;color:#666;">This link works once. If it expires, use “Forgot password?” on the sign-in page with this email.</p>`}
     <p>We're glad you're here.</p>`));
  return res.status(200).json({ ok: true, student_id: userId, emailed: sent, existing });
}

async function decline(body, e, me, res) {
  const db = rest(e);
  const rows = await db(`pl_applications?id=eq.${encodeURIComponent(body.id || "")}&select=*`).then((r) => r.json()).catch(() => []);
  const a = Array.isArray(rows) ? rows[0] : null;
  if (!a) return res.status(404).json({ error: "Application not found." });
  const note = clip(body.note, 2000);
  await db(`pl_applications?id=eq.${a.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "declined", decision_note: note || null, reviewed_by: me.id, reviewed_at: new Date().toISOString() }) });
  let sent = false;
  if (body.notify) {
    const school = process.env.VITE_SCHOOL_NAME || "Our school";
    sent = await sendMail([a.email], `Your application to ${school}`, shell(school,
      `<p>Dear ${esc(a.full_name)},</p>
       <p>Thank you for applying to ${esc(school)}. After careful review, we are not able to offer you admission at this time.</p>
       ${note ? `<p>${esc(note).replace(/\n/g, "<br>")}</p>` : ""}
       <p>We are grateful for your interest and pray God's blessing on your journey.</p>`));
  }
  return res.status(200).json({ ok: true, emailed: sent });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const e = env();
  if (!e.url || !e.service) return res.status(500).json({ error: "Admissions is not set up for this school." });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  try {
    if (body.action === "apply") return await apply(body, e, res);
    const { me, error } = await requireStaff(req, e);
    if (error) return res.status(401).json({ error });
    if (body.action === "approve") return await approve(body, e, me, res);
    if (body.action === "decline") return await decline(body, e, me, res);
    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("admissions failed", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
