/* POST /api/create-checkout-session
   Every amount is computed SERVER-SIDE from the database (never trusted from the browser).

   1) Certificate class:  { course_id, plan, custom_amount, student_id, student_email, origin }
        plan = "full" | "half" | "quarter" | "custom" | "auto"
        "half"/"quarter" only on classes of 12+ weeks. "auto" = monthly autopay (a Stripe
        subscription) of fee/4 per month until the remaining balance is paid.
   2) Degree tuition:     { tuition_level, bucket, plan, custom_amount, student_id, ... }
        bucket = "registration" | "books" | "tuition"
        tuition plans: "full" | "half" | "four" | "seven" | "custom" | "auto"
        "auto" = monthly autopay of (tuition / installments) until the remainder is paid.
   3) Store item:         { product_id, quantity, student_id, ... }
      Store cart:         { cart: [{ product_id, quantity }], student_id, ... }  (several items, one checkout)
   4) Donation:           { donation: true, amount, donor_name, donor_email, designation, note, origin }
        Needs no account. Recorded in pl_donations by the webhook.

   Card checkouts (not donations) let the payer enter a promo code created on the
   Coupons screen (Stripe promotion codes).

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

/* Build and create a Stripe Checkout Session. */
async function createSession({ mode = "payment", lines, metadata, successUrl, cancelUrl, email, promo = true, extra = {} }) {
  const p = new URLSearchParams();
  p.append("mode", mode);
  p.append("success_url", successUrl);
  p.append("cancel_url", cancelUrl);
  lines.forEach((l, i) => {
    p.append(`line_items[${i}][quantity]`, String(l.qty || 1));
    p.append(`line_items[${i}][price_data][currency]`, "usd");
    p.append(`line_items[${i}][price_data][unit_amount]`, String(l.cents));
    p.append(`line_items[${i}][price_data][product_data][name]`, l.name);
    if (l.pid) p.append(`line_items[${i}][price_data][product_data][metadata][product_id]`, l.pid);
    if (l.monthly) p.append(`line_items[${i}][price_data][recurring][interval]`, "month");
  });
  for (const [k, v] of Object.entries(metadata)) {
    p.append(`metadata[${k}]`, String(v));
    // Autopay: the subscription carries the same tags, so every monthly invoice can be matched.
    if (mode === "subscription") p.append(`subscription_data[metadata][${k}]`, String(v));
  }
  if (promo) p.append("allow_promotion_codes", "true");
  if (email) p.append("customer_email", email);
  for (const [k, v] of Object.entries(extra)) p.append(k, String(v));
  const sr = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: p.toString(),
  });
  const session = await sr.json();
  if (session.error) throw new Error(session.error.message || "Stripe error");
  return session.url;
}

