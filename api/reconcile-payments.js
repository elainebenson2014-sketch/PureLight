/* GET /api/reconcile-payments   —  daily payment check (runs automatically from vercel.json)

   Compares the last 3 days of Stripe with the LMS and emails the office ONLY if
   something doesn't match:
     • a paid Stripe checkout that never reached the LMS (no ledger row / store order)
     • a Stripe refund that isn't on the ledger
     • a payment event that failed to process
   Every run is saved in pl_payment_events (type "reconcile.run").

   Security: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>". Requests without
   it are refused, so nobody else can trigger this.

   Vercel env vars: CRON_SECRET, STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   Optional: RESEND_API_KEY, EMAIL_FROM, ADMIN_ALERT_EMAIL, VITE_SCHOOL_NAME
*/

const DAYS = 3;          // normal daily look-back
const FIRST_RUN_DAYS = 45; // the very first run at a school looks further back

function hostOf(u) { try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) { res.status(500).json({ error: "CRON_SECRET is not set" }); return; }
  if ((req.headers.authorization || "") !== `Bearer ${cronSecret}`) { res.status(401).json({ error: "Not permitted" }); return; }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supaUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!stripeKey || !supaUrl || !serviceKey) { res.status(200).json({ skipped: "payments not configured for this school" }); return; }

  // Pinned API version so invoice fields (subscription_details) are always present.
  const stripe = async (path) => {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${stripeKey}`, "Stripe-Version": "2024-06-20" } });
    const j = await r.json();
    if (!r.ok) throw new Error(`Stripe: ${j.error?.message || r.status}`);
    return j;
  };
  const db = async (path) => {
    const r = await fetch(`${supaUrl}/rest/v1/${path}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    return r.ok ? r.json() : [];
  };
  const listAll = async (base) => {
    const out = [];
    let after = null;
    for (let i = 0; i < 20; i++) { // up to 2,000 items
      const page = await stripe(`${base}&limit=100${after ? `&starting_after=${after}` : ""}`);
      out.push(...(page.data || []));
      if (!page.has_more || !page.data?.length) break;
      after = page.data[page.data.length - 1].id;
    }
    return out;
  };

  try {
    const prior = await db(`pl_payment_events?type=eq.reconcile.run&select=id&limit=1`);
    const days = prior.length ? DAYS : FIRST_RUN_DAYS;
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    // Several schools may share one Stripe account: only check this school's payments.
    const hosts = new Set([req.headers["x-forwarded-host"], req.headers.host, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL, process.env.APP_URL, ...(process.env.SCHOOL_HOSTS || "").split(",")]
      .filter(Boolean).map((h) => hostOf(/^https?:/.test(h.trim()) ? h.trim() : `https://${h.trim()}`)).filter(Boolean));
    const seen = new Map();
    const mine = async (s) => {
      const md = s.metadata || {};
      const key = md.student_id ? `s:${md.student_id}` : md.reg_course_id ? `c:${md.reg_course_id}` : null;
      // Same rule as the webhook: the web address the checkout started on decides first.
      const h = hostOf(s.success_url || "");
      if (h && hosts.has(h)) return true;
      if (h && !h.endsWith(".vercel.app")) return false;
      if (key && seen.has(key)) return seen.get(key);
      let ok = false;
      if (md.student_id) ok = (await db(`pl_profiles?id=eq.${encodeURIComponent(md.student_id)}&select=id`)).length > 0;
      else if (md.reg_course_id) ok = (await db(`pl_courses?id=eq.${encodeURIComponent(md.reg_course_id)}&select=id`)).length > 0;
      if (key) seen.set(key, ok);
      return ok;
    };
    const sinceIso = new Date(since * 1000).toISOString();
    // Skip the last 30 minutes: those may still be on their way through the webhook.
    const settle = Math.floor(Date.now() / 1000) - 1800;

    const sessions = (await listAll(`checkout/sessions?created[gte]=${since}&status=complete`))
      .filter((s) => s.payment_status === "paid" && s.created < settle);
    const refunds = (await listAll(`refunds?created[gte]=${since}`))
      .filter((r) => r.status === "succeeded" && r.created < settle);

    const since_q = encodeURIComponent(sinceIso);
    const ledger = await db(`pl_ledger?created_at=gte.${since_q}&select=stripe_session_id,stripe_refund_id,description&limit=10000`);
    const orders = await db(`pl_store_orders?created_at=gte.${since_q}&select=stripe_session_id,status`);
    const gifts = await db(`pl_donations?created_at=gte.${since_q}&select=stripe_session_id`);
    const giftSessions = new Set(gifts.map((g) => g.stripe_session_id).filter(Boolean));
    const invoices = (await listAll(`invoices?status=paid&created[gte]=${since}`).catch(() => []))
      .filter((i) => i.created < settle && (i.amount_paid || 0) > 0 && i.subscription_details?.metadata?.autopay === "1");
    const failed = await db(`pl_payment_events?created_at=gte.${since_q}&status=eq.failed&type=neq.reconcile.run&select=type,error,created_at,stripe_event_id`);

    const ledgerSessions = new Set(ledger.map((l) => l.stripe_session_id).filter(Boolean));
    const ledgerRefunds = new Set(ledger.map((l) => l.stripe_refund_id).filter(Boolean));
    for (const l of ledger) { const m = /Stripe (re_[A-Za-z0-9]+)/.exec(l.description || ""); if (m) ledgerRefunds.add(m[1]); } // older refunds
    const orderSessions = new Map(orders.map((o) => [o.stripe_session_id, o.status]));

    const problems = [];
    for (const s of sessions) {
      const md = s.metadata || {};
      if (s.mode === "subscription") continue; // autopay: each monthly invoice is checked below
      const isLms = md.signup === "1" || md.store === "1" || md.donation === "1" || md.tuition_level || md.course_id;
      if (!isLms) continue; // not a payment from this LMS
      if (!(await mine(s))) continue; // another school's payment on a shared Stripe account
      const found = md.store === "1" ? orderSessions.has(s.id) : md.donation === "1" ? giftSessions.has(s.id) : ledgerSessions.has(s.id);
      if (!found) problems.push({ kind: "Payment not recorded in the LMS", amount: s.amount_total / 100, who: s.customer_details?.email || s.customer_email || "", what: md.title || md.description || md.reg_name || (md.signup === "1" ? "Registration" : "Payment"), ref: s.id });
    }
    // Autopay: every paid monthly invoice must be on the ledger (keyed by invoice id).
    for (const inv of invoices) {
      const md = inv.subscription_details.metadata;
      if (!(await mine({ metadata: md, success_url: md.origin }))) continue;
      if (!ledgerSessions.has(inv.id)) problems.push({ kind: "Autopay payment not recorded in the LMS", amount: inv.amount_paid / 100, who: inv.customer_email || "", what: md.description || md.title || "Autopay", ref: inv.id });
    }
    // Refunds: only those tied to an LMS checkout that has a ledger row (store downloads/items have no ledger row).
    for (const r of refunds) {
      if (ledgerRefunds.has(r.id)) continue;
      const pi = typeof r.payment_intent === "string" ? r.payment_intent : null;
      if (!pi) continue;
      const sl = await stripe(`checkout/sessions?payment_intent=${encodeURIComponent(pi)}&limit=1`).catch(() => ({ data: [] }));
      const s = (sl.data || [])[0];
      if (!s) continue;
      const orig = await db(`pl_ledger?stripe_session_id=eq.${encodeURIComponent(s.id)}&select=id&limit=1`);
      const ord = await db(`pl_store_orders?stripe_session_id=eq.${encodeURIComponent(s.id)}&select=status&limit=1`);
      if (orig.length) problems.push({ kind: "Refund not recorded on the ledger", amount: r.amount / 100, who: s.customer_details?.email || "", what: s.metadata?.title || s.metadata?.description || "Refund", ref: r.id });
      else if (ord.length && !["refunded", "disputed"].includes(ord[0].status) && r.amount >= (s.amount_total || 0)) problems.push({ kind: "Refunded store order not marked refunded", amount: r.amount / 100, who: s.customer_details?.email || "", what: s.metadata?.title || "Store order", ref: r.id });
    }
    for (const f of failed) problems.push({ kind: "Payment event failed to process", amount: null, who: "", what: `${f.type}: ${(f.error || "").slice(0, 160)}`, ref: f.stripe_event_id });

    const summary = { days, checked_sessions: sessions.length + invoices.length, checked_refunds: refunds.length, problems: problems.length };
    await logRun(supaUrl, serviceKey, summary, problems);
    if (problems.length) await emailOffice(problems, summary);
    res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error("reconcile failed", e);
    await logRun(supaUrl, serviceKey, { error: String(e.message || e) }, [], true);
    await emailOffice([{ kind: "The daily payment check could not run", amount: null, who: "", what: String(e.message || e).slice(0, 200), ref: "" }], {}).catch(() => {});
    res.status(500).json({ error: String(e.message || e) });
  }
}

