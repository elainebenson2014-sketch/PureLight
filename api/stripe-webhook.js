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
    res.status(200).json({ received: true, posted: amount });
  } catch (e) {
    console.error("stripe-webhook: unhandled error", e);
    res.status(500).send(String(e.message || e));
  }
}
