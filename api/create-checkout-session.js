/* POST /api/create-checkout-session
   Two payment kinds, all amounts computed SERVER-SIDE (never trusted from the browser):

   1) Certificate class:  { course_id, half, student_id, student_email, origin }
        half=true on a 12-week class pays one of two installments (fee / 2);
        otherwise it pays the remaining balance in full.
   2) Degree tuition:     { tuition_level, bucket, plan, student_id, student_email, origin }
        bucket = "registration" | "books" | "tuition"
        Registration and Books always charge whatever's left of that bucket in full.
        "tuition" supports three flexible plans (plan = "full" | "half" | "four"),
        each capped at whatever balance is actually still owed — so a student can
        mix and match (e.g. pay half, then finish the rest in two quarter payments).

   Vercel env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
*/

// Must match the labels in App.jsx PROGRAMS so ledger descriptions line up.
const LEVEL_LABEL = {
  associate: "Associate", bachelor: "Bachelor",
  master: "Master", master2: "Master 2", doctorate: "Doctoral", phd: "PhD",
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

async function sb(path) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { course_id, half, tuition_level, bucket, plan, student_id, student_email, origin } = req.body || {};
    if (!student_id) { res.status(400).json({ error: "Missing student." }); return; }
    const base = origin || `https://${req.headers.host}`;

    let amount = 0;          // dollars to charge now
    let productName = "";
    let metadata = { student_id };
    let successUrl = "";

    if (tuition_level) {
      // -------- Degree tuition: registration / books / tuition installment --------
      const trows = await sb(`pl_tuition?program=eq.${encodeURIComponent(tuition_level)}&select=amount,registration,books`);
      const t = Array.isArray(trows) ? trows[0] : null;
      if (!t) { res.status(404).json({ error: "Tuition isn't set for this level yet." }); return; }

      const label = LEVEL_LABEL[tuition_level] || tuition_level;
      const total = Number(t.amount) || 0;
      const registration = Number(t.registration) || 0;
      const books = Number(t.books) || 0;
      const portion = Math.max(0, round2(total - registration - books));

      const pays = await sb(`pl_ledger?student_id=eq.${student_id}&kind=eq.payment&select=description,amount`);
      const paidFor = (word) => (Array.isArray(pays) ? pays : [])
        .filter((e) => (e.description || "").trim().toLowerCase() === `${label} ${word}`.toLowerCase())
        .reduce((a, e) => a + (Number(e.amount) || 0), 0);

      let word;
      if (bucket === "registration") {
        word = "registration";
        amount = round2(registration - paidFor("registration"));
      } else if (bucket === "books") {
        word = "books";
        amount = round2(books - paidFor("books"));
      } else if (bucket === "tuition") {
        word = "tuition";
        const remaining = round2(portion - paidFor("tuition"));
        const planKey = String(plan || "full").toLowerCase();
        let want;
        if (planKey === "half") want = round2(portion / 2);
        else if (planKey === "four" || planKey === "quarter") want = round2(portion / 4);
        else if (planKey === "seven") want = round2(portion / 7);
        else want = remaining; // "full" — pay off whatever's left
        amount = Math.min(want, remaining);
      } else {
        res.status(400).json({ error: "Unknown payment type." }); return;
      }

      if (amount < 0.5) { res.status(400).json({ error: "Nothing is due on that item." }); return; }
      productName = `${label} ${word}`;
      metadata = { student_id, tuition_level, bucket: word, description: `${label} ${word}` };
      successUrl = `${base}/?tuition_paid=1`;
    } else if (course_id) {
      // -------- Certificate class: full, half, or quarter on a 12-week class --------
      const crows = await sb(`pl_courses?id=eq.${course_id}&select=title,fee,duration_weeks`);
      const course = Array.isArray(crows) ? crows[0] : null;
      if (!course) { res.status(404).json({ error: "Class not found." }); return; }

      const fee = Number(course.fee) || 0;
      const weeks = Number(course.duration_weeks) || 0;
      const pays = await sb(`pl_ledger?student_id=eq.${student_id}&course_id=eq.${course_id}&kind=eq.payment&select=amount`);
      const paid = (Array.isArray(pays) ? pays : []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
      const remaining = round2(fee - paid);

      const planKey = String(plan || (half ? "half" : "full")).toLowerCase();
      let want;
      if (planKey === "half" && weeks >= 12) want = round2(fee / 2);
      else if ((planKey === "quarter" || planKey === "four") && weeks >= 12) want = round2(fee / 4);
      else want = remaining; // full — pay off whatever's left
      amount = Math.min(want, remaining);
      if (amount < 0.5) { res.status(400).json({ error: "This class is already paid in full." }); return; }

      productName = course.title || "Certificate class";
      metadata = { student_id, course_id, title: course.title || "Certificate class" };
      successUrl = `${base}/?cert_paid=1`;
    } else {
      res.status(400).json({ error: "Missing payment details." }); return;
    }

    const cents = Math.round(amount * 100);
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", successUrl);
    params.append("cancel_url", `${base}/?pay_canceled=1`);
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(cents));
    params.append("line_items[0][price_data][product_data][name]", productName);
    for (const [k, v] of Object.entries(metadata)) params.append(`metadata[${k}]`, String(v));
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