async function logRun(supaUrl, serviceKey, summary, problems, failed = false) {
  try {
    await fetch(`${supaUrl}/rest/v1/pl_payment_events`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal,resolution=ignore-duplicates" },
      body: JSON.stringify({
        stripe_event_id: `reconcile-${new Date().toISOString().slice(0, 16)}`, type: "reconcile.run",
        status: failed ? "failed" : problems.length ? "failed" : "processed",
        note: failed ? null : `Last ${summary.days} days: ${summary.checked_sessions} payments and ${summary.checked_refunds} refunds checked, ${problems.length} problem(s)`,
        error: failed ? summary.error : null, payload: { summary, problems }, processed_at: new Date().toISOString(),
      }),
    });
  } catch (e) { console.error("reconcile log failed", e); }
}

async function emailOffice(problems, summary) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error("reconcile: problems found but RESEND_API_KEY not set", problems); return; }
  const to = (process.env.ADMIN_ALERT_EMAIL || "admin@nctspurelight.com, elainethomasbenson@yahoo.com").split(",").map((x) => x.trim()).filter(Boolean);
  const from = process.env.EMAIL_FROM || "YonaLearn <onboarding@resend.dev>";
  const school = process.env.VITE_SCHOOL_NAME || "YonaLearn";
  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const money = (n) => (n == null ? "" : "$" + (Number(n) || 0).toFixed(2));
  const rows = problems.map((p) => `<tr><td style="padding:8px;border-top:1px solid #eee;"><b>${esc(p.kind)}</b><br>${esc(p.what)}${p.who ? `<br><span style="color:#666">${esc(p.who)}</span>` : ""}</td><td style="padding:8px;border-top:1px solid #eee;white-space:nowrap;">${money(p.amount)}</td><td style="padding:8px;border-top:1px solid #eee;font-size:11px;color:#888;">${esc(p.ref)}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,serif;color:#1a1a1a;">
    <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
      <div style="background:#1B3A6B;padding:18px 24px;text-align:center;color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">${esc(school).toUpperCase()} · DAILY PAYMENT CHECK</div>
      <div style="padding:24px;font-size:14px;line-height:1.6;">
        <p>Stripe and the LMS don't fully match for the last ${summary.days || DAYS} days. Please review the item(s) below.</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">${rows}</table>
        <p style="margin-top:18px;color:#555;">To fix a payment that isn't recorded: open it in Stripe (search the reference) and add it in the LMS under Billing, or ask for help.</p>
      </div></div></body></html>`;
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to, subject: `[${school}] Payment check: ${problems.length} item(s) need review`, html }) });
  if (!r.ok) console.error("reconcile email failed", r.status, await r.text());
}
