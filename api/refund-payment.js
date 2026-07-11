// Vercel serverless function: POST /api/refund-payment
//
// Refunds a payment through Stripe AND reverses it on the student's ledger, so
// the two always agree. Called from the admin Billing screen.
//
// SECURITY: staff only. The caller must present a signed-in admin/instructor/
// assistant session token, verified against Supabase. Anonymous callers and
// students are rejected — a refund moves money and must never be public.
//
// Vercel env vars required:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL (or VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY)  — to verify the caller

const STAFF_ROLES = ["admin", "instructor", "assistant"];

function env() {
  return {
    stripeKey: process.env.STRIPE_SECRET_KEY,
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function requireStaff(req, e) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { error: "Missing authorization token." };
  if (!e.url || !e.anon) return { error: "Server auth is not configured." };

  const uRes = await fetch(`${e.url}/auth/v1/user`, {
    headers: { apikey: e.anon, Authorization: `Bearer ${token}` },
  });
  if (!uRes.ok) return { error: "Invalid or expired session." };
  const user = await uRes.json();
  if (!user || !user.id) return { error: "Invalid session." };

  const pRes = await fetch(
    `${e.url}/rest/v1/pl_profiles?id=eq.${encodeURIComponent(user.id)}&select=role`,
    { headers: { apikey: e.anon, Authorization: `Bearer ${token}` } }
  );
  const rows = pRes.ok ? await pRes.json() : [];
  const role = rows && rows[0] && rows[0].role;
  if (!STAFF_ROLES.includes(role)) return { error: "Not permitted." };
  return { user, role };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const e = env();
  if (!e.stripeKey || !e.url || !e.service) {
    return res.status(500).json({ error: "Refunds are not configured on the server." });
  }

  const who = await requireStaff(req, e);
  if (who.error) return res.status(401).json({ error: who.error });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { ledger_id, amount } = body || {};
  if (!ledger_id) return res.status(400).json({ error: "Missing ledger_id." });

  // 1) Load the ledger row being refunded.
  const lRes = await fetch(
    `${e.url}/rest/v1/pl_ledger?id=eq.${encodeURIComponent(ledger_id)}&select=id,student_id,course_id,amount,kind,method,description,stripe_session_id,date`,
    { headers: { apikey: e.service, Authorization: `Bearer ${e.service}` } }
  );
  const lrows = lRes.ok ? await lRes.json() : [];
  const pay = lrows && lrows[0];
  if (!pay) return res.status(404).json({ error: "Payment not found." });
  if (pay.kind !== "payment") return res.status(400).json({ error: "That entry is not a payment." });

  const refundAmount = amount != null ? Number(amount) : Number(pay.amount);
  if (!(refundAmount > 0) || refundAmount > Number(pay.amount) + 0.005) {
    return res.status(400).json({ error: "Refund amount is invalid or exceeds the payment." });
  }

  // 2) If this was a card payment we can trace to Stripe, refund it there.
  //    stripe_session_id is a Checkout Session; resolve it to a payment_intent,
  //    then create the refund against that intent.
  let stripeRefundId = null;
  const isCard = (pay.method === "card" || pay.method === "Stripe") && pay.stripe_session_id;
  if (isCard) {
    try {
      const sRes = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(pay.stripe_session_id)}`,
        { headers: { Authorization: `Bearer ${e.stripeKey}` } }
      );
      const session = await sRes.json();
      const intent = session && session.payment_intent;
      if (!intent) {
        return res.status(400).json({ error: "Could not find the Stripe charge for this payment. Refund it in Stripe directly, then record it manually." });
      }
      const params = new URLSearchParams();
      params.set("payment_intent", intent);
      params.set("amount", String(Math.round(refundAmount * 100))); // cents
      const rRes = await fetch("https://api.stripe.com/v1/refunds", {
        method: "POST",
        headers: { Authorization: `Bearer ${e.stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const refund = await rRes.json();
      if (!rRes.ok) {
        return res.status(400).json({ error: `Stripe refund failed: ${refund.error?.message || "unknown error"}` });
      }
      stripeRefundId = refund.id;
    } catch (err) {
      return res.status(500).json({ error: `Stripe refund error: ${String(err.message || err)}` });
    }
  }

  // 3) Reverse it on the ledger: a negative "payment" (a credit back to the
  //    student), so their balance rises by the refunded amount and the LMS
  //    matches Stripe. Recorded as its own row for a clean audit trail.
  const reversal = {
    student_id: pay.student_id,
    kind: "payment",
    amount: -Math.abs(refundAmount),
    method: isCard ? "card-refund" : "refund",
    description: `Refund of ${pay.description || "payment"}${stripeRefundId ? ` (Stripe ${stripeRefundId})` : ""}`,
    recorded_by: who.user.id,
    date: new Date().toISOString().slice(0, 10),
  };
  if (pay.course_id) reversal.course_id = pay.course_id;

  const insRes = await fetch(`${e.url}/rest/v1/pl_ledger`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: e.service,
      Authorization: `Bearer ${e.service}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(reversal),
  });
  if (!insRes.ok) {
    const t = await insRes.text();
    // The Stripe refund may have succeeded even though the ledger write failed.
    return res.status(500).json({
      error: `Refund was issued in Stripe${stripeRefundId ? ` (${stripeRefundId})` : ""} but the ledger update failed: ${t}. Record a manual adjustment.`,
      stripe_refund_id: stripeRefundId,
    });
  }

  return res.status(200).json({ ok: true, refunded: refundAmount, stripe_refund_id: stripeRefundId, card: isCard });
}
