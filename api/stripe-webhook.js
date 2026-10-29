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
     checkout.session.completed, charge.refunded, charge.dispute.created, charge.dispute.closed,
     invoice.paid, invoice.payment_failed, customer.subscription.deleted   (for autopay)

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
    const hosts = schoolHosts(req);
    if (event.type === "checkout.session.completed") out = await handleCheckout({ supaUrl, serviceKey, s: event.data.object || {}, hosts });
    else if (event.type === "charge.refunded") out = await handleRefund({ supaUrl, serviceKey, charge: event.data.object || {}, hosts });
    else if (event.type === "charge.dispute.created") out = await handleDispute({ supaUrl, serviceKey, dispute: event.data.object || {}, opened: true, hosts });
    else if (event.type === "charge.dispute.closed") out = await handleDispute({ supaUrl, serviceKey, dispute: event.data.object || {}, opened: false, hosts });
    else if (event.type === "invoice.paid") out = await handleInvoicePaid({ supaUrl, serviceKey, invoice: event.data.object || {}, hosts });
    else if (event.type === "invoice.payment_failed") out = await handleInvoiceFailed({ supaUrl, serviceKey, invoice: event.data.object || {}, hosts });
    else if (event.type === "customer.subscription.deleted") out = await handleSubscriptionEnded({ supaUrl, serviceKey, sub: event.data.object || {} });
    else out = { code: 200, body: { received: true, ignored: event.type }, status: "ignored" };

    await log.finish(out.status || (out.code < 300 ? "processed" : "failed"), out.note || null, out.error || null, out.meta || {});
    res.status(out.code).json(out.body);
  } catch (e) {
    console.error("stripe-webhook: unhandled error", e);
    await log.finish("failed", null, String(e.message || e), {});
    res.status(500).send(String(e.message || e)); // Stripe retries failed deliveries automatically
  }
}

/* ---------------- WHICH SCHOOL DOES A PAYMENT BELONG TO? ----------------
   Several schools can share one Stripe account, and Stripe sends every event to
   every webhook on that account. Each school only handles its own payments:
     1) a payment for a student who exists in THIS school's database, or
     2) a registration for a class that exists in THIS school's database, or
     3) otherwise, a checkout that started on THIS school's web address.
   Everything else is skipped (answered 200 so Stripe doesn't retry it here).
   Optional env SCHOOL_HOSTS = extra web addresses for this school, comma-separated. */
