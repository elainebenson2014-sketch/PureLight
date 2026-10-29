/* /api/coupons  —  promo codes for this school (Stripe coupons + promotion codes)

   GET                                   list this school's codes
   POST { action:"create", code, percent_off | amount_off, max_redemptions?, expires? (YYYY-MM-DD), note? }
   POST { action:"deactivate", id }      switch a code off (it can't be deleted in Stripe)

   SECURITY: admins only. The caller must send their signed-in session token, which is
   checked against Supabase. Students type codes at Stripe checkout; they never call this.

   Note: when several schools share one Stripe account, a code works at all of them.
   Each code is tagged with this school's name and only this school's codes are listed.

   Vercel env vars: STRIPE_SECRET_KEY, SUPABASE_URL (or VITE_), SUPABASE_ANON_KEY (or VITE_)
*/
const PIN = "2024-06-20";

async function requireAdmin(req) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !url || !anon) return "Not signed in.";
  const u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
  if (!u.ok) return "Session expired. Sign in again.";
  const user = await u.json();
  const p = await fetch(`${url}/rest/v1/pl_profiles?id=eq.${encodeURIComponent(user.id)}&select=role`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
  const rows = p.ok ? await p.json() : [];
  return rows[0]?.role === "admin" ? null : "Only administrators can manage promo codes.";
}

async function stripe(path, params) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? "POST" : "GET",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Stripe-Version": PIN, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Stripe error ${r.status}`);
  return j;
}

export default async function handler(req, res) {
  try {
    if (!process.env.STRIPE_SECRET_KEY) { res.status(500).json({ error: "Payments are not set up for this school." }); return; }
    const denied = await requireAdmin(req);
    if (denied) { res.status(401).json({ error: denied }); return; }
    const school = process.env.VITE_SCHOOL_NAME || "school";

    if (req.method === "GET") {
      const list = await stripe("promotion_codes?limit=100&expand[]=data.coupon");
      const codes = (list.data || [])
        .filter((p) => (p.metadata?.school || p.coupon?.metadata?.school) === school)
        .map((p) => ({
          id: p.id, code: p.code, active: p.active, used: p.times_redeemed || 0, max: p.max_redemptions || null,
          expires: p.expires_at ? new Date(p.expires_at * 1000).toISOString().slice(0, 10) : null,
          percent_off: p.coupon?.percent_off || null, amount_off: p.coupon?.amount_off ? p.coupon.amount_off / 100 : null,
          note: p.metadata?.note || "", created: new Date(p.created * 1000).toISOString().slice(0, 10),
        }));
      res.status(200).json({ codes });
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    if (body.action === "deactivate") {
      if (!body.id) { res.status(400).json({ error: "Missing code." }); return; }
      await stripe(`promotion_codes/${encodeURIComponent(body.id)}`, { active: "false" });
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === "create") {
      const code = String(body.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
      if (code.length < 3) { res.status(400).json({ error: "Codes need at least 3 letters or numbers." }); return; }
      const pct = Number(body.percent_off), amt = Number(body.amount_off);
      const c = { duration: "once", name: `${school}: ${code}`.slice(0, 40), "metadata[school]": school };
      if (pct > 0 && pct <= 100) c.percent_off = String(pct);
      else if (amt >= 1) { c.amount_off = String(Math.round(amt * 100)); c.currency = "usd"; }
      else { res.status(400).json({ error: "Enter a percent (1–100) or a dollar amount off." }); return; }
      const coupon = await stripe("coupons", c);
      const p = { coupon: coupon.id, code, "metadata[school]": school };
      if (body.note) p["metadata[note]"] = String(body.note).slice(0, 200);
      if (Number(body.max_redemptions) > 0) p.max_redemptions = String(Math.floor(Number(body.max_redemptions)));
      if (body.expires) {
        const ts = Math.floor(new Date(`${body.expires}T23:59:59-06:00`).getTime() / 1000);
        if (ts > Date.now() / 1000) p.expires_at = String(ts);
      }
      const promo = await stripe("promotion_codes", p);
      res.status(200).json({ ok: true, id: promo.id, code: promo.code });
      return;
    }
    res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
