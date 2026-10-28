/* POST /api/stripe-webhook   —  upload this as /api/stripe-webhook.js (replaces the old one)
   Stripe calls this after a successful payment.

   Two paths:
   1) PAY-FIRST REGISTRATION (metadata.signup = "1"): creates the student's LMS
      account, enrolls them, records the registration fee in pl_ledger, and emails
      a "set your password" link. This is how a person goes from a payment on the
      landing page to real access — no account needed beforehand.
   2) Normal in-app payment (tuition / certificate class): records a payment in
      pl_ledger so the student's balance updates, same as before.
   Also: store purchases, refunds (charge.refunded), and disputes
   (charge.dispute.created / charge.dispute.closed). Every event is logged in pl_payment_events.

   In Stripe → Developers → Webhooks, the endpoint must send these events:
     checkout.session.completed, charge.refunded, charge.dispute.created, charge.dispute.closed

   Vercel env vars required:
     STRIPE_WEBHOOK_SECRET        (whsec_... from the webhook you create in Stripe)
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY
     STRIPE_SECRET_KEY            (to look up refunds and disputes)
   Optional:
     ADMIN_ALERT_EMAIL            (office alert addresses, comma-separated)
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

  let event;
  try {
    const sig = req.headers["stripe-signature"] || "";
    const buf = await rawBody(req);
    const parts = Object.fromEntries(sig.split(",").map((kv) => kv.split("=")));
    const signedPayload = `${parts.t}.${buf.toString("utf8")}`;
    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
    let ok = false;
    try { ok = !!parts.v1 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1)); } catch { ok = false; }
    // Reject stale signatures (older than 5 minutes) so a captured request can't be replayed later.
    const age = Math.abs(Date.now() / 1000 - Number(parts.t || 0));
    if (!ok || !(age < 300)) { console.error("stripe-webhook: invalid or stale signature"); res.status(400).send("Invalid signature"); return; }
    event = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    console.error("stripe-webhook: could not read event", e);
    res.status(400).send("Bad request");
    return;
  }

  const log = eventLog(supaUrl, serviceKey, event);
  const first = await log.start();
  if (first === "already_processed") { res.status(200).json({ received: true, duplicate_event: event.id }); return; }

  try {
    let out;
    if (event.type === "checkout.session.completed") out = await handleCheckout({ supaUrl, serviceKey, s: event.data.object || {} });
    else if (event.type === "charge.refunded") out = await handleRefund({ supaUrl, serviceKey, charge: event.data.object || {} });
    else if (event.type === "charge.dispute.created") out = await handleDispute({ supaUrl, serviceKey, dispute: event.data.object || {}, opened: true });
    else if (event.type === "charge.dispute.closed") out = await handleDispute({ supaUrl, serviceKey, dispute: event.data.object || {}, opened: false });
    else out = { code: 200, body: { received: true, ignored: event.type }, status: "ignored" };

    await log.finish(out.status || (out.code < 300 ? "processed" : "failed"), out.note || null, out.error || null, out.meta || {});
    res.status(out.code).json(out.body);
  } catch (e) {
    console.error("stripe-webhook: unhandled error", e);
    await log.finish("failed", null, String(e.message || e), {});
    res.status(500).send(String(e.message || e)); // Stripe retries failed deliveries automatically
  }
}

/* ---------------- PAYMENT EVENT LOG ----------------
   Every Stripe event is saved in pl_payment_events. A retried event that already
   processed is skipped; a failed one is processed again on Stripe's retry. */
function eventLog(supaUrl, serviceKey, event) {
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const url = `${supaUrl}/rest/v1/pl_payment_events`;
  const id = encodeURIComponent(event.id || "");
  const obj = event.data?.object || {};
  return {
    async start() {
      try {
        const r = await fetch(`${url}?stripe_event_id=eq.${id}&select=status`, { headers: h }).then((x) => x.json());
        if (Array.isArray(r) && r[0]) return ["processed", "ignored"].includes(r[0].status) ? "already_processed" : "retry";
        await fetch(url, { method: "POST", headers: { ...h, Prefer: "return=minimal,resolution=ignore-duplicates" }, body: JSON.stringify({
          stripe_event_id: event.id, type: event.type || "unknown", status: "received",
          session_id: obj.object === "checkout.session" ? obj.id : null,
          payment_intent: typeof obj.payment_intent === "string" ? obj.payment_intent : null,
          amount: obj.amount_total != null ? obj.amount_total / 100 : obj.amount != null ? obj.amount / 100 : null,
          payload: event,
        }) });
      } catch (e) { console.error("event log start failed (non-fatal)", e); }
      return "new";
    },
    async finish(status, note, error, meta) {
      try {
        await fetch(`${url}?stripe_event_id=eq.${id}`, { method: "PATCH", headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify({
          status, note, error, processed_at: new Date().toISOString(), ...(meta || {}),
        }) });
      } catch (e) { console.error("event log finish failed (non-fatal)", e); }
    },
  };
}