function hostOf(u) { try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function schoolHosts(req) {
  const list = [req?.headers?.["x-forwarded-host"], req?.headers?.host, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL, process.env.APP_URL, ...(process.env.SCHOOL_HOSTS || "").split(",")];
  return new Set(list.filter(Boolean).map((h) => hostOf(/^https?:/.test(h.trim()) ? h.trim() : `https://${h.trim()}`)).filter(Boolean));
}
async function belongsHere({ supaUrl, serviceKey, session, hosts }) {
  const md = session?.metadata || {};
  const get = (path) => fetch(`${supaUrl}/rest/v1/${path}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  // The web address the checkout started on decides first: schools copied from each
  // other can share course IDs, so a matching course alone is not proof.
  const h = hostOf(session?.success_url || "");
  if (h && hosts.has(h)) return true;
  if (h && !h.endsWith(".vercel.app")) return false; // started on another school's address
  // No address, or a temporary vercel.app address: fall back to this school's records.
  if (md.student_id) return (await get(`pl_profiles?id=eq.${encodeURIComponent(md.student_id)}&select=id`)).length > 0;
  if (md.reg_course_id) return (await get(`pl_courses?id=eq.${encodeURIComponent(md.reg_course_id)}&select=id`)).length > 0;
  return false;
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
async function handleCheckout({ supaUrl, serviceKey, s, hosts }) {
  const md = s.metadata || {};
  const amount = (s.amount_total || 0) / 100;
  const sessionId = s.id || null;
  const sessionEmail = s.customer_details?.email || s.customer_email || null;
  const meta = { session_id: sessionId, payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : null, amount };

  if (s.mode !== "subscription" && s.payment_status && s.payment_status !== "paid") {
    return { code: 200, body: { received: true, ignored: `payment_status=${s.payment_status}` }, status: "ignored", note: `payment_status=${s.payment_status}`, meta };
  }
  if (!(await belongsHere({ supaUrl, serviceKey, session: s, hosts }))) {
    return { code: 200, body: { received: true, ignored: "another school" }, status: "ignored", note: "payment belongs to another school on this Stripe account", meta };
  }

  // PATH 0: monthly autopay was set up. Each monthly payment is recorded by invoice.paid.
  if (s.mode === "subscription") {
    const result = await startAutopay({ supaUrl, serviceKey, s, md });
    return { code: 200, body: { received: true, autopay: result }, note: `autopay set up: ${result}`, meta };
  }

  // PATH 0b: donation
  if (md.donation === "1") {
    const result = await recordDonation({ supaUrl, serviceKey, s, md, amount, sessionId });
    return { code: 200, body: { received: true, donation: result }, note: `donation ${money(amount)} ${result}`, meta };
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
  const row = ledgerRowFor(md, amount);
  if (!row) {
    console.error("stripe-webhook: no usable metadata on session", sessionId, md);
    return { code: 200, body: { received: true, ignored: "missing metadata" }, status: "ignored", note: "no LMS metadata on this payment", meta };
  }
  row.stripe_session_id = sessionId;
  const ins = await insertLedger(supaUrl, serviceKey, row);
  if (ins === "duplicate") return { code: 200, body: { received: true, duplicate: sessionId }, note: "already recorded", meta };
  if (ins !== "ok") return { code: 500, body: { error: "Ledger insert failed" }, error: ins, meta };

  console.log("stripe-webhook: posted payment", { sessionId, student: md.student_id, amount });
  try { await sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail }); }
  catch (e) { console.error("stripe-webhook: receipt email failed (non-fatal)", e); }
  return { code: 200, body: { received: true, posted: amount }, note: `payment ${amount}`, meta };
}

/* The ledger row for a tuition or class payment, from the checkout/subscription tags. */
function ledgerRowFor(md, amount) {
  const date = new Date().toISOString().slice(0, 10);
  if (md.tuition_level && md.student_id) {
    return { student_id: md.student_id, kind: "payment", description: md.description || `${md.tuition_level} tuition`, amount, method: "card", plan: md.plan || null, recorded_by: md.student_id, date };
  }
  if (md.course_id && md.student_id) {
    return { student_id: md.student_id, course_id: md.course_id, kind: "payment", description: md.title ? `Certificate class: ${md.title}` : "Certificate class payment", amount, method: "card", plan: md.plan || null, recorded_by: md.student_id, date };
  }
  return null;
}
async function insertLedger(supaUrl, serviceKey, row) {
  const r = await fetch(`${supaUrl}/rest/v1/pl_ledger`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (r.ok) return "ok";
  const text = await r.text();
  if (r.status === 409 && text.includes("23505")) return "duplicate";
  console.error("stripe-webhook: ledger insert failed", r.status, text, row);
  return `ledger insert failed: ${r.status} ${text}`;
}

/* ---------------- STRIPE HELPERS ----------------
   Lookups pin an older API version so the fields we read (charge.invoice,
   invoice.subscription, subscription.metadata) are always present. */
const PIN = "2024-06-20";
async function stripeGet(path, pinned = false) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(pinned ? { "Stripe-Version": PIN } : {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path}: ${j.error?.message || r.status}`);
  return j;
}
async function stripePost(path, params) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": PIN },
    body: new URLSearchParams(params).toString(),
  });
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
/* Which LMS record does a charge belong to? A checkout session (one-time payments,
   store, donations) or an invoice (autopay). Returns { key, session, invoice }. */
async function paymentKey(pi, chargeId) {
  const session = await findSession(pi).catch(() => null);
  if (session) return { key: session.id, session };
  if (!chargeId) return { key: null };
  const ch = await stripeGet(`charges/${encodeURIComponent(chargeId)}`, true).catch(() => null);
  const invId = ch && (typeof ch.invoice === "string" ? ch.invoice : ch.invoice?.id);
  return invId ? { key: invId, invoice: invId } : { key: null };
}

/* ---------------- REFUNDS ----------------
   Fires for refunds made anywhere: the LMS Refund button OR the Stripe dashboard.
   Each refund is written to the ledger once (unique stripe_refund_id); a fully
   refunded store order or donation is marked refunded (a download locks). */
