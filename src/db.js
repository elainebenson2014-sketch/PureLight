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

export async function createBook({ title, author, description, pages, file }) {
  let file_path = null;
  if (file) file_path = await uploadFile("books", file);
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("pl_books").insert({
    title, author, description, pages: Number(pages) || 0, file_path, created_by: user.id,
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
      title: test.title, description: test.description, book_id: test.book_id || null,
    }).eq("id", testId);
    if (error) throw error;
    // simplest reliable sync: clear old questions, insert current set
    await supabase.from("pl_questions").delete().eq("test_id", testId);
  } else {
    const { data, error } = await supabase.from("pl_tests").insert({
      title: test.title, description: test.description, book_id: test.book_id || null, created_by: user.id,
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
