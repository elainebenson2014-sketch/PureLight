/* POST /api/stripe-webhook
   Stripe calls this after a successful payment. It verifies the signature, then
   records a payment in pl_ledger so the student's balance updates automatically.

   Vercel env vars required:
     STRIPE_WEBHOOK_SECRET        (whsec_... from the webhook you create in Stripe)
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY

   Design notes:
   - Money code must never fail silently. Every step that can fail returns a
     non-2xx so Stripe records the failure and RETRIES the event automatically.
     The previous version answered "received" even when the database insert was
     rejected, which meant a payment could be collected and never posted.
   - Idempotent: the Stripe session id is stored on the ledger row and a unique
     index prevents a retry from posting the same payment twice.

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

  // Fail loudly and early on misconfiguration, so it shows up in Stripe's
  // delivery log instead of quietly dropping payments.
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

    // Only post a payment that actually collected money.
    if (s.payment_status && s.payment_status !== "paid") {
      res.status(200).json({ received: true, ignored: `payment_status=${s.payment_status}` });
      return;
    }

    let row = null;
    if (md.tuition_level && md.student_id) {
      row = {
        student_id: md.student_id,
        kind: "payment",
        description: md.description || `${md.tuition_level} tuition`,
        amount,
        method: "card",
        plan: md.plan || null,
        recorded_by: md.student_id,
      };
    } else if (md.course_id && md.student_id) {
      row = {
        student_id: md.student_id,
        course_id: md.course_id,
        kind: "payment",
        description: md.title ? `Certificate class: ${md.title}` : "Certificate class payment",
        amount,
        method: "card",
        plan: md.plan || null,
        recorded_by: md.student_id,
      };
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
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (!r.ok) {
      const text = await r.text();
      // 23505 = unique violation: this session was already posted. That's a
      // Stripe retry of an event we handled. Treat as success, don't duplicate.
      if (r.status === 409 || text.includes("23505")) {
        res.status(200).json({ received: true, duplicate: sessionId });
        return;
      }
      // Anything else is a real failure. Return 5xx so Stripe retries and the
      // failure is visible in the Stripe dashboard rather than lost.
      console.error("stripe-webhook: ledger insert failed", r.status, text, row);
      res.status(500).send(`Ledger insert failed: ${r.status} ${text}`);
      return;
    }

    console.log("stripe-webhook: posted payment", { sessionId, student: md.student_id, amount });

    // ---- Email a receipt (best-effort; never fails the webhook) ----------
    try {
      await sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail: s.customer_details?.email || s.customer_email || null });
    } catch (e) {
      console.error("stripe-webhook: receipt email failed (non-fatal)", e);
    }

    res.status(200).json({ received: true, posted: amount });
  } catch (e) {
    console.error("stripe-webhook: unhandled error", e);
    res.status(500).send(String(e.message || e));
  }
}

// Send a payment receipt to the student. Uses Resend directly (server-side key),
// since the webhook has no signed-in user to go through the app's email route.
// Sends to BOTH the account email and the Stripe checkout email when they differ.
async function sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const from = process.env.EMAIL_FROM || "NCTS PureLight <onboarding@resend.dev>";

  // Look up the student's name, account email, and program.
  let name = "Student", acctEmail = null, program = null;
  try {
    const rows = await fetch(
      `${supaUrl}/rest/v1/pl_profiles?id=eq.${encodeURIComponent(md.student_id)}&select=full_name,email,program`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    ).then((r) => r.json());
    if (Array.isArray(rows) && rows[0]) {
      name = rows[0].full_name || name;
      acctEmail = rows[0].email || null;
      program = rows[0].program || null;
    }
  } catch (e) { /* fall through with defaults */ }

  const recipients = [...new Set([acctEmail, sessionEmail].filter(Boolean).map((e) => e.trim()))];
  if (recipients.length === 0) return;

  const isCert = md.course_id || program === "certificate";
  const school = isCert ? "The Healed Place" : "NCTS Pure Light School of Ministry";
  const item = md.title ? `Certificate class: ${md.title}` : (md.description || "Tuition payment");
  const money = (n) => "$" + (Number(n) || 0).toFixed(2);
  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const when = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
    <div style="background:#1B3A6B;padding:18px 24px;text-align:center;">
      <div style="color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">${esc(school).toUpperCase()}</div>
    </div>
    <div style="padding:24px;">
      <h1 style="font-size:20px;margin:0 0 4px;color:#1B3A6B;">Payment Receipt</h1>
      <p style="font-size:14px;color:#666;margin:0 0 18px;">Thank you, ${esc(name)}. We've received your payment.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;width:120px;">Amount paid</td><td style="padding:8px 0;font-size:18px;font-weight:bold;">${money(amount)}</td></tr>
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;">For</td><td style="padding:8px 0;">${esc(item)}</td></tr>
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;">Date</td><td style="padding:8px 0;">${esc(when)}</td></tr>
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;">Method</td><td style="padding:8px 0;">Card (online)</td></tr>
      </table>
      <div style="margin-top:20px;background:#F5F0E8;border-left:4px solid #C5922E;padding:12px 16px;font-size:13px;line-height:1.6;">
        You can view your full account and any remaining balance anytime in your student portal. If you have questions, reply to this email or call 888-966-3384.
      </div>
    </div>
    <div style="border-top:1px solid #eee;padding:12px 24px;text-align:center;color:#666;font-size:11px;font-family:Arial,sans-serif;">
      www.nctspurelight.com &bull; admin@nctspurelight.com &bull; 888-966-3384
    </div>
  </div>
  </body></html>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: recipients, subject: `Payment received — ${money(amount)}`, html }),
  });
}
