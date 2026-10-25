/* POST /api/stripe-webhook   —  upload this as /api/stripe-webhook.js (replaces the old one)
   Stripe calls this after a successful payment.

   Two paths:
   1) PAY-FIRST REGISTRATION (metadata.signup = "1"): creates the student's LMS
      account, enrolls them, records the registration fee in pl_ledger, and emails
      a "set your password" link. This is how a person goes from a payment on the
      landing page to real access — no account needed beforehand.
   2) Normal in-app payment (tuition / certificate class): records a payment in
      pl_ledger so the student's balance updates, same as before.

   Vercel env vars required:
     STRIPE_WEBHOOK_SECRET        (whsec_... from the webhook you create in Stripe)
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY
   Optional:
     RESEND_API_KEY, EMAIL_FROM   (for receipt + welcome emails)
     APP_URL                      (the LMS URL used in the set-password link; default https://thehealedplace.org)
     VITE_SCHOOL_NAME             (school name shown in emails)

   The body parser is disabled because Stripe signature verification needs the raw body.
*/
import crypto from "crypto";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const supaUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret) { console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET is not set"); res.status(500).send("Webhook secret not configured"); return; }
  if (!supaUrl || !serviceKey) { console.error("stripe-webhook: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"); res.status(500).send("Database credentials not configured"); return; }

  try {
    const sig = req.headers["stripe-signature"] || "";
    const buf = await rawBody(req);

    const parts = Object.fromEntries(sig.split(",").map((kv) => kv.split("=")));
    const signedPayload = `${parts.t}.${buf.toString("utf8")}`;
    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

    let ok = false;
    try { ok = !!parts.v1 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1)); } catch { ok = false; }
    if (!ok) { console.error("stripe-webhook: invalid signature"); res.status(400).send("Invalid signature"); return; }

    const event = JSON.parse(buf.toString("utf8"));

    if (event.type !== "checkout.session.completed") {
      res.status(200).json({ received: true, ignored: event.type });
      return;
    }

    const s = event.data.object || {};
    const md = s.metadata || {};
    const amount = (s.amount_total || 0) / 100;
    const sessionId = s.id || null;
    const sessionEmail = s.customer_details?.email || s.customer_email || null;

    if (s.payment_status && s.payment_status !== "paid") {
      res.status(200).json({ received: true, ignored: `payment_status=${s.payment_status}` });
      return;
    }

    // -------- PATH 1: PAY-FIRST REGISTRATION --------
    if (md.signup === "1") {
      try {
        const result = await provisionSignup({ supaUrl, serviceKey, md, amount, sessionId, sessionEmail });
        console.log("stripe-webhook: signup provisioned", { sessionId, result });
        res.status(200).json({ received: true, signup: result });
      } catch (e) {
        console.error("stripe-webhook: signup provisioning failed", e);
        res.status(500).send("Signup provisioning failed: " + (e.message || e));
      }
      return;
    }

    // -------- PATH 2: NORMAL IN-APP PAYMENT --------
    let row = null;
    if (md.tuition_level && md.student_id) {
      row = { student_id: md.student_id, kind: "payment", description: md.description || `${md.tuition_level} tuition`, amount, method: "card", plan: md.plan || null, recorded_by: md.student_id };
    } else if (md.course_id && md.student_id) {
      row = { student_id: md.student_id, course_id: md.course_id, kind: "payment", description: md.title ? `Certificate class: ${md.title}` : "Certificate class payment", amount, method: "card", plan: md.plan || null, recorded_by: md.student_id };
    }

    if (!row) {
      console.error("stripe-webhook: no usable metadata on session", sessionId, md);
      res.status(200).json({ received: true, ignored: "missing metadata" });
      return;
    }

    if (sessionId) row.stripe_session_id = sessionId;
    row.date = new Date().toISOString().slice(0, 10);

    const r = await fetch(`${supaUrl}/rest/v1/pl_ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });

    if (!r.ok) {
      const text = await r.text();
      if (r.status === 409 || text.includes("23505")) { res.status(200).json({ received: true, duplicate: sessionId }); return; }
      console.error("stripe-webhook: ledger insert failed", r.status, text, row);
      res.status(500).send(`Ledger insert failed: ${r.status} ${text}`);
      return;
    }

    console.log("stripe-webhook: posted payment", { sessionId, student: md.student_id, amount });
    try { await sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail }); }
    catch (e) { console.error("stripe-webhook: receipt email failed (non-fatal)", e); }

    res.status(200).json({ received: true, posted: amount });
  } catch (e) {
    console.error("stripe-webhook: unhandled error", e);
    res.status(500).send(String(e.message || e));
  }
}

/* ---------------- PAY-FIRST PROVISIONING ---------------- */
async function provisionSignup({ supaUrl, serviceKey, md, amount, sessionId, sessionEmail }) {
  const email = String(md.reg_email || sessionEmail || "").trim().toLowerCase();
  const name = String(md.reg_name || "").trim();
  const program = String(md.reg_program || "certificate").toLowerCase();
  const courseId = md.reg_course_id || null;
  if (!email) throw new Error("no email on signup session");

  const admin = (path, opts = {}) => fetch(`${supaUrl}/auth/v1/admin/${path}`, {
    ...opts, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const rest = (path, opts = {}) => fetch(`${supaUrl}/rest/v1/${path}`, {
    ...opts, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });

  // Idempotency: if this Stripe session was already recorded, stop (no double email).
  const already = await rest(`pl_ledger?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=id`).then((r) => r.json()).catch(() => null);
  if (Array.isArray(already) && already.length) return "already_provisioned";

  // 1) Create the auth user (the pl_handle_new_user trigger makes their profile).
  let userId = null;
  const createRes = await admin("users", { method: "POST", body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: name } }) });
  if (createRes.ok) { const u = await createRes.json(); userId = u.id || u.user?.id || null; }
  if (!userId) {
    const prof = await rest(`pl_profiles?email=eq.${encodeURIComponent(email)}&select=id`).then((r) => r.json()).catch(() => null);
    if (Array.isArray(prof) && prof[0]) userId = prof[0].id;
  }
  if (!userId) throw new Error("could not create or find user for " + email);

  // 2) Set profile fields (do NOT touch role — default 'student' avoids the role guard).
  await rest(`pl_profiles?id=eq.${userId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ full_name: name, program, status: "active" }) });

  // 3) Enroll (certificate => cert enrollment; degree => scoped by program field).
  if (program === "certificate" && courseId) {
    await rest(`pl_cert_enrollments`, { method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" }, body: JSON.stringify({ student_id: userId, course_id: courseId }) }).catch(() => {});
  }

  // 4) Record the payment in the ledger (idempotent on stripe_session_id).
  const paidFull = md.reg_paid_full === "1";
  const desc = program === "certificate"
    ? (paidFull ? "Fully Known — paid in full" : "Fully Known registration")
    : `${program} registration`;
  const led = await rest(`pl_ledger`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ student_id: userId, kind: "payment", description: desc, amount, method: "card", date: new Date().toISOString().slice(0, 10), stripe_session_id: sessionId, recorded_by: userId }) });
  if (!led.ok) { const t = await led.text(); if (!(led.status === 409 || t.includes("23505"))) console.error("signup ledger insert failed", led.status, t); }

  // 5) Email a set-password link so they can log in.
  try {
    const appUrl = process.env.APP_URL || "https://thehealedplace.org";
    const linkRes = await admin("generate_link", { method: "POST", body: JSON.stringify({ type: "recovery", email, options: { redirect_to: appUrl } }) }).then((r) => r.json());
    const link = linkRes?.action_link || linkRes?.properties?.action_link || appUrl;
    await sendWelcome({ email, name, link, program, amount, paidFull });
  } catch (e) { console.error("signup welcome email failed (non-fatal)", e); }

  // 6) Alert the office that a new paid registration came in.
  try { await sendOfficeAlert({ email, name, program, amount, paidFull, desc }); }
  catch (e) { console.error("signup office alert failed (non-fatal)", e); }

  return { userId, email };
}