async function handleRefund({ supaUrl, serviceKey, charge, hosts }) {
  const db = rest(supaUrl, serviceKey);
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const meta = { payment_intent: pi || null, amount: (charge.amount_refunded || 0) / 100 };
  if (!process.env.STRIPE_SECRET_KEY) return { code: 500, body: { error: "STRIPE_SECRET_KEY not set" }, error: "STRIPE_SECRET_KEY not set", meta };

  const { key } = await paymentKey(pi, charge.id);
  if (!key) return { code: 200, body: { received: true, ignored: "refund not from an LMS payment" }, status: "ignored", note: "no checkout session or autopay invoice for this charge", meta };
  meta.session_id = key;
  const k = encodeURIComponent(key);
  const fullyRefunded = (charge.amount_refunded || 0) >= (charge.amount || 0);

  const pays = await db(`pl_ledger?stripe_session_id=eq.${k}&kind=eq.payment&select=student_id,course_id,description`).then((r) => r.json()).catch(() => []);
  const pay = Array.isArray(pays) ? pays[0] : null;
  const orders = await db(`pl_store_orders?stripe_session_id=eq.${k}&select=id,title,kind,status,student_id`).then((r) => r.ok ? r.json() : []).catch(() => []);
  const order = Array.isArray(orders) ? orders[0] : null;
  const gifts = await db(`pl_donations?stripe_session_id=eq.${k}&select=id,status,designation`).then((r) => r.ok ? r.json() : []).catch(() => []);
  const gift = Array.isArray(gifts) ? gifts[0] : null;

  let posted = 0;
  if (pay && pi) {
    const refunds = await stripeGet(`refunds?payment_intent=${encodeURIComponent(pi)}&limit=100`);
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
  if (gift && gift.status !== "refunded") {
    await db(`pl_donations?id=eq.${gift.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: fullyRefunded ? "refunded" : "partly_refunded", refunded_amount: (charge.amount_refunded || 0) / 100 }) });
  }
  if (posted || (order && fullyRefunded) || gift) {
    try {
      await sendOfficeNote(`Refund recorded: ${money(charge.amount_refunded / 100)}`,
        `<p>A refund of <b>${money(charge.amount_refunded / 100)}</b>${fullyRefunded ? " (full)" : " (partial)"} went through in Stripe and the LMS has been updated.</p>
         <p><b>For:</b> ${esc(order?.title || pay?.description || (gift ? `Gift: ${gift.designation}` : "payment"))}</p>
         ${order?.kind === "digital" && fullyRefunded ? "<p>The download is now locked for this buyer.</p>" : ""}
         ${(order?.kind === "course" || pay?.course_id) && fullyRefunded ? "<p>The student is still enrolled in the class. Remove the enrollment in Cert Classes if they should lose access.</p>" : ""}
         ${order?.kind === "physical" && order.status !== "shipped" ? "<p>This item had not shipped yet. Don't ship it.</p>" : ""}`);
    } catch (e) { console.error("refund office note failed (non-fatal)", e); }
  }
  if (!pay && !order && !gift) return { code: 200, body: { received: true, ignored: "another school" }, status: "ignored", note: "refund for a payment not in this school", meta };
  return { code: 200, body: { received: true, refunds_posted: posted }, note: `refund: ${posted} ledger row(s)${order && fullyRefunded ? ", order refunded" : ""}${gift ? ", gift updated" : ""}`, meta };
}

/* ---------------- DISPUTES (chargebacks) ----------------
   Opened: lock the store order and alert the office with the evidence deadline.
   Closed: won -> unlock; lost -> record the loss on the ledger and mark refunded. */
async function handleDispute({ supaUrl, serviceKey, dispute, opened, hosts }) {
  const db = rest(supaUrl, serviceKey);
  const pi = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  const amt = (dispute.amount || 0) / 100;
  const meta = { payment_intent: pi || null, amount: amt };
  const { key, session } = process.env.STRIPE_SECRET_KEY ? await paymentKey(pi, chargeId).catch(() => ({ key: null })) : { key: null };
  if (key) meta.session_id = key;
  const k = key ? encodeURIComponent(key) : null;
  const orders = k ? await db(`pl_store_orders?stripe_session_id=eq.${k}&select=id,title,status`).then((r) => r.ok ? r.json() : []).catch(() => []) : [];
  const order = Array.isArray(orders) ? orders[0] : null;
  const pays = k ? await db(`pl_ledger?stripe_session_id=eq.${k}&kind=eq.payment&select=student_id,course_id,description`).then((r) => r.json()).catch(() => []) : [];
  const pay = Array.isArray(pays) ? pays[0] : null;
  const gifts = k ? await db(`pl_donations?stripe_session_id=eq.${k}&select=id,designation`).then((r) => r.ok ? r.json() : []).catch(() => []) : [];
  const gift = Array.isArray(gifts) ? gifts[0] : null;
  const what = esc(order?.title || pay?.description || (gift ? `Gift: ${gift.designation}` : "") || session?.metadata?.title || "a payment");
  if (!order && !pay && !gift && !(session && (await belongsHere({ supaUrl, serviceKey, session, hosts })))) {
    return { code: 200, body: { received: true, ignored: "another school" }, status: "ignored", note: "dispute belongs to another school or a non-LMS payment", meta };
  }

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
    if (gift) await db(`pl_donations?id=eq.${gift.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "refunded", refunded_amount: amt }) });
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

/* ---------------- AUTOPAY (monthly payment plans) ----------------
   Checkout creates a monthly subscription for a fixed number of payments.
   startAutopay records the plan and tells Stripe to stop after the last payment;
   every successful monthly invoice becomes a ledger payment (keyed by invoice id). */
function addMonths(ts, n) { const d = new Date(ts * 1000); d.setUTCMonth(d.getUTCMonth() + n); return Math.floor(d.getTime() / 1000); }

async function startAutopay({ supaUrl, serviceKey, s, md }) {
  const db = rest(supaUrl, serviceKey);
  const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
  if (!subId) throw new Error("subscription missing on autopay checkout");
  const n = Math.max(2, parseInt(md.payments, 10) || 2);
  const sub = await stripeGet(`subscriptions/${encodeURIComponent(subId)}`, true);
  const anchor = sub.billing_cycle_anchor || sub.start_date || Math.floor(Date.now() / 1000);
  // Stop a week after the last scheduled payment, before another one could start.
  await stripePost(`subscriptions/${encodeURIComponent(subId)}`, { cancel_at: String(addMonths(anchor, n - 1) + 7 * 86400), proration_behavior: "none" });
  const per = (sub.items?.data?.[0]?.price?.unit_amount || 0) / 100;
  const r = await db(`pl_autopay`, { method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" }, body: JSON.stringify({
    student_id: md.student_id, course_id: md.course_id || null, tuition_level: md.tuition_level || null,
    description: md.description || (md.title ? `Certificate class: ${md.title}` : "Payment plan"),
    payments: n, amount: per, stripe_subscription_id: subId, status: "active",
  }) });
  if (!r.ok) { const t = await r.text(); if (!t.includes("23505")) throw new Error(`autopay insert failed: ${r.status} ${t}`); }
  try {
    await sendOfficeNote(`Autopay started: ${money(per)} x ${n}`, `<p>A student set up monthly autopay: <b>${n} payments of ${money(per)}</b> for <b>${esc(md.description || md.title || "their balance")}</b>. Each payment is recorded automatically.</p>`);
  } catch (e) { console.error("autopay office note failed", e); }
  return `${n} x ${money(per)}`;
}