/* ---------------- CHECKOUT COMPLETED ---------------- */
async function handleCheckout({ supaUrl, serviceKey, s }) {
  const md = s.metadata || {};
  const amount = (s.amount_total || 0) / 100;
  const sessionId = s.id || null;
  const sessionEmail = s.customer_details?.email || s.customer_email || null;
  const meta = { session_id: sessionId, payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : null, amount };

  if (s.payment_status && s.payment_status !== "paid") {
    return { code: 200, body: { received: true, ignored: `payment_status=${s.payment_status}` }, status: "ignored", note: `payment_status=${s.payment_status}`, meta };
  }

  // PATH 1: pay-first registration
  if (md.signup === "1") {
    const result = await provisionSignup({ supaUrl, serviceKey, md, amount, sessionId, sessionEmail });
    console.log("stripe-webhook: signup provisioned", { sessionId, result });
    return { code: 200, body: { received: true, signup: result }, note: `signup ${typeof result === "string" ? result : result.email}`, meta };
  }

  // PATH 1b: store purchase
  if (md.store === "1") {
    const result = await recordStoreOrder({ supaUrl, serviceKey, s, md, amount, sessionId, sessionEmail });
    console.log("stripe-webhook: store order", { sessionId, result });
    return { code: 200, body: { received: true, store: result }, note: `store ${typeof result === "string" ? result : result.title}`, meta };
  }

  // PATH 2: normal in-app payment
  let row = null;
  if (md.tuition_level && md.student_id) {
    row = { student_id: md.student_id, kind: "payment", description: md.description || `${md.tuition_level} tuition`, amount, method: "card", plan: md.plan || null, recorded_by: md.student_id };
  } else if (md.course_id && md.student_id) {
    row = { student_id: md.student_id, course_id: md.course_id, kind: "payment", description: md.title ? `Certificate class: ${md.title}` : "Certificate class payment", amount, method: "card", plan: md.plan || null, recorded_by: md.student_id };
  }
  if (!row) {
    console.error("stripe-webhook: no usable metadata on session", sessionId, md);
    return { code: 200, body: { received: true, ignored: "missing metadata" }, status: "ignored", note: "no LMS metadata on this payment", meta };
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
    if (r.status === 409 || text.includes("23505")) return { code: 200, body: { received: true, duplicate: sessionId }, note: "already recorded", meta };
    console.error("stripe-webhook: ledger insert failed", r.status, text, row);
    return { code: 500, body: { error: "Ledger insert failed" }, error: `ledger insert failed: ${r.status} ${text}`, meta };
  }

  console.log("stripe-webhook: posted payment", { sessionId, student: md.student_id, amount });
  try { await sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail }); }
  catch (e) { console.error("stripe-webhook: receipt email failed (non-fatal)", e); }
  return { code: 200, body: { received: true, posted: amount }, note: `payment ${amount}`, meta };
}

/* ---------------- REFUNDS ----------------
   Fires for refunds made anywhere: the LMS Refund button OR the Stripe dashboard.
   Each refund is written to the ledger once (unique stripe_refund_id), and a fully
   refunded store order is marked refunded, which locks its download. */
