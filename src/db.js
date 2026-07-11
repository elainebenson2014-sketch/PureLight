import { supabase } from "./supabaseClient";

const BUCKET = "purelight";

/* ---------------- AUTH / PROFILE ---------------- */
export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from("pl_profiles").select("*").eq("id", user.id).single();
  if (error) throw error;
  return data;
}

export async function listProfiles() {
  const { data, error } = await supabase.from("pl_profiles").select("*").order("full_name");
  if (error) throw error;
  return data;
}

export async function listStudents() {
  const { data, error } = await supabase.from("pl_profiles").select("*").eq("role", "student").order("full_name");
  if (error) throw error;
  return data;
}

/* ---------------- FILES ---------------- */
export async function uploadFile(folder, file) {
  const safe = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const path = `${folder}/${Date.now()}-${safe}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function signedUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------------- BOOKS ---------------- */
export async function listBooks() {
  const { data, error } = await supabase.from("pl_books").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function createBook({ title, author, description, pages, program, video_url, course_id, module, file }) {
  let file_path = null;
  if (file) file_path = await uploadFile("books", file);
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_books").insert({
    title, author, description, pages: Number(pages) || 0, program: program || "all",
    video_url: video_url || null, course_id: course_id || null, module: module || null, file_path, created_by: user.id,
  });
  if (error) throw error;
}

export async function deleteBook(id) {
  const { error } = await supabase.from("pl_books").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------- TESTS + QUESTIONS ---------------- */
export async function listTests() {
  const { data, error } = await supabase
    .from("pl_tests")
    .select("*, pl_questions(*)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const allQs = (data || []).flatMap((t) => t.pl_questions || []);
  const qIds = allQs.map((q) => q.id);
  let ansMap = {};
  if (qIds.length) {
    const { data: ans } = await supabase.from("pl_question_answers").select("question_id, correct_answer").in("question_id", qIds);
    (ans || []).forEach((a) => { ansMap[a.question_id] = a.correct_answer; });
  }
  return (data || []).map((t) => ({
    ...t,
    questions: (t.pl_questions || []).sort((a, b) => a.position - b.position).map((q) => ({ ...q, correct_answer: ansMap[q.id] ?? null })),
  }));
}

export async function saveTest(test, questions) {
  const { data: { user } } = await supabase.auth.getUser();
  let testId = test.id;

  if (testId) {
    const { error } = await supabase.from("pl_tests").update({
      title: test.title, description: test.description, book_id: test.book_id || null, program: test.program || "all",
      course_id: test.course_id || null, module: test.module || null,
    }).eq("id", testId);
    if (error) throw error;
    // simplest reliable sync: clear old questions, insert current set
    await supabase.from("pl_questions").delete().eq("test_id", testId);
  } else {
    const { data, error } = await supabase.from("pl_tests").insert({
      title: test.title, description: test.description, book_id: test.book_id || null, program: test.program || "all",
      course_id: test.course_id || null, module: test.module || null, created_by: user.id,
    }).select("id").single();
    if (error) throw error;
    testId = data.id;
  }

  const rows = questions.map((q, i) => ({
    test_id: testId, position: i, type: q.type, prompt: q.prompt,
    points: Number(q.points) || 0, options: q.options || [],
  }));
  if (rows.length) {
    const { data: inserted, error } = await supabase.from("pl_questions").insert(rows).select("id, position");
    if (error) throw error;
    const answerRows = (inserted || [])
      .filter((ins) => { const o = questions[ins.position]; return o?.correct_answer != null && o.correct_answer !== ""; })
      .map((ins) => { const o = questions[ins.position]; return { question_id: ins.id, correct_answer: String(o.correct_answer), points: Number(o.points) || 0 }; });
    if (answerRows.length) {
      const { error: aErr } = await supabase.from("pl_question_answers").insert(answerRows);
      if (aErr) throw aErr;
    }
  }
  return testId;
}

export async function deleteTest(id) {
  const { error } = await supabase.from("pl_tests").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------- SUBMISSIONS ---------------- */
export async function listSubmissions() {
  const { data, error } = await supabase
    .from("pl_submissions")
    .select("*")
    .order("submitted_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function createSubmission({ test_id, answers, max_score }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_submissions").insert({
    test_id, student_id: user.id, answers, max_score,
  });
  if (error) throw error;
}

export async function gradeSubmission(id, { manual, score, max_score, feedback }) {
  const { error } = await supabase.from("pl_submissions").update({
    manual, score, max_score, feedback, status: "graded",
  }).eq("id", id);
  if (error) throw error;
}

/* ---------------- MESSAGES ---------------- */
export async function listMessages() {
  const { data, error } = await supabase
    .from("pl_messages")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function sendMessage({ recipient, subject, body, sender_name }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_messages").insert({
    sender_id: user.id, sender_name, recipient, subject, body,
  });
  if (error) throw error;
}

/* Fire the real email through the Vercel function. Never throws — UI continues
   even if email delivery isn't configured yet.
   The endpoint only accepts signed-in staff, so we pass the session token. */
export async function refundPayment(ledger_id, amount) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return { error: "You must be signed in." };
    const r = await fetch("/api/refund-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ledger_id, amount }),
    });
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}

export async function sendEmail({ to, bcc, subject, html }) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return { error: "You must be signed in to send email." };
    const r = await fetch("/api/send-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, bcc, subject, html }),
    });
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}

/* ---------------- SYLLABI ---------------- */
export async function listSyllabi() {
  const { data, error } = await supabase.from("pl_syllabi").select("*").order("program");
  if (error) throw error;
  return data;
}

export async function saveSyllabus({ id, program, term, title, content, file }) {
  const { data: { user } } = await supabase.auth.getUser();
  const patch = { program: program || "all", term: term || null, title, content, created_by: user.id, updated_at: new Date().toISOString() };
  if (file) patch.file_path = await uploadFile("syllabi", file);
  if (id) {
    const { error } = await supabase.from("pl_syllabi").update(patch).eq("id", id);
    if (error) throw error;
  } else {
    // Upsert on (program, term) so re-saving the same program updates in place
    const { error } = await supabase.from("pl_syllabi").upsert(patch, { onConflict: "program,term" });
    if (error) throw error;
  }
}

export async function deleteSyllabus(id) {
  const { error } = await supabase.from("pl_syllabi").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------- HOMEWORK ---------------- */
export async function listHomework() {
  const { data, error } = await supabase
    .from("pl_homework")
    .select("*, pl_homework_questions(*)")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("title", { ascending: true });
  if (error) throw error;
  const allQs = (data || []).flatMap((h) => h.pl_homework_questions || []);
  const qIds = allQs.map((q) => q.id);
  let ansMap = {};
  // Fetch the answer key in batches. Passing every question id at once builds a
  // URL long enough for the server to reject it (400). Students are blocked from
  // this table by RLS, so an empty/failed result here is expected and harmless.
  const BATCH = 100;
  for (let i = 0; i < qIds.length; i += BATCH) {
    const slice = qIds.slice(i, i + BATCH);
    try {
      const { data: ans, error: ansErr } = await supabase
        .from("pl_homework_answers").select("question_id, correct_answer").in("question_id", slice);
      if (ansErr) continue; // instructor-only table; students simply get nothing
      (ans || []).forEach((a) => { ansMap[a.question_id] = a.correct_answer; });
    } catch (e) { /* non-fatal: homework still loads without the key */ }
  }
  return (data || []).map((h) => ({
    ...h,
    questions: (h.pl_homework_questions || []).sort((a, b) => a.position - b.position).map((q) => ({ ...q, correct_answer: ansMap[q.id] ?? null })),
  }));
}

export async function saveHomework(hw, questions, file) {
  const { data: { user } } = await supabase.auth.getUser();
  let file_path = hw.file_path ?? null;
  if (file) file_path = await uploadFile("homework", file);
  let hwId = hw.id;

  if (hwId) {
    const { error } = await supabase.from("pl_homework").update({
      title: hw.title, instructions: hw.instructions, due_date: hw.due_date || null,
      points: Number(hw.points) || 0, program: hw.program || "all",
      course_id: hw.course_id || null, module: hw.module || null, file_path,
    }).eq("id", hwId);
    if (error) throw error;
    await supabase.from("pl_homework_questions").delete().eq("homework_id", hwId);
  } else {
    const { data, error } = await supabase.from("pl_homework").insert({
      title: hw.title, instructions: hw.instructions, due_date: hw.due_date || null,
      points: Number(hw.points) || 0, program: hw.program || "all",
      course_id: hw.course_id || null, module: hw.module || null, file_path, created_by: user.id,
    }).select("id").single();
    if (error) throw error;
    hwId = data.id;
  }

  const rows = (questions || []).map((q, i) => ({
    homework_id: hwId, position: i, type: q.type, prompt: q.prompt,
    points: Number(q.points) || 0, options: q.options || [],
  }));
  if (rows.length) {
    const { data: inserted, error } = await supabase.from("pl_homework_questions").insert(rows).select("id, position");
    if (error) throw error;
    const answerRows = (inserted || [])
      .filter((ins) => { const o = questions[ins.position]; return o?.correct_answer != null && o.correct_answer !== ""; })
      .map((ins) => { const o = questions[ins.position]; return { question_id: ins.id, correct_answer: String(o.correct_answer), points: Number(o.points) || 0 }; });
    if (answerRows.length) {
      const { error: aErr } = await supabase.from("pl_homework_answers").insert(answerRows);
      if (aErr) throw aErr;
    }
  }
  return hwId;
}

export async function deleteHomework(id) {
  const { error } = await supabase.from("pl_homework").delete().eq("id", id);
  if (error) throw error;
}

export async function listHomeworkSubmissions() {
  const { data, error } = await supabase.from("pl_homework_submissions").select("*").order("submitted_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function listSessions() {
  const { data, error } = await supabase.from("pl_sessions").select("*").order("starts_at", { ascending: true });
  if (error) throw error;
  return data || [];
}
export async function saveSession(s) {
  const { data: { user } } = await supabase.auth.getUser();
  const rec = {
    title: s.title, course_id: s.course_id || null, program: s.program || "all",
    starts_at: s.starts_at, duration_min: Number(s.duration_min) || 60,
    zoom_url: s.zoom_url || null, notes: s.notes || null,
  };
  if (s.id) {
    const { error } = await supabase.from("pl_sessions").update(rec).eq("id", s.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("pl_sessions").insert({ ...rec, created_by: user.id });
    if (error) throw error;
  }
}
export async function deleteSession(id) {
  const { error } = await supabase.from("pl_sessions").delete().eq("id", id);
  if (error) throw error;
}

export async function submitHomework({ homework_id, answers, response, file, max_points }) {
  const { data: { user } } = await supabase.auth.getUser();
  let file_path = null;
  if (file) file_path = await uploadFile("homework-submissions", file);

  // If a submission already exists (e.g. it was returned for redo), update it
  // instead of inserting a duplicate — this resubmits it for grading.
  const { data: existing } = await supabase.from("pl_homework_submissions")
    .select("id").eq("homework_id", homework_id).eq("student_id", user.id).maybeSingle();

  if (existing?.id) {
    const patch = { answers: answers || {}, response: response || "", max_points, status: "submitted" };
    if (file_path) patch.file_path = file_path;
    const { error } = await supabase.from("pl_homework_submissions").update(patch).eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("pl_homework_submissions").insert({
      homework_id, student_id: user.id, answers: answers || {}, response: response || "", file_path, max_points, status: "submitted",
    });
    if (error) throw error;
  }
}

export async function gradeHomework(id, { manual, score, max_points, feedback }) {
  const { error } = await supabase.from("pl_homework_submissions").update({
    manual: manual || {}, score, max_points, feedback, status: "graded",
  }).eq("id", id);
  if (error) throw error;
}

// Save grading progress WITHOUT releasing to the student (status stays not-graded).
export async function saveGradeDraft(id, { manual, score, max_points, feedback }) {
  const { error } = await supabase.from("pl_homework_submissions").update({
    manual: manual || {}, score, max_points, feedback, status: "grading",
  }).eq("id", id);
  if (error) throw error;
}

// Send a submission back to the student to complete and resubmit, with a note.
export async function sendBackHomework(id, note) {
  const { error } = await supabase.from("pl_homework_submissions").update({
    status: "returned", feedback: note || "",
  }).eq("id", id);
  if (error) throw error;
}

/* ---------------- PROGRAMS ---------------- */
// Labels must match App.jsx PROGRAMS / the checkout function so charge and
// payment descriptions line up exactly (e.g. "Bachelor tuition").
const TUITION_LEVEL_LABELS = {
  associate: "Associate", bachelor: "Bachelor",
  master: "Master", master2: "Master 2", doctorate: "Doctoral", phd: "PhD",
};

/* Post the registration / books / tuition charges for a student's level so the
   ledger reconciles against their payments. Idempotent: a charge whose
   description already exists is skipped, so it's safe to call repeatedly. */
export async function postTuitionCharges(student_id, program) {
  if (!student_id || !program) return;
  const { data: trows, error: te } = await supabase
    .from("pl_tuition").select("amount,registration,books").eq("program", program);
  if (te) throw te;
  const t = Array.isArray(trows) ? trows[0] : null;
  if (!t) return;

  const label = TUITION_LEVEL_LABELS[program] || program;
  const total = Number(t.amount) || 0;
  const reg = Number(t.registration) || 0;
  const books = Number(t.books) || 0;
  const tuitionPortion = Math.max(0, Math.round((total - reg - books) * 100) / 100);

  const planned = [
    { description: `${label} registration`, amount: reg },
    { description: `${label} books`, amount: books },
    { description: `${label} tuition`, amount: tuitionPortion },
  ].filter((c) => c.amount > 0);
  if (!planned.length) return;

  const { data: existing, error: ee } = await supabase
    .from("pl_ledger").select("description").eq("student_id", student_id).eq("kind", "charge");
  if (ee) throw ee;
  const have = new Set((existing || []).map((e) => (e.description || "").trim().toLowerCase()));

  const { data: { user } } = await supabase.auth.getUser();
  const rows = planned
    .filter((c) => !have.has(c.description.toLowerCase()))
    .map((c) => ({ student_id, kind: "charge", description: c.description, amount: c.amount, recorded_by: user.id }));
  if (rows.length) {
    const { error } = await supabase.from("pl_ledger").insert(rows);
    if (error) throw error;
  }
}

export async function setStudentProgram(id, program) {
  const { error } = await supabase.from("pl_profiles").update({ program: program || null }).eq("id", id);
  if (error) throw error;
  // Post the level's charges so the student's ledger reconciles. Wrapped so a
  // charge hiccup never blocks the level assignment itself.
  if (program) {
    try { await postTuitionCharges(id, program); } catch (e) { console.error("postTuitionCharges", e); }
  }
}

export async function setStudentStatus(id, status) {
  const { error } = await supabase.from("pl_profiles").update({ status: status || "active" }).eq("id", id);
  if (error) throw error;
}

/* ---------------- COURSES ---------------- */
export async function listCourses() {
  const { data, error } = await supabase.from("pl_courses").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function createCourse({ title, description, program, code, credit_hours, ce_type, ce_hours, passing_score, approval_number, provider_name }) {
  const { data: { user } } = await supabase.auth.getUser();
  const ch = (credit_hours !== undefined && credit_hours !== null && credit_hours !== "") ? Number(credit_hours) : null;
  const { error } = await supabase.from("pl_courses").insert({
    title, description: description || "", program: program || "all",
    code: code || null, credit_hours: ch, created_by: user.id,
    ce_type: ce_type || "none",
    ce_hours: ce_hours ? Number(ce_hours) : null,
    passing_score: passing_score ? Number(passing_score) : 75,
    approval_number: approval_number || null,
    provider_name: provider_name || null,
  });
  if (error) throw error;
}

export async function bulkAddCourses(rows) {
  const { data: { user } } = await supabase.auth.getUser();
  const recs = rows.map((r) => ({
    code: r.code || null,
    title: r.title,
    description: r.description || "",
    program: r.program || "all",
    credit_hours: (r.credit_hours !== undefined && r.credit_hours !== null && r.credit_hours !== "") ? Number(r.credit_hours) : null,
    created_by: user.id,
  }));
  const { error } = await supabase.from("pl_courses").insert(recs);
  if (error) throw error;
}

export async function deleteCourse(id) {
  const { error } = await supabase.from("pl_courses").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------- ATTENDANCE ---------------- */
export async function listAttendance() {
  const { data, error } = await supabase.from("pl_attendance").select("*").order("date", { ascending: false });
  if (error) throw error;
  return data;
}

export async function setAttendance(student_id, date, status) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_attendance").upsert(
    { student_id, date, status, recorded_by: user.id },
    { onConflict: "student_id,date" }
  );
  if (error) throw error;
}

/* ---------------- CERTIFICATES ---------------- */
export async function listCertificates() {
  const { data, error } = await supabase.from("pl_certificates").select("*").order("issued_on", { ascending: false });
  if (error) throw error;
  return data;
}

export async function issueCertificate({ student_id, title, course_id, program, note, ce_hours, approval_number, provider_name }) {
  const { data: { user } } = await supabase.auth.getUser();
  const sid = student_id || user.id;
  const serial = "NCTS-" + new Date().getFullYear() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const { error } = await supabase.from("pl_certificates").insert({
    student_id: sid, title, course_id: course_id || null, program: program || null,
    serial, note: note || "", issued_by: user.id,
    ce_hours: ce_hours || null,
    approval_number: approval_number || null,
    provider_name: provider_name || null,
  });
  if (error) throw error;
}

export async function deleteCertificate(id) {
  const { error } = await supabase.from("pl_certificates").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------- BILLING / LEDGER ---------------- */
export async function listLedger() {
  const { data, error } = await supabase.from("pl_ledger").select("*")
    .order("date", { ascending: true }).order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addLedgerEntry({ student_id, kind, description, amount, date, method, course_id }) {
  const { data: { user } } = await supabase.auth.getUser();
  const rec = { student_id, kind, description: description || "", amount: Number(amount) || 0, method: method || "", recorded_by: user.id };
  if (date) rec.date = date;
  if (course_id) rec.course_id = course_id;
  const { error } = await supabase.from("pl_ledger").insert(rec);
  if (error) throw error;
}

export async function bulkAddLedger(entries) {
  const { data: { user } } = await supabase.auth.getUser();
  const rows = entries.map((e) => {
    const r = { student_id: e.student_id, kind: e.kind, description: e.description || "", amount: Number(e.amount) || 0, method: e.method || "", recorded_by: user.id };
    if (e.date) r.date = e.date;
    return r;
  });
  const { error } = await supabase.from("pl_ledger").insert(rows);
  if (error) throw error;
}

export async function deleteLedgerEntry(id) {
  const { error } = await supabase.from("pl_ledger").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------- ROLES ---------------- */
export async function setRole(id, role) {
  const { error } = await supabase.from("pl_profiles").update({ role }).eq("id", id);
  if (error) throw error;
}

/* ---------------- INSTRUCTOR <-> COURSE ASSIGNMENTS ---------------- */
export async function listInstructorCourses() {
  const { data, error } = await supabase.from("pl_instructor_courses").select("*");
  if (error) throw error;
  return data;
}

export async function assignCourse(instructor_id, course_id) {
  const { error } = await supabase.from("pl_instructor_courses").upsert(
    { instructor_id, course_id }, { onConflict: "instructor_id,course_id" }
  );
  if (error) throw error;
}

export async function unassignCourse(instructor_id, course_id) {
  const { error } = await supabase.from("pl_instructor_courses").delete()
    .eq("instructor_id", instructor_id).eq("course_id", course_id);
  if (error) throw error;
}

/* ---------------- CERTIFICATE CLASSES (cohort: pl_courses flagged is_certificate) ---------------- */
export async function saveCertClass(c) {
  const { data: { user } } = await supabase.auth.getUser();
  const rec = {
    title: c.title, description: c.description || "", code: c.code || null,
    program: "certificate", is_certificate: true,
    pillar: c.pillar || null, fee: Number(c.fee) || 0,
    duration_weeks: c.duration_weeks ? Number(c.duration_weeks) : null,
    start_date: c.start_date || null,
  };
  if (c.id) {
    const { error } = await supabase.from("pl_courses").update(rec).eq("id", c.id);
    if (error) throw error;
    return c.id;
  }
  const { data, error } = await supabase.from("pl_courses").insert({ ...rec, created_by: user.id }).select("id").single();
  if (error) throw error;
  return data.id;
}

/* roster: which students are in which certificate class */
export async function listCertEnrollments() {
  const { data, error } = await supabase.from("pl_cert_enrollments").select("*");
  if (error) throw error;
  return data;
}

export async function enrollCertClass(course_id, student_id) {
  let sid = student_id;
  if (!sid) { const { data: { user } } = await supabase.auth.getUser(); sid = user.id; }
  const { error } = await supabase.from("pl_cert_enrollments")
    .upsert({ student_id: sid, course_id }, { onConflict: "student_id,course_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function unenrollCertClass(id) {
  const { error } = await supabase.from("pl_cert_enrollments").delete().eq("id", id);
  if (error) throw error;
}

/* Start a Stripe Checkout for a certificate class fee; returns the URL to redirect to.
   plan = "full" | "half" | "quarter"  — only half and quarter apply to 12-week classes. */
export async function startCertCheckout(course_id, plan) {
  const { data: { user } } = await supabase.auth.getUser();
  const r = await fetch("/api/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ course_id, plan: plan || "full", student_id: user.id, student_email: user.email, origin: window.location.origin }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "Could not start checkout.");
  return j.url;
}

/* ---------------- TUITION (per program level) ---------------- */
export async function listTuition() {
  const { data, error } = await supabase.from("pl_tuition").select("*");
  if (error) throw error;
  return data || [];
}

export async function setTuition(program, fields) {
  const f = fields || {};
  const { error } = await supabase.from("pl_tuition").upsert(
    {
      program,
      amount: Number(f.amount) || 0,
      registration: Number(f.registration) || 0,
      books: Number(f.books) || 0,
      installments: Math.max(1, parseInt(f.installments, 10) || 7),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "program" }
  );
  if (error) throw error;
}

/* Start a Stripe Checkout for a program level's tuition; returns the URL to redirect to.
   The amount is looked up server-side from pl_tuition by the checkout function —
   never trust a price sent from the browser. `plan` only applies to the
   "tuition" bucket: "full" | "half" | "four". */
export async function startTuitionCheckout(tuition_level, bucket, plan) {
  const { data: { user } } = await supabase.auth.getUser();
  const r = await fetch("/api/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tuition_level, bucket, plan, student_id: user.id, student_email: user.email, origin: window.location.origin }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "Could not start checkout.");
  return j.url;
}

/* ═══════════════ MESSAGE THREADING ═══════════════════════════════ */

export async function replyMessage({ parent_id, subject, body, recipient, sender_name }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_messages").insert({
    sender_id: user.id, sender_name, recipient, subject, body, parent_id,
  });
  if (error) throw error;
}

export async function markMessageRead(id) {
  const { error } = await supabase.from("pl_messages")
    .update({ read_at: new Date().toISOString() }).eq("id", id).is("read_at", null);
  if (error) throw error;
}

/* ═══════════════ FORMS (ONBOARDING HUB) ══════════════════════════ */

export async function listForms() {
  const { data, error } = await supabase.from("pl_forms")
    .select("*").order("sort_order").order("created_at");
  if (error) throw error;
  return data || [];
}

export async function saveForm(form) {
  const { data: { user } } = await supabase.auth.getUser();
  let file_path = form.file_path || null;
  if (form._file) file_path = await uploadFile("homework-submissions", form._file);
  const rec = {
    title: form.title, description: form.description || null,
    type: form.type || "upload", file_path,
    program: form.program || "all", required: form.required !== false,
    sort_order: Number(form.sort_order) || 0, active: form.active !== false,
  };
  if (form.id) {
    const { error } = await supabase.from("pl_forms").update(rec).eq("id", form.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("pl_forms").insert({ ...rec, created_by: user.id });
    if (error) throw error;
  }
}

export async function deleteForm(id) {
  const { error } = await supabase.from("pl_forms").delete().eq("id", id);
  if (error) throw error;
}

export async function listFormSubmissions() {
  const { data, error } = await supabase.from("pl_form_submissions")
    .select("*").order("submitted_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function submitForm({ form_id, file, notes }) {
  const { data: { user } } = await supabase.auth.getUser();
  let file_path = null;
  if (file) file_path = await uploadFile("homework-submissions", file);
  const { error } = await supabase.from("pl_form_submissions").insert({
    form_id, student_id: user.id, file_path, notes: notes || null,
  });
  if (error) throw error;
}

export async function reviewFormSubmission(id, status) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_form_submissions").update({
    status, reviewed_at: new Date().toISOString(), reviewed_by: user.id,
  }).eq("id", id);
  if (error) throw error;
}

/* ═══════════════ SURVEYS ════════════════════════════════════════ */

export async function listSurveys() {
  const { data, error } = await supabase.from("pl_surveys")
    .select("*, pl_survey_questions(*)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map((s) => ({
    ...s,
    questions: (s.pl_survey_questions || []).sort((a, b) => a.position - b.position),
  }));
}

export async function saveSurvey(survey, questions) {
  const { data: { user } } = await supabase.auth.getUser();
  let surveyId = survey.id;
  const rec = {
    title: survey.title, description: survey.description || null,
    category: survey.category || "general", program: survey.program || "all",
    active: survey.active !== false,
  };
  if (surveyId) {
    const { error } = await supabase.from("pl_surveys").update(rec).eq("id", surveyId);
    if (error) throw error;
    await supabase.from("pl_survey_questions").delete().eq("survey_id", surveyId);
  } else {
    const { data, error } = await supabase.from("pl_surveys")
      .insert({ ...rec, created_by: user.id }).select("id").single();
    if (error) throw error;
    surveyId = data.id;
  }
  if (questions && questions.length) {
    const rows = questions.map((q, i) => ({
      survey_id: surveyId, position: i,
      type: q.type || "text", prompt: q.prompt,
      options: q.options || [],
    }));
    const { error } = await supabase.from("pl_survey_questions").insert(rows);
    if (error) throw error;
  }
  return surveyId;
}

export async function deleteSurvey(id) {
  const { error } = await supabase.from("pl_surveys").delete().eq("id", id);
  if (error) throw error;
}

export async function listSurveyResponses() {
  const { data, error } = await supabase.from("pl_survey_responses")
    .select("*").order("submitted_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function submitSurveyResponse(survey_id, answers) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_survey_responses").insert({
    survey_id, student_id: user.id, answers,
  });
  if (error) throw error;
}

/* ═══════════════ RESOURCES (INSTRUCTIONS & POLICY MANUALS) ══════ */

export async function listResources() {
  const { data, error } = await supabase.from("pl_resources")
    .select("*").order("sort_order").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveResource(res) {
  const { data: { user } } = await supabase.auth.getUser();
  let file_path = res.file_path || null;
  if (res._file) file_path = await uploadFile("homework-submissions", res._file);
  const rec = {
    title: res.title, description: res.description || null,
    category: res.category || "instructions",
    file_path, link_url: res.link_url || null,
    program: res.program || "all",
    sort_order: Number(res.sort_order) || 0, active: res.active !== false,
  };
  if (res.id) {
    const { error } = await supabase.from("pl_resources").update(rec).eq("id", res.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("pl_resources").insert({ ...rec, created_by: user.id });
    if (error) throw error;
  }
}

export async function deleteResource(id) {
  const { error } = await supabase.from("pl_resources").delete().eq("id", id);
  if (error) throw error;
}

/* ═══════════════ ANNOUNCEMENTS (dashboard notices) ══════════════ */

export async function listAnnouncements() {
  const { data, error } = await supabase.from("pl_announcements")
    .select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveAnnouncement(a) {
  const { data: { user } } = await supabase.auth.getUser();
  const rec = { title: a.title, body: a.body, program: a.program || "all", active: a.active !== false };
  if (a.id) {
    const { error } = await supabase.from("pl_announcements").update(rec).eq("id", a.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("pl_announcements").insert({ ...rec, created_by: user.id });
    if (error) throw error;
  }
}

export async function deleteAnnouncement(id) {
  const { error } = await supabase.from("pl_announcements").delete().eq("id", id);
  if (error) throw error;
}
