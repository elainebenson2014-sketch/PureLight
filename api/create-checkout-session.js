/* POST /api/create-checkout-session
   Body: { course_id, student_id, student_email, origin }
   Looks up the class fee server-side (so the amount can't be tampered with),
   creates a Stripe Checkout session, and returns its URL.
   No npm packages required — calls Stripe + Supabase over HTTPS directly.

   Vercel env vars required:
     STRIPE_SECRET_KEY            (sk_test_... while testing, sk_live_... when live)
     SUPABASE_URL                 (e.g. https://pwknzzrmxotffdwkkecn.supabase.co)
     SUPABASE_SERVICE_ROLE_KEY    (Supabase -> Settings -> API -> service_role key)
*/
export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { course_id, student_id, student_email, origin } = req.body || {};
    if (!course_id || !student_id) { res.status(400).json({ error: "Missing class or student." }); return; }

    // authoritative fee + title from the database
    const cr = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pl_courses?id=eq.${course_id}&select=title,fee,is_certificate`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    const rows = await cr.json();
    const course = Array.isArray(rows) ? rows[0] : null;
    if (!course) { res.status(404).json({ error: "Class not found." }); return; }

    const cents = Math.round(Number(course.fee || 0) * 100);
    if (cents < 50) { res.status(400).json({ error: "This class has no fee to pay." }); return; }

    const base = origin || `https://${req.headers.host}`;
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", `${base}/?cert_paid=1`);
    params.append("cancel_url", `${base}/?cert_canceled=1`);
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(cents));
    params.append("line_items[0][price_data][product_data][name]", course.title || "Certificate class");
    params.append("metadata[course_id]", course_id);
    params.append("metadata[student_id]", student_id);
    params.append("metadata[title]", course.title || "Certificate class");
    if (student_email) params.append("customer_email", student_email);

    const sr = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const session = await sr.json();
    if (session.error) { res.status(400).json({ error: session.error.message || "Stripe error" }); return; }
    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