/* Office alert for a new paid registration. Recipients are fixed server-side:
   ADMIN_ALERT_EMAIL (one or more addresses, comma-separated), or the default below. */
async function sendOfficeAlert({ email, name, program, amount, paidFull, desc }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const rawTo = process.env.ADMIN_ALERT_EMAIL || "admin@nctspurelight.com, elainethomasbenson@yahoo.com";
  const to = rawTo.split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  const from = process.env.EMAIL_FROM || "The Healed Place <onboarding@resend.dev>";
  const school = program === "certificate" ? "The Healed Place" : (process.env.VITE_SCHOOL_NAME || "NCTS");
  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const money = (n) => "$" + (Number(n) || 0).toFixed(2);
  const when = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "full", timeStyle: "short" });
  const row = (k, v) => `<tr><td style="padding:7px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;width:140px;">${k}</td><td style="padding:7px 0;">${v}</td></tr>`;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,serif;color:#1a1a1a;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
      <div style="background:#1B3A6B;padding:18px 24px;text-align:center;color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">${esc(school).toUpperCase()}</div>
      <div style="padding:24px;">
        <h1 style="font-size:19px;margin:0 0 4px;color:#1B3A6B;">New registration: ${money(amount)} paid</h1>
        <p style="font-size:14px;color:#666;margin:0 0 18px;">A new student just paid online. Their account was created and they were emailed a set-password link.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row("Name", esc(name || "(no name given)"))}
          ${row("Email", `<a href="mailto:${esc(email)}" style="color:#1B3A6B;">${esc(email)}</a>`)}
          ${row("Paid", `${money(amount)}${paidFull ? " (paid in full)" : ""}`)}
          ${row("For", esc(desc))}
          ${row("When", esc(when))}
        </table>
      </div>
    </div></body></html>`;

  await sendResend(apiKey, "office alert", { from, to, subject: `New registration: ${name || email} (${money(amount)})`, html });
}

/* Send through Resend and CHECK the result, so a failed email shows up in the
   Vercel logs instead of disappearing silently. Throws on failure. */
async function sendResend(apiKey, label, payload) {
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = await r.text();
  if (!r.ok) {
    console.error(`stripe-webhook: ${label} FAILED (${r.status}) from=${payload.from} to=${(payload.to || []).join(",")}: ${text}`);
    throw new Error(`${label} failed: ${r.status} ${text}`);
  }
  console.log(`stripe-webhook: ${label} sent to ${(payload.to || []).join(",")}: ${text}`);
}

async function sendWelcome({ email, name, link, program, amount, paidFull }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error("stripe-webhook: RESEND_API_KEY not set, welcome email NOT sent to " + email); return; }
  const from = process.env.EMAIL_FROM || "The Healed Place <onboarding@resend.dev>";
  const school = program === "certificate" ? "The Healed Place" : (process.env.VITE_SCHOOL_NAME || "NCTS");
  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const money = (n) => "$" + (Number(n) || 0).toFixed(2);

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f1e7;font-family:Georgia,serif;color:#2a2230;">
    <div style="max-width:560px;margin:0 auto;background:#fffdf9;border:1px solid #e3d7c6;border-radius:10px;overflow:hidden;">
      <div style="background:#3a1d3d;padding:20px 24px;text-align:center;color:#e6d2a0;font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;font-weight:bold;">${esc(school).toUpperCase()}</div>
      <div style="padding:26px 24px;">
        <h1 style="font-size:22px;color:#3a1d3d;margin:0 0 6px;">Welcome, ${esc(name || "friend")} —</h1>
        <p style="font-size:15px;color:#555;margin:0 0 16px;">Your ${paidFull ? "payment" : "registration"} is received (${money(amount)})${paidFull ? " — paid in full" : ""} and your place is reserved. One more step: set your password to enter the learning portal.</p>
        <p style="text-align:center;margin:24px 0;"><a href="${link}" style="background:#c8a24e;color:#2a1a08;text-decoration:none;font-weight:bold;padding:13px 30px;border-radius:999px;font-family:Arial,sans-serif;font-size:15px;display:inline-block;">Set your password &amp; enter</a></p>
        <p style="font-size:13px;color:#777;margin:0;">If the button doesn't work, copy this link into your browser:<br><span style="color:#5b3560;word-break:break-all;">${link}</span></p>
        <p style="font-size:13px;color:#777;margin:18px 0 0;">${paidFull ? "You're paid in full — nothing else is due. We're glad you're here." : "Any remaining balance can be paid anytime inside your student portal. We're glad you're here."}</p>
      </div>
      <div style="border-top:1px solid #eee;padding:12px 24px;text-align:center;color:#999;font-size:11px;font-family:Arial,sans-serif;">The Healed Place · Fully Known · Seen. Known. Loved. Free.</div>
    </div></body></html>`;

  await sendResend(apiKey, "welcome email", { from, to: [email], subject: `Welcome to ${school} — set your password`, html });
}

