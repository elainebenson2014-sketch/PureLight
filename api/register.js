/* POST /api/register
   PAY-FIRST registration. Creates a Stripe Checkout session for the REGISTRATION
   FEE only (certificate $50, degree $125). All amounts are computed SERVER-SIDE —
   never trusted from the browser. On successful payment, /api/stripe-webhook
   provisions the student's account, enrolls them, records the fee in pl_ledger,
   and emails a "set your password" link.

   Body (JSON):
     program     "certificate" | "associate" | "bachelor" | "master" | "master2" | "doctorate" | "phd"
     course_id   (certificate only) the course to enroll in, e.g. Fully Known
     name        full name
     email       email address
     origin      (optional) the site the button lives on, used for success/cancel URLs

   Vercel env vars: STRIPE_SECRET_KEY
*/

// Registration fee by program. Degree = $125, certificate (Fully Known) = $50.
const REG_FEE = {
  certificate: 50,
  associate: 125, bachelor: 125, master: 125, master2: 125, doctorate: 125, phd: 125,
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const { program, course_id, name, email, origin } = req.body || {};
    const nm = String(name || "").trim();
    const em = String(email || "").trim();
    if (!nm || !em || !em.includes("@")) {
      res.status(400).json({ error: "Please enter your full name and a valid email." });
      return;
    }
    const prog = String(program || "certificate").toLowerCase();
    const fee = REG_FEE[prog];
    if (!fee) { res.status(400).json({ error: "Unknown program." }); return; }

    const base = origin || `https://${req.headers.host}`;
    const cents = Math.round(fee * 100);
    const productName = prog === "certificate"
      ? "Fully Known — Registration Fee"
      : "NCTS — Registration Fee";

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", `${base}/?registered=1`);
    params.append("cancel_url", `${base}/?reg_canceled=1`);
    params.append("customer_email", em);
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(cents));
    params.append("line_items[0][price_data][product_data][name]", productName);
    // Metadata the webhook reads to provision the account:
    params.append("metadata[signup]", "1");
    params.append("metadata[reg_program]", prog);
    params.append("metadata[reg_name]", nm);
    params.append("metadata[reg_email]", em);
    if (course_id) params.append("metadata[reg_course_id]", String(course_id));

    const sr = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const session = await sr.json();
    if (session.error) { res.status(400).json({ error: session.error.message || "Stripe error" }); return; }
    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
