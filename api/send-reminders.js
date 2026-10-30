/* GET /api/send-reminders   —  daily reminders (runs automatically from vercel.json, 7 AM Central)

   1) CLASS TODAY: every live class starting in the next 24 hours.
      Certificate classes go only to students ENROLLED in that class;
      program classes go to active students in that program ("all" = everyone).
   2) HOMEWORK DUE TOMORROW: published homework due tomorrow (Central time),
      sent only to students who haven't turned it in yet.

   3) TEACHING TOMORROW: instructors on the Teaching Schedule for tomorrow get a heads-up.

   Students are BCC'd in batches, so no one sees anyone else's address.
   Security: if CRON_SECRET is set, the request must carry it (Vercel Cron does this).

   Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
   Optional: EMAIL_FROM, VITE_SCHOOL_NAME, APP_URL, CRON_SECRET
*/
const BATCH = 45;
const TZ = "America/Chicago";

function esc(t) { return String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
function dayInTz(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "YonaLearn <onboarding@resend.dev>";
  const school = process.env.VITE_SCHOOL_NAME || "Your school";
  const portal = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

  if (process.env.CRON_SECRET && (req.headers.authorization || "") !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!SUPABASE_URL || !SR || !apiKey) {
    return res.status(200).json({ skipped: "Reminders need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and RESEND_API_KEY." });
  }

  const h = { apikey: SR, Authorization: `Bearer ${SR}` };
  const get = async (path) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h }); return r.ok ? r.json() : []; };
  const fromEmail = (from.match(/<([^>]+)>/) || [null, from])[1];

  async function send(recips, subject, inner) {
    let sent = 0;
    const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:20px;color:#1a1a1a;">
      <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;font-weight:bold;color:#C5922E;margin-bottom:14px;">${esc(school).toUpperCase()}</div>
      ${inner}
      ${portal ? `<p style="margin-top:18px;"><a href="${portal}" style="color:#1B3A6B;">Open the student portal</a></p>` : ""}
      <p style="color:#888;font-size:12px;margin-top:18px;">You're receiving this because you're enrolled at ${esc(school)}.</p></div>`;
    for (let i = 0; i < recips.length; i += BATCH) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [fromEmail], bcc: recips.slice(i, i + BATCH), subject, html }),
      });
      if (r.ok) sent += Math.min(BATCH, recips.length - i);
      else console.error("reminder send failed", r.status, await r.text());
    }
    return sent;
  }

  try {
    const now = new Date();
    const end = new Date(now.getTime() + 24 * 3600 * 1000);
    const [profiles, courses, enrolls] = await Promise.all([
      get("pl_profiles?select=id,email,full_name,program,role,status"),
      get("pl_courses?select=id,title,is_certificate"),
      get("pl_cert_enrollments?select=student_id,course_id"),
    ]);
    const students = profiles.filter((p) => p.role === "student" && p.email && (p.status || "active") === "active");
    const byId = new Map(students.map((p) => [p.id, p]));
    const courseOf = new Map(courses.map((c) => [c.id, c]));
    const audience = (courseId, program) => {
      const c = courseId ? courseOf.get(courseId) : null;
      if (c && c.is_certificate) return enrolls.filter((e) => e.course_id === c.id).map((e) => byId.get(e.student_id)).filter(Boolean);
      return students.filter((p) => !program || program === "all" || p.program === program);
    };

    // 1) Classes in the next 24 hours
    const sessions = await get(`pl_sessions?select=*&starts_at=gte.${encodeURIComponent(now.toISOString())}&starts_at=lt.${encodeURIComponent(end.toISOString())}&order=starts_at.asc`);
    let classMails = 0;
    for (const s of sessions) {
      const recips = audience(s.course_id, s.program).map((p) => p.email);
      if (!recips.length) continue;
      const when = new Date(s.starts_at).toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      classMails += await send(recips, `Class reminder: ${s.title}`,
        `<h2 style="font-size:20px;color:#1B3A6B;margin:0 0 8px;">${esc(s.title)}</h2>
         <p><b>${esc(when)}</b> (Central)${s.duration_min ? ` · ${s.duration_min} minutes` : ""}</p>
         ${s.zoom_url ? `<p><a href="${esc(s.zoom_url)}" style="display:inline-block;background:#1B3A6B;color:#fff;padding:10px 20px;border-radius:999px;text-decoration:none;font-family:Arial,sans-serif;">Join the class on Zoom</a></p>` : ""}
         ${s.notes ? `<p>${esc(s.notes)}</p>` : ""}`);
    }

    // 2) Homework due tomorrow (Central), only to students who haven't submitted
    const tomorrow = dayInTz(new Date(now.getTime() + 24 * 3600 * 1000));
    const hw = await get(`pl_homework?select=id,title,program,course_id,status,due_date&due_date=eq.${tomorrow}&status=eq.published`);
    let hwMails = 0;
    for (const w of hw) {
      const done = new Set((await get(`pl_homework_submissions?homework_id=eq.${w.id}&select=student_id`)).map((x) => x.student_id));
      const recips = audience(w.course_id, w.program).filter((p) => !done.has(p.id)).map((p) => p.email);
      if (!recips.length) continue;
      hwMails += await send(recips, `Homework due tomorrow: ${w.title}`,
        `<h2 style="font-size:20px;color:#1B3A6B;margin:0 0 8px;">${esc(w.title)}</h2>
         <p>This assignment is due <b>tomorrow</b>. Open <b>Homework</b> in the portal to finish and submit it. If you've started, your draft is saved.</p>`);
    }

    // 3) TEACHERS: anyone on the Teaching Schedule for tomorrow gets a heads-up.
    const teach = await get(`pl_schedule?select=*&session_date=eq.${tomorrow}`);
    const staff = new Map(profiles.filter((p) => p.email && p.role !== "student").map((p) => [p.id, p]));
    const staffByName = new Map(profiles.filter((p) => p.email && p.role !== "student" && p.full_name).map((p) => [p.full_name.toLowerCase().trim(), p]));
    let teachMails = 0;
    const perTeacher = new Map();
    for (const t of teach) {
      const who = (t.teacher_id && staff.get(t.teacher_id)) || staffByName.get((t.teacher_name || "").toLowerCase().trim());
      if (!who) continue;
      if (!perTeacher.has(who.email)) perTeacher.set(who.email, []);
      perTeacher.get(who.email).push(t);
    }
    for (const [email, list] of perTeacher) {
      const items = list.map((t) => `<li><b>${esc(t.topic)}</b>${t.strand ? ` · ${esc(t.strand)}` : ""}${t.program ? ` (${esc(t.program)})` : ""}</li>`).join("");
      teachMails += await send([email], `You're teaching tomorrow: ${list[0].topic}${list.length > 1 ? ` (+${list.length - 1} more)` : ""}`,
        `<h2 style="font-size:20px;color:#1B3A6B;margin:0 0 8px;">You're teaching tomorrow</h2><ul>${items}</ul>
         <p>Your full rotation is under <b>Teaching Schedule</b> in the portal.</p>`);
    }

    return res.status(200).json({ ok: true, classes: sessions.length, class_emails: classMails, homework_due: hw.length, homework_emails: hwMails, teaching_tomorrow: teach.length, teacher_emails: teachMails });
  } catch (e) {
    console.error("send-reminders failed", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