async function sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const from = process.env.EMAIL_FROM || "NCTS PureLight <onboarding@resend.dev>";

  let name = "Student", acctEmail = null, program = null;
  try {
    const rows = await fetch(`${supaUrl}/rest/v1/pl_profiles?id=eq.${encodeURIComponent(md.student_id)}&select=full_name,email,program`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }).then((r) => r.json());
    if (Array.isArray(rows) && rows[0]) { name = rows[0].full_name || name; acctEmail = rows[0].email || null; program = rows[0].program || null; }
  } catch (e) { /* defaults */ }

  const recipients = [...new Set([acctEmail, sessionEmail].filter(Boolean).map((e) => e.trim()))];
  if (recipients.length === 0) return;

  const isCert = md.course_id || program === "certificate";
  const school = isCert ? "The Healed Place" : "NCTS Pure Light School of Ministry";
  const item = md.title ? `Certificate class: ${md.title}` : (md.description || "Tuition payment");
  const money = (n) => "$" + (Number(n) || 0).toFixed(2);
  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const when = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
    <div style="background:#1B3A6B;padding:18px 24px;text-align:center;"><div style="color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">${esc(school).toUpperCase()}</div></div>
    <div style="padding:24px;">
      <h1 style="font-size:20px;margin:0 0 4px;color:#1B3A6B;">Payment Receipt</h1>
      <p style="font-size:14px;color:#666;margin:0 0 18px;">Thank you, ${esc(name)}. We've received your payment.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;width:120px;">Amount paid</td><td style="padding:8px 0;font-size:18px;font-weight:bold;">${money(amount)}</td></tr>
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;">For</td><td style="padding:8px 0;">${esc(item)}</td></tr>
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;">Date</td><td style="padding:8px 0;">${esc(when)}</td></tr>
      </table>
      <div style="margin-top:20px;background:#F5F0E8;border-left:4px solid #C5922E;padding:12px 16px;font-size:13px;line-height:1.6;">You can view your full account and any remaining balance anytime in your student portal.</div>
    </div>
  </div></body></html>`;

  await sendResend(apiKey, "receipt", { from, to: recipients, subject: `Payment received — ${money(amount)}`, html });
}