async function stripeGet(path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path}: ${j.error?.message || r.status}`);
  return j;
}
function rest(supaUrl, serviceKey) {
  return (path, opts = {}) => fetch(`${supaUrl}/rest/v1/${path}`, {
    ...opts, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}
async function findSession(pi) {
  if (!pi) return null;
  const list = await stripeGet(`checkout/sessions?payment_intent=${encodeURIComponent(pi)}&limit=1`);
  return (list.data || [])[0] || null;
}

async function handleRefund({ supaUrl, serviceKey, charge }) {
  const db = rest(supaUrl, serviceKey);
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const meta = { payment_intent: pi || null, amount: (charge.amount_refunded || 0) / 100 };
  if (!process.env.STRIPE_SECRET_KEY) return { code: 500, body: { error: "STRIPE_SECRET_KEY not set" }, error: "STRIPE_SECRET_KEY not set", meta };

  const session = await findSession(pi);
  if (!session) return { code: 200, body: { received: true, ignored: "refund not from an LMS checkout" }, status: "ignored", note: "no checkout session for this charge", meta };
  meta.session_id = session.id;
  const sid = encodeURIComponent(session.id);
  const fullyRefunded = (charge.amount_refunded || 0) >= (charge.amount || 0);

  const pays = await db(`pl_ledger?stripe_session_id=eq.${sid}&kind=eq.payment&select=student_id,course_id,description`).then((r) => r.json()).catch(() => []);
  const pay = Array.isArray(pays) ? pays[0] : null;
  const orders = await db(`pl_store_orders?stripe_session_id=eq.${sid}&select=id,title,kind,status,student_id`).then((r) => r.ok ? r.json() : []).catch(() => []);
  const order = Array.isArray(orders) ? orders[0] : null;

  const refunds = await stripeGet(`refunds?payment_intent=${encodeURIComponent(pi)}&limit=100`);
  let posted = 0;
  if (pay) {
    for (const rf of refunds.data || []) {
      if (rf.status !== "succeeded") continue;
      const row = {
        student_id: pay.student_id, kind: "payment", amount: -Math.abs(rf.amount / 100), method: "card-refund",
        description: `Refund of ${pay.description || "payment"} (Stripe ${rf.id})`, date: new Date().toISOString().slice(0, 10), stripe_refund_id: rf.id,
      };
      if (pay.course_id) row.course_id = pay.course_id;
      const r = await db(`pl_ledger`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      if (r.ok) posted++;
      else { const t = await r.text(); if (!(r.status === 409 || t.includes("23505"))) throw new Error(`refund ledger insert failed: ${r.status} ${t}`); }
    }
  }
  if (order && fullyRefunded && order.status !== "refunded") {
    await db(`pl_store_orders?id=eq.${order.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "refunded" }) });
  }
  if (posted || (order && fullyRefunded)) {
    try {
      await sendOfficeNote(`Refund recorded: ${money(charge.amount_refunded / 100)}`,
        `<p>A refund of <b>${money(charge.amount_refunded / 100)}</b>${fullyRefunded ? " (full)" : " (partial)"} went through in Stripe and the LMS has been updated.</p>
         <p><b>For:</b> ${esc(order?.title || pay?.description || "payment")}</p>
         ${order?.kind === "digital" && fullyRefunded ? "<p>The download is now locked for this buyer.</p>" : ""}
         ${(order?.kind === "course" || pay?.course_id) && fullyRefunded ? "<p>The student is still enrolled in the class. Remove the enrollment in Cert Classes if they should lose access.</p>" : ""}
         ${order?.kind === "physical" && order.status !== "shipped" ? "<p>This item had not shipped yet. Don't ship it.</p>" : ""}`);
    } catch (e) { console.error("refund office note failed (non-fatal)", e); }
  }
  return { code: 200, body: { received: true, refunds_posted: posted }, note: `refund: ${posted} ledger row(s)${order && fullyRefunded ? ", order refunded" : ""}`, meta };
}

/* ---------------- DISPUTES (chargebacks) ----------------
   Opened: lock the store order and alert the office with the evidence deadline.
   Closed: won -> unlock; lost -> record the loss on the ledger and mark refunded. */
