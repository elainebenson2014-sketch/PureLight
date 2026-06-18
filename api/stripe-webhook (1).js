/* POST /api/stripe-webhook
   Stripe calls this after a successful payment. It verifies the signature, then
   records a payment in pl_ledger (linked to the class via course_id) so the
   student shows as Paid automatically.

   Vercel env vars required:
     STRIPE_WEBHOOK_SECRET        (whsec_... from the webhook you create in Stripe)
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY

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
  try {
    const sig = req.headers["stripe-signature"] || "";
    const buf = await rawBody(req);
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    const parts = Object.fromEntries(sig.split(",").map((kv) => kv.split("=")));
    const signedPayload = `${parts.t}.${buf.toString("utf8")}`;
    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

    let ok = false;
    try { ok = parts.v1 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1)); } catch { ok = false; }
    if (!ok) { res.status(400).send("Invalid signature"); return; }

    const event = JSON.parse(buf.toString("utf8"));
    if (event.type === "checkout.session.completed") {
      const s = event.data.object || {};
      const md = s.metadata || {};
      if (md.course_id && md.student_id) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/pl_ledger`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            student_id: md.student_id,
            course_id: md.course_id,
            kind: "payment",
            description: md.title ? `Certificate class: ${md.title}` : "Certificate class payment",
            amount: (s.amount_total || 0) / 100,
            method: "card",
            recorded_by: md.student_id,
          }),
        });
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
}