/* Split a balance into N equal monthly payments of about `per` each (at least 2). */
function autopayPlan(remaining, per) {
  if (!(per > 0) || !(remaining > 0)) return null;
  const n = Math.ceil(round2(remaining) / per - 0.0001);
  if (n < 2) return null; // one payment left: just pay it
  const cents = Math.ceil(Math.round(remaining * 100) / n);
  return { n, cents };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const body = req.body || {};
    const { course_id, half, tuition_level, bucket, plan, custom_amount, student_id, student_email, origin, product_id, quantity } = body;
    const base = origin || `https://${req.headers.host}`;
    const cancelUrl = `${base}/?pay_canceled=1`;

    // -------- Donation: no account needed --------
    if (body.donation) {
      const amt = round2(Number(body.amount));
      if (!(amt >= 1)) { res.status(400).json({ error: "Please enter a gift of at least $1." }); return; }
      if (amt > 50000) { res.status(400).json({ error: "For gifts over $50,000, please contact the office." }); return; }
      const name = String(body.donor_name || "").trim().slice(0, 120);
      const email = String(body.donor_email || "").trim().slice(0, 200);
      if (!name || !/^\S+@\S+\.\S+$/.test(email)) { res.status(400).json({ error: "Please enter your name and email for your receipt." }); return; }
      const designation = String(body.designation || "General giving").trim().slice(0, 80);
      const url = await createSession({
        lines: [{ cents: Math.round(amt * 100), name: `Gift: ${designation}` }],
        metadata: { donation: "1", donor_name: name, donor_email: email, designation, note: String(body.note || "").slice(0, 300), student_id: student_id || "", origin: base },
        successUrl: `${base}/?give_thanks=1`, cancelUrl: `${base}/?give=1`, email, promo: false,
        extra: { submit_type: "donate" },
      });
      res.status(200).json({ url });
      return;
    }

    if (!student_id) { res.status(400).json({ error: "Missing student." }); return; }

    // A custom amount, when provided, overrides the plan math. Overpayment is
    // allowed by design, so it is not capped to the remaining balance.
    const customAmt = custom_amount != null && custom_amount !== "" ? round2(Number(custom_amount)) : null;
    const hasCustom = customAmt != null && !isNaN(customAmt) && customAmt >= 0.5;

    // -------- Store cart: several items in one checkout (prices read from the database) --------
    if (Array.isArray(body.cart)) {
      const want = new Map();
      for (const it of body.cart.slice(0, 30)) {
        const id = String(it?.product_id || "").trim();
        if (/^[0-9a-f-]{36}$/i.test(id)) want.set(id, (want.get(id) || 0) + (parseInt(it.quantity, 10) || 1));
      }
      if (!want.size) { res.status(400).json({ error: "Your cart is empty." }); return; }
      const prows = await sb(`pl_store_products?id=in.(${[...want.keys()].join(",")})&active=eq.true&select=id,title,price,shipping_fee,kind,course_id`);
      const prods = Array.isArray(prows) ? prows : [];
      if (prods.length !== want.size) { res.status(409).json({ error: "Something in your cart is no longer available. Please refresh the store." }); return; }
      // Don't sell a download or class the student already owns.
      const mine = await sb(`pl_store_orders?student_id=eq.${encodeURIComponent(student_id)}&status=neq.refunded&select=product_id,kind`);
      const owned = new Set((Array.isArray(mine) ? mine : []).filter((o) => o.kind !== "physical").map((o) => o.product_id));
      const dup = prods.find((p) => p.kind !== "physical" && owned.has(p.id));
      if (dup) { res.status(409).json({ error: `You already own "${dup.title}". Remove it from your cart.` }); return; }
      const lines = [];
      let ship = 0, physical = false;
      for (const p of prods) {
        const unit = Math.round((Number(p.price) || 0) * 100);
        if (unit < 50) { res.status(400).json({ error: `"${p.title}" has no price set.` }); return; }
        const qty = p.kind === "physical" ? Math.min(20, Math.max(1, want.get(p.id))) : 1;
        lines.push({ cents: unit, qty, name: p.title || "Store item", pid: p.id });
        if (p.kind === "physical") { physical = true; ship = Math.max(ship, Math.round((Number(p.shipping_fee) || 0) * 100)); }
      }
      // One shipping charge per order: the highest shipping fee among the shipped items.
      if (ship > 0) lines.push({ cents: ship, name: "Shipping" });
      const count = lines.filter((l) => l.pid).reduce((a, l) => a + l.qty, 0);
      const url = await createSession({
        lines, cancelUrl: `${base}/?store_canceled=1`, email: student_email, successUrl: `${base}/?store_paid=1`,
        metadata: { store: "1", cart: "1", student_id, items: String(prods.length), title: prods.length === 1 ? (prods[0].title || "Store item") : `${count} items`, origin: base },
        extra: physical ? { "shipping_address_collection[allowed_countries][0]": "US" } : {},
      });
      res.status(200).json({ url });
      return;
    }

    // -------- Store purchase (one item): price and shipping always read from the database --------
    if (product_id) {
      const prows = await sb(`pl_store_products?id=eq.${encodeURIComponent(product_id)}&active=eq.true&select=id,title,price,shipping_fee,kind`);
      const p = Array.isArray(prows) ? prows[0] : null;
      if (!p) { res.status(404).json({ error: "That item is no longer available." }); return; }
      const qty = p.kind === "physical" ? Math.min(20, Math.max(1, parseInt(quantity, 10) || 1)) : 1;
      const unit = Math.round((Number(p.price) || 0) * 100);
      const ship = p.kind === "physical" ? Math.round((Number(p.shipping_fee) || 0) * 100) : 0;
      if (unit < 50) { res.status(400).json({ error: "This item has no price set." }); return; }
      const lines = [{ cents: unit, qty, name: p.title || "Store item" }];
      if (ship > 0) lines.push({ cents: ship, name: "Shipping" });
      const url = await createSession({
        lines, cancelUrl, email: student_email, successUrl: `${base}/?store_paid=1`,
        metadata: { store: "1", student_id, product_id: p.id, quantity: qty, kind: p.kind, title: p.title || "Store item", origin: base },
        extra: p.kind === "physical" ? { "shipping_address_collection[allowed_countries][0]": "US" } : {},
      });
      res.status(200).json({ url });
      return;
    }

    let amount = 0;          // dollars to charge now
    let productName = "";
    let metadata = { student_id };
    let successUrl = "";
    let auto = null;         // { n, cents } when the student chose monthly autopay

    if (tuition_level) {
      // -------- Degree tuition: registration / books / tuition installment --------
      const trows = await sb(`pl_tuition?program=eq.${encodeURIComponent(tuition_level)}&select=amount,registration,books,installments`);
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
        amount = hasCustom ? customAmt : round2(registration - paidFor("registration"));
      } else if (bucket === "books") {
        word = "books";
        amount = hasCustom ? customAmt : round2(books - paidFor("books"));
      } else if (bucket === "tuition") {
        word = "tuition";
        const remaining = round2(portion - paidFor("tuition"));
        const planKey = String(plan || "full").toLowerCase();
        if (planKey === "auto") {
          auto = autopayPlan(remaining, round2(portion / (Number(t.installments) || 7)));
          if (!auto) { res.status(400).json({ error: "Autopay needs at least two payments left. Please pay the balance instead." }); return; }
        } else if (hasCustom) {
          amount = customAmt; // overpay allowed
        } else {
          let want;
          if (planKey === "half") want = round2(portion / 2);
          else if (planKey === "four" || planKey === "quarter") want = round2(portion / 4);
          else if (planKey === "seven") want = round2(portion / 7);
          else want = remaining; // "full" — pay off whatever's left
          amount = Math.min(want, remaining);
        }
      } else {
        res.status(400).json({ error: "Unknown payment type." }); return;
      }

      if (!auto && amount < 0.5) { res.status(400).json({ error: "Nothing is due on that item." }); return; }
      productName = `${label} ${word}`;
      metadata = { student_id, tuition_level, bucket: word, description: `${label} ${word}`, plan: auto ? "autopay" : hasCustom ? "custom" : String(plan || "full").toLowerCase(), origin: base };
      successUrl = `${base}/?tuition_paid=1`;
    } else if (course_id) {
      // -------- Certificate class: full, half, quarter, custom or autopay --------
      const crows = await sb(`pl_courses?id=eq.${course_id}&select=title,fee,duration_weeks`);
      const course = Array.isArray(crows) ? crows[0] : null;
      if (!course) { res.status(404).json({ error: "Class not found." }); return; }

      const fee = Number(course.fee) || 0;
      const weeks = Number(course.duration_weeks) || 0;
      const pays = await sb(`pl_ledger?student_id=eq.${student_id}&course_id=eq.${course_id}&kind=eq.payment&select=amount`);
      const paid = (Array.isArray(pays) ? pays : []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
      const remaining = round2(fee - paid);

      const planKey = String(plan || (half ? "half" : "full")).toLowerCase();
      if (planKey === "auto") {
        if (weeks < 12) { res.status(400).json({ error: "Autopay is available on classes of 12 weeks or more." }); return; }
        auto = autopayPlan(remaining, round2(fee / 4));
        if (!auto) { res.status(400).json({ error: "Autopay needs at least two payments left. Please pay the balance instead." }); return; }
      } else if (hasCustom) {
        amount = customAmt; // overpay allowed
      } else {
        let want;
        if (planKey === "half" && weeks >= 12) want = round2(fee / 2);
        else if ((planKey === "quarter" || planKey === "four") && weeks >= 12) want = round2(fee / 4);
        else want = remaining; // full — pay off whatever's left
        amount = Math.min(want, remaining);
      }
      if (!auto && amount < 0.5) { res.status(400).json({ error: "This class is already paid in full." }); return; }

      productName = course.title || "Certificate class";
      metadata = { student_id, course_id, title: course.title || "Certificate class", plan: auto ? "autopay" : hasCustom ? "custom" : planKey, origin: base };
      successUrl = `${base}/?cert_paid=1`;
    } else {
      res.status(400).json({ error: "Missing payment details." }); return;
    }

    let url;
    if (auto) {
      // Monthly autopay: a subscription that the webhook stops after the last payment.
      url = await createSession({
        mode: "subscription", cancelUrl, email: student_email, successUrl,
        lines: [{ cents: auto.cents, name: `${productName}: monthly autopay (${auto.n} payments)`, monthly: true }],
        metadata: { ...metadata, autopay: "1", payments: auto.n },
      });
    } else {
      url = await createSession({
        cancelUrl, email: student_email, successUrl, metadata,
        lines: [{ cents: Math.round(amount * 100), name: productName }],
      });
    }
    res.status(200).json({ url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