/* Fetch an invoice with its subscription's tags (pinned version). */
async function invoiceWithTags(invId) {
  const inv = await stripeGet(`invoices/${encodeURIComponent(invId)}?expand[]=subscription`, true);
  const sub = inv.subscription && typeof inv.subscription === "object" ? inv.subscription : null;
  const md = sub?.metadata || inv.subscription_details?.metadata || {};
  return { inv, sub, md };
}

async function handleInvoicePaid({ supaUrl, serviceKey, invoice, hosts }) {
  const db = rest(supaUrl, serviceKey);
  const meta = { session_id: invoice.id, amount: (invoice.amount_paid || 0) / 100 };
  const { inv, sub, md } = await invoiceWithTags(invoice.id);
  if (md.autopay !== "1") return { code: 200, body: { received: true, ignored: "not an LMS autopay invoice" }, status: "ignored", note: "invoice is not LMS autopay", meta };
  if (!(await belongsHere({ supaUrl, serviceKey, session: { metadata: md, success_url: md.origin }, hosts }))) {
    return { code: 200, body: { received: true, ignored: "another school" }, status: "ignored", note: "autopay belongs to another school on this Stripe account", meta };
  }
  const amount = (inv.amount_paid || 0) / 100;
  if (amount <= 0) return { code: 200, body: { received: true, ignored: "zero invoice" }, status: "ignored", note: "nothing was charged", meta };
  const row = ledgerRowFor({ ...md, plan: "autopay" }, amount);
  if (!row) return { code: 200, body: { received: true, ignored: "missing tags" }, status: "ignored", note: "autopay invoice has no student/class tags", meta };
  row.stripe_session_id = inv.id;
  const ins = await insertLedger(supaUrl, serviceKey, row);
  if (ins === "duplicate") return { code: 200, body: { received: true, duplicate: inv.id }, note: "already recorded", meta };
  if (ins !== "ok") return { code: 500, body: { error: "Ledger insert failed" }, error: ins, meta };

  // Count payments made on this plan; stop the subscription after the last one.
  const subId = sub?.id || (typeof inv.subscription === "string" ? inv.subscription : null);
  let made = 0, total = parseInt(md.payments, 10) || 0;
  if (subId) {
    const plans = await db(`pl_autopay?stripe_subscription_id=eq.${encodeURIComponent(subId)}&select=id,payments_made,payments`).then((r) => r.ok ? r.json() : []).catch(() => []);
    const plan = Array.isArray(plans) ? plans[0] : null;
    if (plan) {
      made = (plan.payments_made || 0) + 1; total = plan.payments || total;
      await db(`pl_autopay?id=eq.${plan.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ payments_made: made, status: made >= total ? "completed" : "active", last_paid_at: new Date().toISOString() }) });
    }
    if (total && made >= total) await stripePost(`subscriptions/${encodeURIComponent(subId)}`, { cancel_at_period_end: "true" }).catch((e) => console.error("autopay stop failed", e));
  }
  try { await sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail: inv.customer_email || null, note: total ? `Autopay payment ${made || "?"} of ${total}.` : "" }); }
  catch (e) { console.error("autopay receipt failed (non-fatal)", e); }
  return { code: 200, body: { received: true, posted: amount }, note: `autopay payment ${made || "?"}/${total || "?"} ${money(amount)}`, meta };
}

async function handleInvoiceFailed({ supaUrl, serviceKey, invoice, hosts }) {
  const db = rest(supaUrl, serviceKey);
  const meta = { session_id: invoice.id, amount: (invoice.amount_due || 0) / 100 };
  const { inv, sub, md } = await invoiceWithTags(invoice.id);
  if (md.autopay !== "1") return { code: 200, body: { received: true, ignored: "not an LMS autopay invoice" }, status: "ignored", note: "invoice is not LMS autopay", meta };
  if (!(await belongsHere({ supaUrl, serviceKey, session: { metadata: md, success_url: md.origin }, hosts }))) {
    return { code: 200, body: { received: true, ignored: "another school" }, status: "ignored", note: "autopay belongs to another school", meta };
  }
  if (sub?.id) await db(`pl_autopay?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "past_due" }) });
  const amt = money((inv.amount_due || 0) / 100);
  const what = esc(md.description || md.title || "your payment plan");
  const next = inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000).toLocaleDateString("en-US", { dateStyle: "long" }) : null;
  const apiKey = process.env.RESEND_API_KEY;
  const to = [inv.customer_email].filter(Boolean);
  if (apiKey && to.length) {
    const school = process.env.VITE_SCHOOL_NAME || "Your school";
    const from = process.env.EMAIL_FROM || "YonaLearn <onboarding@resend.dev>";
    await sendResend(apiKey, "autopay failed (student)", { from, to, subject: `Your ${amt} payment didn't go through`, html:
      `<p>Hi,</p><p>Your monthly payment of <b>${amt}</b> for <b>${what}</b> was declined by your card.</p>
       <p>${next ? `We'll try again on <b>${esc(next)}</b>. ` : ""}To avoid a missed payment, sign in to the student portal and pay this month's amount with <b>Pay</b> or <b>Other amount</b>, or contact the office to update your card.</p>
       <p>— ${esc(school)}</p>` }).catch((e) => console.error(e));
  }
  await sendOfficeNote(`Autopay payment failed: ${amt}`, `<p>An autopay payment of <b>${amt}</b> for <b>${what}</b> (${esc(inv.customer_email || "student")}) was declined.</p><p>${next ? `Stripe will retry on ${esc(next)}. ` : ""}The student was emailed.</p>`).catch(() => {});
  return { code: 200, body: { received: true, failed: inv.id }, note: `autopay failed ${amt}`, meta };
}

async function handleSubscriptionEnded({ supaUrl, serviceKey, sub }) {
  const db = rest(supaUrl, serviceKey);
  const md = sub.metadata || {};
  const meta = { session_id: sub.id };
  if (md.autopay !== "1") return { code: 200, body: { received: true, ignored: "not LMS autopay" }, status: "ignored", note: "not LMS autopay", meta };
  const plans = await db(`pl_autopay?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id,payments_made,payments`).then((r) => r.ok ? r.json() : []).catch(() => []);
  const plan = Array.isArray(plans) ? plans[0] : null;
  if (!plan) return { code: 200, body: { received: true, ignored: "plan not in this school" }, status: "ignored", note: "autopay plan not in this school", meta };
  const done = (plan.payments_made || 0) >= (plan.payments || 0);
  await db(`pl_autopay?id=eq.${plan.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: done ? "completed" : "canceled" }) });
  if (!done) await sendOfficeNote("Autopay stopped early", `<p>An autopay plan stopped after ${plan.payments_made || 0} of ${plan.payments} payments (canceled in Stripe or repeatedly declined). Check the student's balance in Billing.</p>`).catch(() => {});
  return { code: 200, body: { received: true, autopay: done ? "completed" : "canceled" }, note: `autopay ${done ? "completed" : "canceled early"}`, meta };
}