async function handleDispute({ supaUrl, serviceKey, dispute, opened }) {
  const db = rest(supaUrl, serviceKey);
  const pi = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  const amt = (dispute.amount || 0) / 100;
  const meta = { payment_intent: pi || null, amount: amt };
  const session = process.env.STRIPE_SECRET_KEY ? await findSession(pi).catch(() => null) : null;
  if (session) meta.session_id = session.id;
  const sid = session ? encodeURIComponent(session.id) : null;
  const orders = sid ? await db(`pl_store_orders?stripe_session_id=eq.${sid}&select=id,title,status`).then((r) => r.ok ? r.json() : []).catch(() => []) : [];
  const order = Array.isArray(orders) ? orders[0] : null;
  const pays = sid ? await db(`pl_ledger?stripe_session_id=eq.${sid}&kind=eq.payment&select=student_id,course_id,description`).then((r) => r.json()).catch(() => []) : [];
  const pay = Array.isArray(pays) ? pays[0] : null;
  const what = esc(order?.title || pay?.description || session?.metadata?.title || "a payment");

  if (opened) {
    if (order && order.status !== "refunded") await db(`pl_store_orders?id=eq.${order.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "disputed" }) });
    const due = dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString("en-US", { dateStyle: "full" }) : "soon";
    await sendOfficeNote(`URGENT: payment disputed (${money(amt)})`,
      `<p>A customer's bank has disputed <b>${money(amt)}</b> for <b>${what}</b>. Reason given: <b>${esc(dispute.reason || "not given")}</b>.</p>
       <p><b>Respond in Stripe by ${esc(due)}</b> (Payments → Disputes). Upload proof: the receipt, enrollment or download records, and any messages with the student. If you don't respond, the dispute is lost automatically.</p>
       ${order ? "<p>The store order is locked while the dispute is open.</p>" : ""}`).catch((e) => console.error("dispute alert failed", e));
    return { code: 200, body: { received: true, dispute: "opened" }, note: `dispute opened (${dispute.reason || "?"})`, meta };
  }

  const won = dispute.status === "won";
  if (won) {
    if (order && order.status === "disputed") await db(`pl_store_orders?id=eq.${order.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "paid" }) });
  } else {
    if (order) await db(`pl_store_orders?id=eq.${order.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "refunded" }) });
    if (pay) {
      const row = { student_id: pay.student_id, kind: "payment", amount: -Math.abs(amt), method: "card-refund", description: `Chargeback lost: ${pay.description || "payment"} (Stripe ${dispute.id})`, date: new Date().toISOString().slice(0, 10), stripe_refund_id: dispute.id };
      if (pay.course_id) row.course_id = pay.course_id;
      const r = await db(`pl_ledger`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      if (!r.ok) { const t = await r.text(); if (!(r.status === 409 || t.includes("23505"))) throw new Error(`dispute ledger insert failed: ${r.status} ${t}`); }
    }
  }
  await sendOfficeNote(`Dispute ${won ? "WON" : "closed"}: ${money(amt)}`,
    `<p>The dispute for <b>${what}</b> (${money(amt)}) is closed: <b>${esc(dispute.status)}</b>.</p>
     <p>${won ? "The money stays with the ministry and the order is unlocked." : "The money was returned to the customer. The LMS ledger has been updated."}</p>`).catch((e) => console.error("dispute close note failed", e));
  return { code: 200, body: { received: true, dispute: dispute.status }, note: `dispute closed: ${dispute.status}`, meta };
}

/* Small helpers shared by the office notes. */
function esc(t) { return String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
function money(n) { return "$" + (Number(n) || 0).toFixed(2); }
async function sendOfficeNote(subject, bodyHtml) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const to = (process.env.ADMIN_ALERT_EMAIL || "admin@nctspurelight.com, elainethomasbenson@yahoo.com").split(",").map((x) => x.trim()).filter(Boolean);
  if (!to.length) return;
  const from = process.env.EMAIL_FROM || "The Healed Place <onboarding@resend.dev>";
  const school = process.env.VITE_SCHOOL_NAME || "YonaLearn";
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,serif;color:#1a1a1a;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
      <div style="background:#1B3A6B;padding:18px 24px;text-align:center;color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">${esc(school).toUpperCase()}</div>
      <div style="padding:24px;font-size:14px;line-height:1.6;">${bodyHtml}</div></div></body></html>`;
  await sendResend(apiKey, "office note", { from, to, subject: `[${school}] ${subject}`, html });
}

/* ---------------- STORE ORDERS ---------------- */
async function recordStoreOrder({ supaUrl, serviceKey, s, md, amount, sessionId, sessionEmail }) {
  const rest = (path, opts = {}) => fetch(`${supaUrl}/rest/v1/${path}`, {
    ...opts, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!md.student_id || !md.product_id) throw new Error("store session missing student/product");

  const prows = await rest(`pl_store_products?id=eq.${encodeURIComponent(md.product_id)}&select=id,title,kind,course_id`).then((r) => r.json()).catch(() => null);
  const p = Array.isArray(prows) ? prows[0] : null;
  const kind = p?.kind || md.kind || "digital";
  const title = p?.title || md.title || "Store item";
  const sd = s.collected_information?.shipping_details || s.shipping_details || null;
  const shipping = sd ? { name: sd.name || null, address: sd.address || null } : null;

  // 1) The order (unique on stripe_session_id, so a Stripe retry never doubles it).
  const ins = await rest(`pl_store_orders`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
    student_id: md.student_id, product_id: md.product_id, title, kind, quantity: Number(md.quantity) || 1, amount,
    status: "paid", shipping, stripe_session_id: sessionId,
  }) });
  if (!ins.ok) {
    const t = await ins.text();
    if (ins.status === 409 || t.includes("23505")) return "duplicate";
    throw new Error(`order insert failed: ${ins.status} ${t}`);
  }

  // 2) Course purchases: enroll the student and record the payment on that class.
  if (kind === "course" && p?.course_id) {
    await rest(`pl_cert_enrollments`, { method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" }, body: JSON.stringify({ student_id: md.student_id, course_id: p.course_id }) }).catch(() => {});
    const led = await rest(`pl_ledger`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ student_id: md.student_id, course_id: p.course_id, kind: "payment", description: `Store: ${title}`, amount, method: "card", date: new Date().toISOString().slice(0, 10), stripe_session_id: sessionId, recorded_by: md.student_id }) });
    if (!led.ok) { const t = await led.text(); if (!(led.status === 409 || t.includes("23505"))) console.error("store ledger insert failed", led.status, t); }
  }

  // 3) Emails: buyer receipt + office alert (both non-fatal).
  let name = "Student", acctEmail = null;
  try {
    const rows = await rest(`pl_profiles?id=eq.${encodeURIComponent(md.student_id)}&select=full_name,email`).then((r) => r.json());
    if (Array.isArray(rows) && rows[0]) { name = rows[0].full_name || name; acctEmail = rows[0].email || null; }
  } catch (e) { /* defaults */ }
  try { await sendStoreEmails({ name, to: [...new Set([acctEmail, sessionEmail].filter(Boolean))], title, kind, quantity: Number(md.quantity) || 1, amount, shipping }); }
  catch (e) { console.error("store emails failed (non-fatal)", e); }
  return { title, kind };
}

