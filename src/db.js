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

export async function createBook({ title, author, description, pages, program, video_url, file }) {
  let file_path = null;
  if (file) file_path = await uploadFile("books", file);
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_books").insert({
    title, author, description, pages: Number(pages) || 0, program: program || "all",
    video_url: video_url || null, file_path, created_by: user.id,
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
  return (data || []).map((t) => ({
    ...t,
    questions: (t.pl_questions || []).sort((a, b) => a.position - b.position),
  }));
}

export async function saveTest(test, questions) {
  const { data: { user } } = await supabase.auth.getUser();
  let testId = test.id;

  if (testId) {
    const { error } = await supabase.from("pl_tests").update({
      title: test.title, description: test.description, book_id: test.book_id || null, program: test.program || "all",
    }).eq("id", testId);
    if (error) throw error;
    // simplest reliable sync: clear old questions, insert current set
    await supabase.from("pl_questions").delete().eq("test_id", testId);
  } else {
    const { data, error } = await supabase.from("pl_tests").insert({
      title: test.title, description: test.description, book_id: test.book_id || null, program: test.program || "all", created_by: user.id,
    }).select("id").single();
    if (error) throw error;
    testId = data.id;
  }

  const rows = questions.map((q, i) => ({
    test_id: testId,
    position: i,
    type: q.type,
    prompt: q.prompt,
    points: Number(q.points) || 0,
    options: q.options || [],
    correct_answer: q.correct_answer ?? null,
  }));
  if (rows.length) {
    const { error } = await supabase.from("pl_questions").insert(rows);
    if (error) throw error;
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
   even if email delivery isn't configured yet. */
export async function sendEmail({ to, subject, html }) {
  try {
    const r = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, html }),
    });
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}

/* ---------------- SYLLABI ---------------- */
export async function listSyllabi() {
  const { data, error } = await supabase.from("pl_syllabi").select("*");
  if (error) throw error;
  return data;
}

export async function saveSyllabus({ term, title, content, file }) {
  const { data: { user } } = await supabase.auth.getUser();
  const patch = { term, title, content, created_by: user.id, updated_at: new Date().toISOString() };
  if (file) patch.file_path = await uploadFile("syllabi", file);
  const { error } = await supabase.from("pl_syllabi").upsert(patch, { onConflict: "term" });
  if (error) throw error;
}

/* ---------------- HOMEWORK ---------------- */
export async function listHomework() {
  const { data, error } = await supabase
    .from("pl_homework")
    .select("*, pl_homework_questions(*)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map((h) => ({
    ...h,
    questions: (h.pl_homework_questions || []).sort((a, b) => a.position - b.position),
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
      points: Number(hw.points) || 0, program: hw.program || "all", file_path,
    }).eq("id", hwId);
    if (error) throw error;
    await supabase.from("pl_homework_questions").delete().eq("homework_id", hwId);
  } else {
    const { data, error } = await supabase.from("pl_homework").insert({
      title: hw.title, instructions: hw.instructions, due_date: hw.due_date || null,
      points: Number(hw.points) || 0, program: hw.program || "all", file_path, created_by: user.id,
    }).select("id").single();
    if (error) throw error;
    hwId = data.id;
  }

  const rows = (questions || []).map((q, i) => ({
    homework_id: hwId, position: i, type: q.type, prompt: q.prompt,
    points: Number(q.points) || 0, options: q.options || [], correct_answer: q.correct_answer ?? null,
  }));
  if (rows.length) {
    const { error } = await supabase.from("pl_homework_questions").insert(rows);
    if (error) throw error;
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

export async function submitHomework({ homework_id, answers, response, file, max_points }) {
  const { data: { user } } = await supabase.auth.getUser();
  let file_path = null;
  if (file) file_path = await uploadFile("homework-submissions", file);
  const { error } = await supabase.from("pl_homework_submissions").insert({
    homework_id, student_id: user.id, answers: answers || {}, response: response || "", file_path, max_points,
  });
  if (error) throw error;
}

export async function gradeHomework(id, { manual, score, max_points, feedback }) {
  const { error } = await supabase.from("pl_homework_submissions").update({
    manual: manual || {}, score, max_points, feedback, status: "graded",
  }).eq("id", id);
  if (error) throw error;
}

/* ---------------- PROGRAMS ---------------- */
export async function setStudentProgram(id, program) {
  const { error } = await supabase.from("pl_profiles").update({ program: program || null }).eq("id", id);
  if (error) throw error;
}