/* ---------------- DONATIONS ---------------- */
async function recordDonation({ supaUrl, serviceKey, s, md, amount, sessionId }) {
  const db = rest(supaUrl, serviceKey);
  const email = md.donor_email || s.customer_details?.email || null;
  const r = await db(`pl_donations`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
    donor_name: md.donor_name || s.customer_details?.name || "", donor_email: email || "", amount,
    designation: md.designation || "General giving", note: md.note || null, student_id: md.student_id || null,
    stripe_session_id: sessionId, status: "paid",
  }) });
  if (!r.ok) { const t = await r.text(); if (r.status === 409 && t.includes("23505")) return "duplicate"; throw new Error(`donation insert failed: ${r.status} ${t}`); }

  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    const school = process.env.VITE_SCHOOL_NAME || "our ministry";
    const legal = process.env.VITE_SCHOOL_LEGAL_NAME || school;
    const ein = process.env.DONATION_EIN || "";
    const from = process.env.EMAIL_FROM || "YonaLearn <onboarding@resend.dev>";
    const when = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const taxLine = ein
      ? `<p style="font-size:13px;color:#555;">${esc(legal)} is a tax-exempt 501(c)(3) organization (EIN ${esc(ein)}). No goods or services were provided in exchange for this contribution. Please keep this receipt for your tax records.</p>`
      : "";
    if (email) {
      await sendResend(apiKey, "donation receipt", { from, to: [email], subject: `Thank you for your gift to ${school}`, html:
        `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:24px;">
          <h1 style="font-size:22px;color:#1B3A6B;">Thank you, ${esc(md.donor_name || "friend")}!</h1>
          <p>We received your gift of <b>${money(amount)}</b> to <b>${esc(md.designation || "General giving")}</b> on ${esc(when)}.</p>
          <p>Your generosity helps people learn, heal and grow. We're grateful for you.</p>
          ${taxLine}
          <p>— ${esc(school)}</p></div>` }).catch((e) => console.error("donation receipt failed", e));
    }
    await sendOfficeNote(`New gift: ${money(amount)}`, `<p><b>${esc(md.donor_name || "A donor")}</b> (${esc(email || "")}) gave <b>${money(amount)}</b> to <b>${esc(md.designation || "General giving")}</b>.</p>${md.note ? `<p>Note: ${esc(md.note)}</p>` : ""}`).catch(() => {});
  }
  return "recorded";
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
  const school = process.env.VITE_SCHOOL_NAME || (program === "certificate" ? "The Healed Place" : "NCTS");
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
  const school = process.env.VITE_SCHOOL_NAME || (program === "certificate" ? "The Healed Place" : "NCTS");
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

async function sendReceipt({ supaUrl, serviceKey, md, amount, sessionEmail, note = "" }) {
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
  const school = process.env.VITE_SCHOOL_NAME || (isCert ? "The Healed Place" : "NCTS Pure Light School of Ministry");
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
      ${note ? `<p style="font-size:14px;margin:14px 0 0;"><b>${esc(note)}</b></p>` : ""}
      <div style="margin-top:20px;background:#F5F0E8;border-left:4px solid #C5922E;padding:12px 16px;font-size:13px;line-height:1.6;">You can view your full account and any remaining balance anytime in your student portal.</div>
    </div>
  </div></body></html>`;

  await sendResend(apiKey, "receipt", { from, to: recipients, subject: `Payment received — ${money(amount)}`, html });
}
