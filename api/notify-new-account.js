// Vercel serverless function: POST /api/notify-new-account
//
// Sends an alert to the school office when a new account is created.
//
// SECURITY NOTE: the recipient is fixed server-side and can never be supplied
// by the caller. This endpoint only ever emails the school. It accepts a name
// and email to describe the new account, nothing more, so it cannot be abused
// to send mail to arbitrary addresses.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const rawName = (body && body.name) || "";
  const rawEmail = (body && body.email) || "";

  // Keep it short and strip anything that could inject markup into the email.
  const clean = (s) => String(s).slice(0, 200).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const name = clean(rawName) || "(no name given)";
  const email = clean(rawEmail) || "(no email given)";

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Never fail the signup because of this. Report, but don't blow up.
    return res.status(200).json({ ok: false, skipped: "RESEND_API_KEY is not configured." });
  }

  const to = process.env.ADMIN_ALERT_EMAIL || "admin@nctspurelight.com";
  const from = process.env.EMAIL_FROM || "NCTS PureLight <onboarding@resend.dev>";

  const when = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "full", timeStyle: "short" });

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F0E8;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
    <div style="background:#1B3A6B;padding:18px 24px;text-align:center;">
      <div style="color:#C5922E;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;">NCTS PURE LIGHT SCHOOL OF MINISTRY</div>
    </div>
    <div style="padding:24px;">
      <h1 style="font-size:19px;margin:0 0 4px;color:#1B3A6B;">New account created</h1>
      <p style="font-size:14px;color:#666;margin:0 0 18px;">Someone just registered on the student portal.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;width:90px;">Name</td><td style="padding:8px 0;">${name}</td></tr>
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;">Email</td><td style="padding:8px 0;">${email}</td></tr>
        <tr><td style="padding:8px 0;color:#1B3A6B;font-family:Arial,sans-serif;font-weight:bold;">When</td><td style="padding:8px 0;">${clean(when)}</td></tr>
      </table>
      <div style="margin-top:20px;background:#F5F0E8;border-left:4px solid #C5922E;padding:12px 16px;font-size:13px;">
        Sign in to the portal and open <b>People</b> to set this student's program level.
      </div>
    </div>
    <div style="border-top:1px solid #eee;padding:12px 24px;text-align:center;color:#666;font-size:11px;font-family:Arial,sans-serif;">
      www.nctspurelight.com &bull; admin@nctspurelight.com &bull; 888-966-3384
    </div>
  </div>
  </body></html>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `New account: ${name}`,
        html,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, error: data });
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
