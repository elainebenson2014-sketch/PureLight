// Vercel serverless function: POST /api/send-email
// Sends email through Resend. RESEND_API_KEY stays server-side only.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { to, subject, html, text } = body || {};

  if (!to || (Array.isArray(to) && to.length === 0) || !subject) {
    return res.status(400).json({ error: "Missing 'to' or 'subject'." });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "RESEND_API_KEY is not configured." });
  }
  const from = process.env.EMAIL_FROM || "NCTS PureLight <onboarding@resend.dev>";

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || `<p>${text || ""}</p>`,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