async function sendStoreEmails({ name, to, title, kind, quantity, amount, shipping }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const from = process.env.EMAIL_FROM || "The Healed Place <onboarding@resend.dev>";
  const school = process.env.VITE_SCHOOL_NAME || "The Healed Place";
  const appUrl = process.env.APP_URL || "https://thehealedplace.org";
  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const money = (n) => "$" + (Number(n) || 0).toFixed(2);
  const a = shipping?.address || null;
  const addr = a ? [shipping.name, a.line1, a.line2, `${a.city || ""}, ${a.state || ""} ${a.postal_code || ""}`].filter(Boolean).map(esc).join("<br>") : "";
  const next = kind === "digital" ? "Your download is ready now. Sign in and open <b>Store → My purchases</b>."
    : kind === "course" ? "You're enrolled. Sign in and the class will be in your portal."
    : "We'll ship your order soon and let you know when it's on the way.";
  const shell = (body) => `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,serif;color:#1a1a1a;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
      <div style="background:#1B3A6B;padding:18px 24px;text-align:center;color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">${esc(school).toUpperCase()}</div>
      <div style="padding:24px;font-size:14px;line-height:1.6;">${body}</div></div></body></html>`;
  const detail = `<p><b>Item:</b> ${esc(title)}${quantity > 1 ? ` × ${quantity}` : ""}<br><b>Paid:</b> ${money(amount)}</p>${addr ? `<p><b>Ship to:</b><br>${addr}</p>` : ""}`;

  if (to.length) {
    await sendResend(apiKey, "store receipt", { from, to, subject: `Your order: ${title}`, html: shell(
      `<h1 style="font-size:20px;color:#1B3A6B;margin:0 0 8px;">Thank you, ${esc(name)}!</h1>${detail}<p>${next}</p><p><a href="${appUrl}" style="color:#1B3A6B;">${esc(appUrl)}</a></p>`) });
  }
  const office = (process.env.ADMIN_ALERT_EMAIL || "admin@nctspurelight.com, elainethomasbenson@yahoo.com").split(",").map((x) => x.trim()).filter(Boolean);
  if (office.length) {
    await sendResend(apiKey, "store office alert", { from, to: office, subject: `Store order: ${title} (${money(amount)})${kind === "physical" ? " — needs shipping" : ""}`, html: shell(
      `<h1 style="font-size:19px;color:#1B3A6B;margin:0 0 8px;">New store order</h1><p><b>Buyer:</b> ${esc(name)} (${esc(to[0] || "")})</p>${detail}${kind === "physical" ? "<p>Mark it shipped in <b>Store → Orders</b> once it's mailed.</p>" : ""}`) });
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
