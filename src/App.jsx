import React, { useState, useEffect, useCallback } from "react";
import {
  BookOpen, FileText, Users, Mail, LayoutDashboard, Plus, Upload, Trash2, Send,
  ArrowLeft, ChevronRight, Award, Clock, PencilLine, X, Check, Inbox, Library,
  ClipboardCheck, Sparkles, ScrollText, NotebookPen, CalendarDays, ExternalLink, PlayCircle, GraduationCap,
} from "lucide-react";
import { supabase } from "./supabaseClient";
import * as db from "./db";
import {
  C, FONTS, QTYPE, inputStyle, Btn, Card, Field, PageHead, Stat, Shell, Spinner, Initials,
} from "./ui.jsx";

const sumPoints = (questions) => (questions || []).reduce((a, q) => a + (Number(q.points) || 0), 0);
const fdate = (d) => (d ? String(d).slice(0, 10) : "");

function autoScore(test, sub) {
  let auto = 0;
  for (const q of test.questions) {
    const a = sub.answers?.[q.id];
    if (q.type === "mc" && String(a) === String(q.correct_answer)) auto += q.points;
    if (q.type === "tf" && a === q.correct_answer) auto += q.points;
  }
  return auto;
}

const PROGRAMS = [
  { key: "all", label: "All programs" },
  { key: "certificate", label: "Certificate" },
  { key: "associate", label: "Associate" },
  { key: "bachelor", label: "Bachelor" },
  { key: "master", label: "Master" },
  { key: "doctorate", label: "Doctorate" },
];
const STUDENT_PROGRAMS = PROGRAMS.filter((p) => p.key !== "all");
const programLabel = (k) => PROGRAMS.find((p) => p.key === k)?.label || "All programs";
const visibleFor = (items, program) => (items || []).filter((it) => it.program === "all" || it.program === program);

function ProgramSelect({ value, onChange, includeAll = true }) {
  const list = includeAll ? PROGRAMS : STUDENT_PROGRAMS;
  return (
    <select style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)}>
      {!includeAll && <option value="">— choose level —</option>}
      {list.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
    </select>
  );
}

function CourseFields({ courses, courseId, module, onCourse, onModule }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Field label="Course (optional)">
        <select style={inputStyle} value={courseId || ""} onChange={(e) => onCourse(e.target.value)}>
          <option value="">— None —</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
      </Field>
      <Field label="Module / Week (optional)">
        <input style={inputStyle} value={module || ""} onChange={(e) => onModule(e.target.value)} placeholder="e.g. Week 1" />
      </Field>
    </div>
  );
}

const courseLabel = (courses, id, mod) => {
  const c = courses.find((x) => x.id === id);
  if (!c && !mod) return "";
  return `${c ? c.title : "General"}${mod ? " · " + mod : ""}`;
};

function groupByCourseModule(items, courses) {
  const byCourse = new Map();
  for (const it of items) {
    const cid = it.course_id || "none";
    if (!byCourse.has(cid)) byCourse.set(cid, []);
    byCourse.get(cid).push(it);
  }
  const order = [...courses, { id: "none", title: "General" }];
  const out = [];
  for (const c of order) {
    const list = byCourse.get(c.id);
    if (!list || !list.length) continue;
    const byMod = new Map();
    for (const it of list) {
      const m = it.module && it.module.trim() ? it.module.trim() : "";
      if (!byMod.has(m)) byMod.set(m, []);
      byMod.get(m).push(it);
    }
    const mods = [...byMod.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([module, its]) => ({ module, items: its }));
    out.push({ course: c, modules: mods });
  }
  return out;
}

function Grouped({ items, courses, children }) {
  const groups = groupByCourseModule(items, courses);
  return (
    <>
      {groups.map((g) => (
        <div key={g.course.id} style={{ marginBottom: 20 }}>
          <div className="pl-display" style={{ fontSize: 21, fontWeight: 600, color: C.ink, marginBottom: 10, borderBottom: `2px solid ${C.goldSoft}`, paddingBottom: 5 }}>{g.course.title}</div>
          {g.modules.map((m, mi) => (
            <div key={mi} style={{ marginBottom: 14 }}>
              {m.module && <div className="pl-body" style={{ fontSize: 12.5, fontWeight: 700, color: C.gold, textTransform: "uppercase", letterSpacing: ".06em", margin: "8px 0" }}>{m.module}</div>}
              {children(m.items)}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/* ============================================================ ROOT */
export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!session) { setProfile(null); setLoading(false); return; }
      setLoading(true);
      try {
        const p = await db.getProfile();
        if (active) setProfile(p);
      } catch (e) { console.error(e); }
      if (active) setLoading(false);
    }
    load();
    return () => { active = false; };
  }, [session]);

  async function logout() { await supabase.auth.signOut(); setProfile(null); }

  return (
    <div className="pl-body" style={{ minHeight: "100vh", background: C.paper, color: C.text }}>
      <style>{FONTS}</style>
      {!session ? (
        <Auth />
      ) : loading ? (
        <div className="flex items-center justify-center" style={{ minHeight: "100vh" }}><Spinner label="Preparing your portal…" /></div>
      ) : !profile ? (
        <div className="flex items-center justify-center" style={{ minHeight: "100vh", padding: 20 }}>
          <Card style={{ maxWidth: 420, textAlign: "center" }}>
            <p className="pl-body">We couldn't load your profile. Try signing out and back in.</p>
            <div style={{ marginTop: 12 }}><Btn onClick={logout}>Sign out</Btn></div>
          </Card>
        </div>
      ) : profile.role === "instructor" ? (
        <InstructorPortal profile={profile} onLogout={logout} />
      ) : (
        <StudentPortal profile={profile} onLogout={logout} />
      )}
    </div>
  );
}

/* ============================================================ AUTH */
function Auth() {
  const [tab, setTab] = useState("signin");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit() {
    setMsg(null); setBusy(true);
    try {
      if (tab === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: form.email.trim(), password: form.password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email: form.email.trim(), password: form.password,
          options: { data: { full_name: form.name.trim() } },
        });
        if (error) throw error;
        setMsg({ ok: true, text: "Account created. If email confirmation is on, check your inbox, then sign in." });
        setTab("signin");
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message || "Something went wrong." });
    }
    setBusy(false);
  }

  return (
    <div className="flex items-center justify-center" style={{ minHeight: "100vh", padding: 20,
      background: `radial-gradient(1200px 600px at 50% -10%, ${C.ink2} 0%, ${C.ink} 55%, #0d1528 100%)` }}>
      <div className="pl-fade w-full" style={{ maxWidth: 430 }}>
        <div className="text-center" style={{ marginBottom: 24 }}>
          <div className="inline-flex items-center justify-center" style={{ width: 64, height: 64, borderRadius: "50%",
            background: `radial-gradient(circle at 35% 30%, ${C.goldSoft}, ${C.gold})`, boxShadow: `0 0 40px ${C.gold}55`, marginBottom: 16 }}>
            <Sparkles size={30} color="#1a1407" />
          </div>
          <div className="pl-display" style={{ color: "#fff", fontSize: 34, fontWeight: 600 }}>NCTS PureLight</div>
          <div className="pl-body" style={{ color: C.goldSoft, fontSize: 14, letterSpacing: ".22em", textTransform: "uppercase", marginTop: 4 }}>School of Excellence</div>
        </div>

        <Card style={{ padding: 26 }}>
          <div className="grid grid-cols-2 gap-2" style={{ marginBottom: 20 }}>
            {[["signin", "Sign In"], ["signup", "Create Account"]].map(([k, label]) => (
              <button key={k} onClick={() => { setTab(k); setMsg(null); }} className="pl-body pl-press" style={{
                padding: 10, borderRadius: 9, cursor: "pointer", fontWeight: 600, fontSize: 14,
                border: `1px solid ${tab === k ? C.ink : C.line}`, background: tab === k ? C.ink : "#fff", color: tab === k ? "#fff" : C.muted }}>{label}</button>
            ))}
          </div>

          {tab === "signup" && (
            <Field label="Full name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name" /></Field>
          )}
          <Field label="Email"><input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" /></Field>
          <Field label="Password"><input style={inputStyle} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" onKeyDown={(e) => e.key === "Enter" && submit()} /></Field>

          {msg && (
            <div className="pl-body" style={{ fontSize: 13, padding: "9px 12px", borderRadius: 8, marginBottom: 12,
              background: msg.ok ? C.greenSoft : C.roseSoft, color: msg.ok ? C.green : C.rose }}>{msg.text}</div>
          )}

          <Btn full kind="gold" onClick={submit} disabled={busy}>{busy ? "Please wait…" : tab === "signin" ? "Sign in" : "Create account"}</Btn>
        </Card>
        <div className="text-center pl-body" style={{ color: "#ffffff88", fontSize: 12, marginTop: 16 }}>New students create an account. Instructor access is granted by the administrator.</div>
      </div>
    </div>
  );
}

/* ============================================================ INSTRUCTOR */
function InstructorPortal({ profile, onLogout }) {
  const [active, setActive] = useState("dash");
  const [books, setBooks] = useState([]);
  const [tests, setTests] = useState([]);
  const [subs, setSubs] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [messages, setMessages] = useState([]);
  const [syllabi, setSyllabi] = useState([]);
  const [homework, setHomework] = useState([]);
  const [hwSubs, setHwSubs] = useState([]);
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [b, t, s, p, m, sy, hw, hs, co] = await Promise.all([
        db.listBooks(), db.listTests(), db.listSubmissions(), db.listProfiles(), db.listMessages(),
        db.listSyllabi(), db.listHomework(), db.listHomeworkSubmissions(), db.listCourses(),
      ]);
      setBooks(b); setTests(t); setSubs(s); setProfiles(p); setMessages(m);
      setSyllabi(sy); setHomework(hw); setHwSubs(hs); setCourses(co);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const students = profiles.filter((p) => p.role === "student");
  const pending = subs.filter((s) => s.status !== "graded").length;
  const pendingHw = hwSubs.filter((s) => s.status !== "graded").length;

  const nav = [
    { key: "dash", label: "Dashboard", icon: LayoutDashboard },
    { key: "courses", label: "Courses", icon: GraduationCap },
    { key: "library", label: "Library", icon: Library },
    { key: "syllabus", label: "Syllabus", icon: ScrollText },
    { key: "tests", label: "Tests", icon: FileText },
    { key: "homework", label: "Homework", icon: NotebookPen },
    { key: "grading", label: "Grading", icon: ClipboardCheck },
    { key: "students", label: "Students", icon: Users },
    { key: "messages", label: "Messages", icon: Mail },
  ];

  return (
    <Shell user={profile} onLogout={onLogout} nav={nav} active={active} setActive={setActive} badge={{ grading: pending, homework: pendingHw }}>
      {loading ? <Spinner /> : (
        <>
          {active === "dash" && <InstructorDash {...{ students, books, tests, subs, profiles, setActive }} />}
          {active === "courses" && <CoursesManager courses={courses} refresh={refresh} />}
          {active === "library" && <LibraryManager books={books} courses={courses} refresh={refresh} profile={profile} />}
          {active === "syllabus" && <SyllabusManager syllabi={syllabi} refresh={refresh} />}
          {active === "tests" && <TestsManager tests={tests} books={books} courses={courses} refresh={refresh} />}
          {active === "homework" && <HomeworkManager homework={homework} hwSubs={hwSubs} profiles={profiles} courses={courses} refresh={refresh} />}
          {active === "grading" && <Grading subs={subs} tests={tests} profiles={profiles} refresh={refresh} />}
          {active === "students" && <StudentsManager students={students} refresh={refresh} />}
          {active === "messages" && <MessagesView messages={messages} students={students} profile={profile} canSend refresh={refresh} />}
        </>
      )}
    </Shell>
  );
}

function InstructorDash({ students, books, tests, subs, profiles, setActive }) {
  const pending = subs.filter((s) => s.status !== "graded");
  const nameOf = (id) => profiles.find((p) => p.id === id)?.full_name || "Student";
  const titleOf = (id) => tests.find((t) => t.id === id)?.title || "Test";
  return (
    <>
      <PageHead title="Dashboard" sub="Welcome back. Here is the state of your school." />
      <div className="grid grid-cols-4 gap-4" style={{ marginBottom: 24 }}>
        <Stat icon={Users} label="Enrolled students" value={students.length} />
        <Stat icon={BookOpen} label="Books in library" value={books.length} />
        <Stat icon={FileText} label="Tests created" value={tests.length} />
        <Stat icon={ClipboardCheck} label="Awaiting grading" value={pending.length} tone={C.gold} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
            <h3 className="pl-display" style={{ fontSize: 20, fontWeight: 600, color: C.ink, margin: 0 }}>Needs your attention</h3>
            <Btn small kind="ghost" onClick={() => setActive("grading")}>Open grading</Btn>
          </div>
          {pending.length === 0 ? <div className="pl-body" style={{ color: C.muted, fontSize: 14, padding: "10px 0" }}>All caught up.</div> :
            pending.map((p) => (
              <div key={p.id} className="flex items-center justify-between" style={{ padding: "11px 0", borderBottom: `1px solid ${C.line}` }}>
                <div>
                  <div className="pl-body" style={{ fontWeight: 600, fontSize: 14.5 }}>{nameOf(p.student_id)}</div>
                  <div className="pl-body" style={{ fontSize: 12.5, color: C.muted }}>{titleOf(p.test_id)}</div>
                </div>
                <span className="pl-body inline-flex items-center gap-1" style={{ fontSize: 12, color: C.gold, fontWeight: 600 }}><Clock size={13} /> {fdate(p.submitted_at)}</span>
              </div>
            ))}
        </Card>
        <Card>
          <h3 className="pl-display" style={{ fontSize: 20, fontWeight: 600, color: C.ink, margin: "0 0 14px" }}>Recent library additions</h3>
          {books.slice(0, 3).map((b) => (
            <div key={b.id} className="flex items-center gap-3" style={{ padding: "11px 0", borderBottom: `1px solid ${C.line}` }}>
              <div className="inline-flex items-center justify-center" style={{ width: 34, height: 44, borderRadius: 5, background: C.ink, color: C.goldSoft }}><BookOpen size={16} /></div>
              <div style={{ flex: 1 }}>
                <div className="pl-body" style={{ fontWeight: 600, fontSize: 14.5 }}>{b.title}</div>
                <div className="pl-body" style={{ fontSize: 12.5, color: C.muted }}>{b.pages} pp • added {fdate(b.created_at)}</div>
              </div>
            </div>
          ))}
          {books.length === 0 && <div className="pl-body" style={{ color: C.muted }}>No books yet.</div>}
        </Card>
      </div>
    </>
  );
}

/* ---------- LIBRARY ---------- */
function LibraryManager({ books, courses, refresh, profile }) {
  const [mode, setMode] = useState("list");
  const [form, setForm] = useState({ title: "", author: profile.full_name, description: "", pages: "", program: "all", video_url: "", course_id: "", module: "", file: null });
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!form.title.trim()) return;
    setBusy(true);
    try { await db.createBook(form); await refresh(); setForm({ title: "", author: profile.full_name, description: "", pages: "", program: "all", video_url: "", course_id: "", module: "", file: null }); setMode("list"); }
    catch (e) { window.alert(e.message || "Upload failed"); }
    setBusy(false);
  }
  async function remove(id) {
    if (!window.confirm("Delete this book?")) return;
    try { await db.deleteBook(id); await refresh(); } catch (e) { window.alert(e.message); }
  }

  if (mode === "create") {
    return (
      <>
        <PageHead title="Add a Book" sub="Create a title and upload its PDF." action={<Btn kind="ghost" icon={ArrowLeft} onClick={() => setMode("list")}>Back</Btn>} />
        <Card style={{ maxWidth: 640 }}>
          <Field label="Title"><input style={inputStyle} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Foundations of Biblical Theology" /></Field>
          <Field label="Author"><input style={inputStyle} value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} /></Field>
          <Field label="Description"><textarea style={{ ...inputStyle, minHeight: 90 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Program / level"><ProgramSelect value={form.program} onChange={(v) => setForm({ ...form, program: v })} /></Field>
          <Field label="Video link — YouTube, Vimeo, etc. (optional)"><input style={inputStyle} value={form.video_url} onChange={(e) => setForm({ ...form, video_url: e.target.value })} placeholder="https://youtu.be/…" /></Field>
          <CourseFields courses={courses} courseId={form.course_id} module={form.module} onCourse={(v) => setForm({ ...form, course_id: v })} onModule={(v) => setForm({ ...form, module: v })} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Pages"><input style={inputStyle} type="number" value={form.pages} onChange={(e) => setForm({ ...form, pages: e.target.value })} /></Field>
            <Field label="PDF or video file (optional)">
              <label className="flex items-center gap-2" style={{ ...inputStyle, padding: 8, cursor: "pointer" }}>
                <Upload size={16} color={C.muted} />
                <span className="pl-body" style={{ fontSize: 14, color: form.file ? C.text : C.muted }}>{form.file ? form.file.name : "Choose a file…"}</span>
                <input type="file" accept="application/pdf,video/*" style={{ display: "none" }} onChange={(e) => setForm({ ...form, file: e.target.files[0] })} />
              </label>
            </Field>
          </div>
          <div className="flex gap-2" style={{ marginTop: 8 }}>
            <Btn icon={Check} onClick={save} disabled={busy}>{busy ? "Uploading…" : "Publish to library"}</Btn>
            <Btn kind="ghost" onClick={() => setMode("list")}>Cancel</Btn>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHead title="Library" sub="Books available to your students." action={<Btn icon={Plus} onClick={() => setMode("create")}>Add book</Btn>} />
      {books.length === 0 ? <Card><span className="pl-body" style={{ color: C.muted }}>No books yet — add your first.</span></Card> :
        <div className="grid grid-cols-3 gap-4">
          {books.map((b) => (
            <Card key={b.id}>
              <div className="flex items-center justify-center" style={{ height: 110, borderRadius: 9, background: `linear-gradient(150deg, ${C.ink}, ${C.ink2})`, marginBottom: 14 }}><BookOpen size={34} color={C.goldSoft} /></div>
              <h3 className="pl-display" style={{ fontSize: 18, fontWeight: 600, color: C.ink, margin: 0, lineHeight: 1.2 }}>{b.title}</h3>
              <div className="pl-body" style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>{b.author} • {b.pages} pp • {programLabel(b.program)}</div>
              <p className="pl-body" style={{ fontSize: 13.5, color: C.text, marginTop: 8, lineHeight: 1.5 }}>{b.description}</p>
              <div className="flex justify-between items-center" style={{ marginTop: 14 }}>
                <span className="pl-body" style={{ fontSize: 12, color: C.muted }}>{b.video_url ? "Video link" : b.file_path ? "File attached" : "No media"}</span>
                <button onClick={() => remove(b.id)} className="pl-press" style={{ background: "none", border: "none", cursor: "pointer", color: C.rose }}><Trash2 size={16} /></button>
              </div>
            </Card>
          ))}
        </div>}
    </>
  );
}

/* ---------- TESTS ---------- */
function TestsManager({ tests, books, courses, refresh }) {
  const [mode, setMode] = useState("list");
  const [draft, setDraft] = useState(null);
  const [qs, setQs] = useState([]);
  const [busy, setBusy] = useState(false);

  function newTest() { setDraft({ id: null, title: "", description: "", book_id: books[0]?.id || "", program: "all", course_id: "", module: "" }); setQs([]); setMode("build"); }
  function editTest(t) { setDraft({ id: t.id, title: t.title, description: t.description, book_id: t.book_id || "", program: t.program || "all", course_id: t.course_id || "", module: t.module || "" }); setQs(t.questions.map((q) => ({ ...q }))); setMode("build"); }

  function addQ(type) {
    const base = { id: "tmp" + Date.now() + Math.random(), type, prompt: "", points: type === "essay" ? 20 : type === "short" ? 10 : 5 };
    if (type === "mc") Object.assign(base, { options: ["", "", "", ""], correct_answer: "0" });
    if (type === "tf") base.correct_answer = "true";
    setQs([...qs, base]);
  }
  const upQ = (id, patch) => setQs(qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const delQ = (id) => setQs(qs.filter((q) => q.id !== id));

  async function save() {
    if (!draft.title.trim() || qs.length === 0) { window.alert("Add a title and at least one question."); return; }
    setBusy(true);
    try { await db.saveTest(draft, qs); await refresh(); setMode("list"); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }
  async function remove(id) {
    if (!window.confirm("Delete this test?")) return;
    try { await db.deleteTest(id); await refresh(); } catch (e) { window.alert(e.message); }
  }

  if (mode === "build" && draft) {
    return (
      <>
        <PageHead title="Test Builder" sub="Mix question types. Multiple-choice and true/false grade automatically." action={<Btn kind="ghost" icon={ArrowLeft} onClick={() => setMode("list")}>Back</Btn>} />
        <Card style={{ marginBottom: 18 }}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Test title"><input style={inputStyle} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Midterm Examination" /></Field>
            <Field label="Linked book">
              <select style={inputStyle} value={draft.book_id} onChange={(e) => setDraft({ ...draft, book_id: e.target.value })}>
                <option value="">— None —</option>
                {books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Instructions"><input style={inputStyle} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What this test covers" /></Field>
          <Field label="Program / level"><ProgramSelect value={draft.program} onChange={(v) => setDraft({ ...draft, program: v })} /></Field>
          <CourseFields courses={courses} courseId={draft.course_id} module={draft.module} onCourse={(v) => setDraft({ ...draft, course_id: v })} onModule={(v) => setDraft({ ...draft, module: v })} />
        </Card>

        {qs.map((q, i) => (
          <Card key={q.id} style={{ marginBottom: 12 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
              <span className="pl-body" style={{ fontWeight: 700, color: C.gold, fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em" }}>Q{i + 1} · {QTYPE[q.type]}</span>
              <div className="flex items-center gap-3">
                <label className="pl-body flex items-center gap-1" style={{ fontSize: 13, color: C.muted }}>Points
                  <input type="number" value={q.points} onChange={(e) => upQ(q.id, { points: Number(e.target.value) })} style={{ ...inputStyle, width: 64, padding: "5px 8px" }} />
                </label>
                <button onClick={() => delQ(q.id)} className="pl-press" style={{ background: "none", border: "none", cursor: "pointer", color: C.rose }}><Trash2 size={16} /></button>
              </div>
            </div>
            <textarea style={{ ...inputStyle, minHeight: 52 }} placeholder="Question prompt…" value={q.prompt} onChange={(e) => upQ(q.id, { prompt: e.target.value })} />
            {q.type === "mc" && (
              <div style={{ marginTop: 10 }}>
                {q.options.map((opt, oi) => (
                  <div key={oi} className="flex items-center gap-2" style={{ marginBottom: 7 }}>
                    <button onClick={() => upQ(q.id, { correct_answer: String(oi) })} className="pl-press inline-flex items-center justify-center" style={{ width: 24, height: 24, borderRadius: "50%", border: `2px solid ${String(q.correct_answer) === String(oi) ? C.green : C.line}`, background: String(q.correct_answer) === String(oi) ? C.green : "#fff", cursor: "pointer" }}>{String(q.correct_answer) === String(oi) && <Check size={13} color="#fff" />}</button>
                    <input style={{ ...inputStyle, padding: "7px 10px" }} placeholder={`Option ${oi + 1}`} value={opt} onChange={(e) => { const o = [...q.options]; o[oi] = e.target.value; upQ(q.id, { options: o }); }} />
                  </div>
                ))}
                <div className="pl-body" style={{ fontSize: 12, color: C.muted }}>Click the circle to mark the correct answer.</div>
              </div>
            )}
            {q.type === "tf" && (
              <div className="flex gap-2" style={{ marginTop: 10 }}>
                {["true", "false"].map((v) => (
                  <button key={v} onClick={() => upQ(q.id, { correct_answer: v })} className="pl-press" style={{ padding: "7px 18px", borderRadius: 8, cursor: "pointer", textTransform: "capitalize", fontWeight: 600, border: `1px solid ${q.correct_answer === v ? C.green : C.line}`, background: q.correct_answer === v ? C.greenSoft : "#fff", color: q.correct_answer === v ? C.green : C.muted }}>{v}</button>
                ))}
              </div>
            )}
            {(q.type === "short" || q.type === "essay") && <div className="pl-body" style={{ marginTop: 10, fontSize: 13, color: C.muted, fontStyle: "italic" }}>Graded manually after submission.</div>}
          </Card>
        ))}

        <Card>
          <div className="pl-body" style={{ fontWeight: 600, color: C.ink, marginBottom: 10 }}>Add a question</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(QTYPE).map(([k, v]) => <Btn key={k} small kind="ghost" icon={Plus} onClick={() => addQ(k)}>{v}</Btn>)}
          </div>
        </Card>

        <div className="flex items-center justify-between" style={{ marginTop: 18 }}>
          <span className="pl-body" style={{ color: C.muted, fontSize: 14 }}>{qs.length} questions · {sumPoints(qs)} points total</span>
          <Btn icon={Check} kind="gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save test"}</Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Tests" sub="Build and manage assessments." action={<Btn icon={Plus} onClick={newTest}>Create test</Btn>} />
      {tests.length === 0 ? <Card><span className="pl-body" style={{ color: C.muted }}>No tests yet.</span></Card> :
        <div className="flex flex-col gap-3">
          {tests.map((t) => (
            <Card key={t.id}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="pl-display" style={{ fontSize: 19, fontWeight: 600, color: C.ink, margin: 0 }}>{t.title}</h3>
                  <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{books.find((b) => b.id === t.book_id)?.title || "Unlinked"} · {t.questions.length} questions · {sumPoints(t.questions)} pts · {programLabel(t.program)}</div>
                </div>
                <div className="flex gap-2">
                  <Btn small kind="ghost" icon={PencilLine} onClick={() => editTest(t)}>Edit</Btn>
                  <button onClick={() => remove(t.id)} className="pl-press" style={{ background: "none", border: "none", cursor: "pointer", color: C.rose }}><Trash2 size={18} /></button>
                </div>
              </div>
            </Card>
          ))}
        </div>}
    </>
  );
}

/* ---------- GRADING ---------- */
function Grading({ subs, tests, profiles, refresh }) {
  const [openId, setOpenId] = useState(null);
  const [manual, setManual] = useState({});
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const nameOf = (id) => profiles.find((p) => p.id === id)?.full_name || "Student";

  function open(s) { setOpenId(s.id); setManual(s.manual || {}); setFeedback(s.feedback || ""); }

  if (openId) {
    const sub = subs.find((s) => s.id === openId);
    const test = tests.find((t) => t.id === sub.test_id);
    if (!test) { setOpenId(null); return null; }
    const auto = autoScore(test, sub);
    const manualTotal = test.questions.filter((q) => q.type === "short" || q.type === "essay").reduce((a, q) => a + (Number(manual[q.id] ?? 0) || 0), 0);
    const max = sumPoints(test.questions);
    const total = auto + manualTotal;

    async function finalize() {
      setBusy(true);
      try { await db.gradeSubmission(openId, { manual, score: total, max_score: max, feedback }); await refresh(); setOpenId(null); }
      catch (e) { window.alert(e.message); }
      setBusy(false);
    }

    return (
      <>
        <PageHead title="Grade Submission" sub={`${nameOf(sub.student_id)} · ${test.title}`} action={<Btn kind="ghost" icon={ArrowLeft} onClick={() => setOpenId(null)}>Back</Btn>} />
        {test.questions.map((q, i) => {
          const ans = sub.answers?.[q.id];
          const isAuto = q.type === "mc" || q.type === "tf";
          const correct = q.type === "mc" ? String(ans) === String(q.correct_answer) : q.type === "tf" ? ans === q.correct_answer : false;
          return (
            <Card key={q.id} style={{ marginBottom: 12 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="pl-body" style={{ fontWeight: 700, color: C.gold, fontSize: 12.5, textTransform: "uppercase", letterSpacing: ".06em" }}>Q{i + 1} · {QTYPE[q.type]} · {q.points} pts</span>
                {isAuto && <span className="pl-body" style={{ fontSize: 12.5, fontWeight: 700, color: correct ? C.green : C.rose }}>{correct ? "Correct (auto)" : "Incorrect (auto)"}</span>}
              </div>
              <p className="pl-body" style={{ fontWeight: 600, color: C.ink, marginBottom: 8 }}>{q.prompt}</p>
              {q.type === "mc" && <div className="pl-body" style={{ fontSize: 14 }}>Student answered: <b>{q.options[Number(ans)] ?? "—"}</b> · Correct: {q.options[Number(q.correct_answer)]}</div>}
              {q.type === "tf" && <div className="pl-body" style={{ fontSize: 14, textTransform: "capitalize" }}>Student answered: <b>{ans ?? "—"}</b> · Correct: {q.correct_answer}</div>}
              {(q.type === "short" || q.type === "essay") && (
                <>
                  <div className="pl-body" style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 14, lineHeight: 1.55 }}>{ans || <i style={{ color: C.muted }}>No response</i>}</div>
                  <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
                    <span className="pl-body" style={{ fontSize: 13, color: C.muted, fontWeight: 600 }}>Award points:</span>
                    <input type="number" min={0} max={q.points} value={manual[q.id] ?? ""} placeholder="0"
                      onChange={(e) => setManual({ ...manual, [q.id]: Math.min(q.points, Math.max(0, Number(e.target.value) || 0)) })}
                      style={{ ...inputStyle, width: 80, padding: "6px 10px" }} />
                    <span className="pl-body" style={{ fontSize: 13, color: C.muted }}>/ {q.points}</span>
                  </div>
                </>
              )}
            </Card>
          );
        })}
        <Card>
          <Field label="Feedback to student"><textarea style={{ ...inputStyle, minHeight: 80 }} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Comments, encouragement, next steps…" /></Field>
          <div className="flex items-center justify-between">
            <div className="pl-display" style={{ fontSize: 24, fontWeight: 600, color: C.ink }}>{total} <span style={{ color: C.muted, fontSize: 18 }}>/ {max}</span> <span className="pl-body" style={{ fontSize: 15, color: C.gold, marginLeft: 8 }}>{max ? Math.round((total / max) * 100) : 0}%</span></div>
            <Btn icon={Award} kind="gold" onClick={finalize} disabled={busy}>{busy ? "Saving…" : "Finalize & release grade"}</Btn>
          </div>
        </Card>
      </>
    );
  }

  const pending = subs.filter((s) => s.status !== "graded");
  const graded = subs.filter((s) => s.status === "graded");
  return (
    <>
      <PageHead title="Grading" sub="Submissions awaiting review and graded history." />
      <h3 className="pl-display" style={{ fontSize: 18, color: C.ink, marginBottom: 10 }}>Awaiting grading</h3>
      <div className="flex flex-col gap-3" style={{ marginBottom: 26 }}>
        {pending.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>Nothing pending.</span></Card>}
        {pending.map((s) => (
          <Card key={s.id}>
            <div className="flex items-center justify-between">
              <div>
                <div className="pl-body" style={{ fontWeight: 600, fontSize: 15.5 }}>{nameOf(s.student_id)}</div>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted }}>{tests.find((t) => t.id === s.test_id)?.title || "Test"} · submitted {fdate(s.submitted_at)}</div>
              </div>
              <Btn icon={ClipboardCheck} onClick={() => open(s)}>Grade</Btn>
            </div>
          </Card>
        ))}
      </div>
      <h3 className="pl-display" style={{ fontSize: 18, color: C.ink, marginBottom: 10 }}>Graded</h3>
      <div className="flex flex-col gap-3">
        {graded.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>No graded submissions yet.</span></Card>}
        {graded.map((s) => (
          <Card key={s.id}>
            <div className="flex items-center justify-between">
              <div>
                <div className="pl-body" style={{ fontWeight: 600, fontSize: 15.5 }}>{nameOf(s.student_id)}</div>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted }}>{tests.find((t) => t.id === s.test_id)?.title || "Test"}</div>
              </div>
              <span className="pl-display" style={{ fontSize: 20, fontWeight: 600, color: C.green }}>{s.score}/{s.max_score}</span>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ---------- STUDENTS ---------- */
function StudentsManager({ students, refresh }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  async function setProg(id, program) {
    try { await db.setStudentProgram(id, program); await refresh(); } catch (e) { window.alert(e.message); }
  }

  async function invite() {
    if (!email.trim()) return;
    setBusy(true); setNote(null);
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const res = await db.sendEmail({
      to: email.trim(),
      subject: "You're invited to NCTS PureLight",
      html: `<p>Grace and peace,</p><p>You have been invited to enroll at <b>NCTS PureLight</b>. Create your student account here:</p><p><a href="${origin}">${origin}</a></p><p>Choose "Create Account" and sign in to begin.</p>`,
    });
    setNote(res.error ? { ok: false, text: "Email not sent — check Resend setup." } : { ok: true, text: "Invitation sent." });
    setEmail(""); setBusy(false);
  }

  return (
    <>
      <PageHead title="Students" sub="Students self-enroll. Invite them by email below." />
      <Card style={{ marginBottom: 18 }}>
        <div className="flex items-end gap-3">
          <div style={{ flex: 1 }}><Field label="Invite a student by email"><input style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="student@example.com" /></Field></div>
          <div style={{ marginBottom: 14 }}><Btn icon={Send} onClick={invite} disabled={busy}>{busy ? "Sending…" : "Send invite"}</Btn></div>
        </div>
        {note && <div className="pl-body" style={{ fontSize: 13, color: note.ok ? C.green : C.rose }}>{note.text}</div>}
      </Card>
      <div className="flex flex-col gap-2">
        {students.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>No students enrolled yet.</span></Card>}
        {students.map((s) => (
          <Card key={s.id} style={{ padding: 16 }}>
            <div className="flex items-center gap-3">
              <Initials name={s.full_name} size={40} />
              <div style={{ flex: 1 }}>
                <div className="pl-body" style={{ fontWeight: 600, fontSize: 15 }}>{s.full_name || "(no name)"}</div>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted }}>{s.email}</div>
              </div>
              <select style={{ ...inputStyle, width: 160, padding: "7px 10px" }} value={s.program || ""} onChange={(e) => setProg(s.id, e.target.value)}>
                <option value="">— level —</option>
                {STUDENT_PROGRAMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ---------- MESSAGES (shared) ---------- */
function MessagesView({ messages, students, profile, canSend, refresh }) {
  const [compose, setCompose] = useState(false);
  const [form, setForm] = useState({ recipient: "all", subject: "", body: "" });
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!form.subject.trim()) return;
    setBusy(true);
    try {
      await db.sendMessage({ recipient: form.recipient, subject: form.subject, body: form.body, sender_name: profile.full_name });
      const emails = form.recipient === "all" ? students.map((s) => s.email).filter(Boolean) : [students.find((s) => s.id === form.recipient)?.email].filter(Boolean);
      if (emails.length) await db.sendEmail({ to: emails, subject: form.subject, html: `<p>${(form.body || "").replace(/\n/g, "<br/>")}</p><hr/><p style="color:#777">Sent from NCTS PureLight</p>` });
      await refresh();
      setForm({ recipient: "all", subject: "", body: "" }); setCompose(false);
    } catch (e) { window.alert(e.message); }
    setBusy(false);
  }

  const nameFor = (id) => students.find((s) => s.id === id)?.full_name || id;

  return (
    <>
      <PageHead title={canSend ? "Messages" : "Inbox"} sub={canSend ? "Email students and post announcements." : "Messages from your instructor."} action={canSend && <Btn icon={PencilLine} onClick={() => setCompose(true)}>Compose</Btn>} />
      {compose && (
        <Card style={{ marginBottom: 18 }}>
          <Field label="To">
            <select style={inputStyle} value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })}>
              <option value="all">All students</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.full_name || s.email}</option>)}
            </select>
          </Field>
          <Field label="Subject"><input style={inputStyle} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
          <Field label="Message"><textarea style={{ ...inputStyle, minHeight: 110 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Btn icon={Send} kind="gold" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send email"}</Btn>
            <Btn kind="ghost" onClick={() => setCompose(false)}>Cancel</Btn>
          </div>
        </Card>
      )}
      <div className="flex flex-col gap-3">
        {messages.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>No messages yet.</span></Card>}
        {messages.map((m) => (
          <Card key={m.id}>
            <div className="flex items-start gap-3">
              <div className="inline-flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 10, background: C.paper2, color: C.ink, flexShrink: 0 }}><Inbox size={18} /></div>
              <div style={{ flex: 1 }}>
                <div className="flex items-center justify-between">
                  <span className="pl-body" style={{ fontWeight: 600, fontSize: 15.5 }}>{m.subject}</span>
                  <span className="pl-body" style={{ fontSize: 12, color: C.muted }}>{fdate(m.created_at)}</span>
                </div>
                <div className="pl-body" style={{ fontSize: 12.5, color: C.gold, fontWeight: 600, marginBottom: 6 }}>From {m.sender_name} · To {m.recipient === "all" ? "All students" : nameFor(m.recipient)}</div>
                <p className="pl-body" style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap", margin: 0 }}>{m.body}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ============================================================ STUDENT */
function StudentPortal({ profile, onLogout }) {
  const [active, setActive] = useState("dash");
  const [books, setBooks] = useState([]);
  const [tests, setTests] = useState([]);
  const [subs, setSubs] = useState([]);
  const [messages, setMessages] = useState([]);
  const [syllabi, setSyllabi] = useState([]);
  const [homework, setHomework] = useState([]);
  const [hwSubs, setHwSubs] = useState([]);
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [b, t, s, m, sy, hw, hs, co] = await Promise.all([
        db.listBooks(), db.listTests(), db.listSubmissions(), db.listMessages(),
        db.listSyllabi(), db.listHomework(), db.listHomeworkSubmissions(), db.listCourses(),
      ]);
      setBooks(b); setTests(t); setSubs(s); setMessages(m);
      setSyllabi(sy); setHomework(hw); setHwSubs(hs); setCourses(co);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const prog = profile.program;
  const visBooks = visibleFor(books, prog);
  const visTests = visibleFor(tests, prog);
  const visHw = visibleFor(homework, prog);
  const mySubs = subs.filter((s) => s.student_id === profile.id);
  const myHwSubs = hwSubs.filter((s) => s.student_id === profile.id);
  const available = visTests.filter((t) => !mySubs.some((s) => s.test_id === t.id));
  const availableHw = visHw.filter((h) => !myHwSubs.some((s) => s.homework_id === h.id));

  const nav = [
    { key: "dash", label: "Dashboard", icon: LayoutDashboard },
    { key: "library", label: "Library", icon: Library },
    { key: "syllabus", label: "Syllabus", icon: ScrollText },
    { key: "tests", label: "My Tests", icon: FileText },
    { key: "homework", label: "Homework", icon: NotebookPen },
    { key: "grades", label: "Grades", icon: Award },
    { key: "inbox", label: "Inbox", icon: Mail },
  ];

  return (
    <Shell user={profile} onLogout={onLogout} nav={nav} active={active} setActive={setActive} badge={{ tests: available.length, homework: availableHw.length }}>
      {loading ? <Spinner /> : (
        <>
          {active === "dash" && <StudentDash {...{ profile, books: visBooks, available, mySubs, tests, setActive }} />}
          {active === "library" && <StudentLibrary books={visBooks} courses={courses} />}
          {active === "syllabus" && <StudentSyllabus syllabi={syllabi} />}
          {active === "tests" && <StudentTests available={available} books={books} courses={courses} refresh={refresh} />}
          {active === "homework" && <StudentHomework availableHw={availableHw} myHwSubs={myHwSubs} homework={homework} courses={courses} refresh={refresh} />}
          {active === "grades" && <StudentGrades mySubs={mySubs} tests={tests} />}
          {active === "inbox" && <MessagesView messages={messages} students={[]} profile={profile} canSend={false} refresh={refresh} />}
        </>
      )}
    </Shell>
  );
}

function StudentDash({ profile, books, available, mySubs, tests, setActive }) {
  const graded = mySubs.filter((s) => s.status === "graded" && s.max_score);
  const avg = graded.length ? Math.round(graded.reduce((a, s) => a + (s.score / s.max_score) * 100, 0) / graded.length) : null;
  return (
    <>
      <PageHead title={`Welcome, ${(profile.full_name || "Student").split(" ")[0]}`} sub="Your studies at a glance." />
      <div className="grid grid-cols-3 gap-4" style={{ marginBottom: 24 }}>
        <Stat icon={BookOpen} label="Books available" value={books.length} />
        <Stat icon={FileText} label="Tests to take" value={available.length} tone={C.gold} />
        <Stat icon={Award} label="Average grade" value={avg !== null ? avg + "%" : "—"} tone={C.green} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
            <h3 className="pl-display" style={{ fontSize: 19, fontWeight: 600, color: C.ink, margin: 0 }}>Tests to complete</h3>
            <Btn small kind="ghost" onClick={() => setActive("tests")}>Go</Btn>
          </div>
          {available.length === 0 ? <span className="pl-body" style={{ color: C.muted }}>You're all caught up.</span> :
            available.map((t) => (
              <div key={t.id} className="flex items-center justify-between" style={{ padding: "10px 0", borderBottom: `1px solid ${C.line}` }}>
                <span className="pl-body" style={{ fontWeight: 600, fontSize: 14.5 }}>{t.title}</span>
                <span className="pl-body" style={{ fontSize: 12.5, color: C.muted }}>{t.questions.length} Q</span>
              </div>
            ))}
        </Card>
        <Card>
          <h3 className="pl-display" style={{ fontSize: 19, fontWeight: 600, color: C.ink, margin: "0 0 12px" }}>Recent grades</h3>
          {graded.length === 0 ? <span className="pl-body" style={{ color: C.muted }}>No grades yet.</span> :
            graded.map((s) => (
              <div key={s.id} className="flex items-center justify-between" style={{ padding: "10px 0", borderBottom: `1px solid ${C.line}` }}>
                <span className="pl-body" style={{ fontWeight: 600, fontSize: 14.5 }}>{tests.find((t) => t.id === s.test_id)?.title || "Test"}</span>
                <span className="pl-display" style={{ fontWeight: 600, color: C.green }}>{Math.round((s.score / s.max_score) * 100)}%</span>
              </div>
            ))}
        </Card>
      </div>
    </>
  );
}

function StudentLibrary({ books, courses }) {
  const [busyId, setBusyId] = useState(null);
  async function read(b) {
    if (!b.file_path) { window.alert("No file attached to this book yet."); return; }
    setBusyId(b.id);
    try { const url = await db.signedUrl(b.file_path); if (url) window.open(url, "_blank"); }
    catch (e) { window.alert(e.message); }
    setBusyId(null);
  }
  const card = (b) => (
    <Card key={b.id}>
      <div className="flex items-center justify-center" style={{ height: 110, borderRadius: 9, background: `linear-gradient(150deg, ${C.ink}, ${C.ink2})`, marginBottom: 14 }}><BookOpen size={34} color={C.goldSoft} /></div>
      <h3 className="pl-display" style={{ fontSize: 17.5, fontWeight: 600, color: C.ink, margin: 0, lineHeight: 1.2 }}>{b.title}</h3>
      <div className="pl-body" style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>{b.author} · {b.pages} pp</div>
      <p className="pl-body" style={{ fontSize: 13.5, color: C.text, marginTop: 8, lineHeight: 1.5 }}>{b.description}</p>
      <div style={{ marginTop: 12 }} className="flex flex-col gap-2">
        {b.video_url && <Btn small full icon={PlayCircle} onClick={() => window.open(b.video_url, "_blank")}>Watch video</Btn>}
        {b.file_path && <Btn small full icon={BookOpen} onClick={() => read(b)} disabled={busyId === b.id}>{busyId === b.id ? "Opening…" : "Open file"}</Btn>}
        {!b.video_url && !b.file_path && <Btn small full kind="ghost" disabled>No media yet</Btn>}
      </div>
    </Card>
  );
  return (
    <>
      <PageHead title="Library" sub="Lessons and materials, organized by course." />
      {books.length === 0 ? <Card><span className="pl-body" style={{ color: C.muted }}>No lessons available yet.</span></Card> :
        <Grouped items={books} courses={courses}>
          {(items) => <div className="grid grid-cols-3 gap-4">{items.map(card)}</div>}
        </Grouped>}
    </>
  );
}

function StudentTests({ available, books, courses, refresh }) {
  const [taking, setTaking] = useState(null);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try { await db.createSubmission({ test_id: taking.id, answers, max_score: sumPoints(taking.questions) }); await refresh(); setTaking(null); setAnswers({}); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }

  if (taking) {
    const answered = taking.questions.filter((q) => answers[q.id] !== undefined && answers[q.id] !== "").length;
    return (
      <>
        <PageHead title={taking.title} sub={taking.description} action={<Btn kind="ghost" icon={X} onClick={() => { setTaking(null); setAnswers({}); }}>Exit</Btn>} />
        {taking.questions.map((q, i) => (
          <Card key={q.id} style={{ marginBottom: 12 }}>
            <span className="pl-body" style={{ fontWeight: 700, color: C.gold, fontSize: 12.5, textTransform: "uppercase", letterSpacing: ".06em" }}>Question {i + 1} · {q.points} pts</span>
            <p className="pl-body" style={{ fontWeight: 600, color: C.ink, fontSize: 16, margin: "8px 0 12px" }}>{q.prompt}</p>
            {q.type === "mc" && q.options.map((opt, oi) => (
              <button key={oi} onClick={() => setAnswers({ ...answers, [q.id]: oi })} className="pl-body pl-press flex items-center gap-3" style={{ width: "100%", textAlign: "left", padding: "11px 14px", borderRadius: 9, marginBottom: 8, cursor: "pointer", border: `1px solid ${answers[q.id] === oi ? C.gold : C.line}`, background: answers[q.id] === oi ? C.paper2 : "#fff", fontSize: 15 }}>
                <span className="inline-flex items-center justify-center" style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${answers[q.id] === oi ? C.gold : C.line}`, background: answers[q.id] === oi ? C.gold : "#fff" }}>{answers[q.id] === oi && <Check size={12} color="#1a1407" />}</span>
                {opt}
              </button>
            ))}
            {q.type === "tf" && ["true", "false"].map((v) => (
              <button key={v} onClick={() => setAnswers({ ...answers, [q.id]: v })} className="pl-press" style={{ padding: "9px 22px", borderRadius: 9, marginRight: 8, cursor: "pointer", textTransform: "capitalize", fontWeight: 600, fontSize: 15, border: `1px solid ${answers[q.id] === v ? C.gold : C.line}`, background: answers[q.id] === v ? C.paper2 : "#fff", color: C.ink }}>{v}</button>
            ))}
            {(q.type === "short" || q.type === "essay") && (
              <textarea style={{ ...inputStyle, minHeight: q.type === "essay" ? 120 : 60 }} placeholder="Type your answer…" value={answers[q.id] || ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
            )}
          </Card>
        ))}
        <div className="flex items-center justify-between" style={{ marginTop: 16 }}>
          <span className="pl-body" style={{ color: C.muted, fontSize: 14 }}>{answered} / {taking.questions.length} answered</span>
          <Btn icon={Send} kind="gold" onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit test"}</Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="My Tests" sub="Assessments assigned to you." />
      {available.length === 0 ? <Card><span className="pl-body" style={{ color: C.muted }}>No tests available right now.</span></Card> :
        <Grouped items={available} courses={courses}>
          {(items) => (
            <div className="flex flex-col gap-3">
              {items.map((t) => (
                <Card key={t.id}>
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="pl-display" style={{ fontSize: 19, fontWeight: 600, color: C.ink, margin: 0 }}>{t.title}</h3>
                      <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{books.find((b) => b.id === t.book_id)?.title || "General"} · {t.questions.length} questions · {sumPoints(t.questions)} pts</div>
                    </div>
                    <Btn icon={PencilLine} onClick={() => setTaking(t)}>Begin</Btn>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Grouped>}
    </>
  );
}

function StudentGrades({ mySubs, tests }) {
  return (
    <>
      <PageHead title="Grades" sub="Your results and instructor feedback." />
      {mySubs.length === 0 ? <Card><span className="pl-body" style={{ color: C.muted }}>No submissions yet.</span></Card> :
        <div className="flex flex-col gap-3">
          {mySubs.map((s) => {
            const test = tests.find((t) => t.id === s.test_id);
            const isGraded = s.status === "graded";
            return (
              <Card key={s.id}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="pl-display" style={{ fontSize: 18.5, fontWeight: 600, color: C.ink, margin: 0 }}>{test?.title || "Test"}</h3>
                    <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>Submitted {fdate(s.submitted_at)}</div>
                  </div>
                  {isGraded ? (
                    <div className="text-right">
                      <div className="pl-display" style={{ fontSize: 24, fontWeight: 600, color: C.green }}>{s.max_score ? Math.round((s.score / s.max_score) * 100) : 0}%</div>
                      <div className="pl-body" style={{ fontSize: 12.5, color: C.muted }}>{s.score} / {s.max_score}</div>
                    </div>
                  ) : <span className="pl-body" style={{ fontSize: 13, fontWeight: 600, color: C.gold, background: C.goldSoft, padding: "5px 12px", borderRadius: 20 }}>Awaiting grade</span>}
                </div>
                {isGraded && s.feedback && (
                  <div style={{ marginTop: 12, padding: "12px 14px", background: C.paper, borderRadius: 9, borderLeft: `3px solid ${C.gold}` }}>
                    <div className="pl-body" style={{ fontSize: 12, fontWeight: 700, color: C.gold, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Instructor feedback</div>
                    <p className="pl-body" style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>{s.feedback}</p>
                  </div>
                )}
              </Card>
            );
          })}
        </div>}
    </>
  );
}

/* ============================================================ SYLLABUS + HOMEWORK */
function FileLink({ path, label = "Open file" }) {
  const [busy, setBusy] = useState(false);
  if (!path) return null;
  async function open() {
    setBusy(true);
    try { const url = await db.signedUrl(path); if (url) window.open(url, "_blank"); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }
  return <Btn small kind="ghost" icon={ExternalLink} onClick={open} disabled={busy}>{busy ? "Opening…" : label}</Btn>;
}

/* ---------- SYLLABUS (instructor) ---------- */
function SyllabusManager({ syllabi, refresh }) {
  return (
    <>
      <PageHead title="Syllabus" sub="Post your Fall and Spring syllabus for students." />
      <div className="grid grid-cols-2 gap-4">
        <TermEditor term="fall" label="Fall Term" data={syllabi.find((s) => s.term === "fall")} refresh={refresh} />
        <TermEditor term="spring" label="Spring Term" data={syllabi.find((s) => s.term === "spring")} refresh={refresh} />
      </div>
    </>
  );
}

function TermEditor({ term, label, data, refresh }) {
  const [title, setTitle] = useState(data?.title || "");
  const [content, setContent] = useState(data?.content || "");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setTitle(data?.title || ""); setContent(data?.content || ""); }, [data]);

  async function save() {
    setBusy(true); setSaved(false);
    try { await db.saveSyllabus({ term, title, content, file }); await refresh(); setFile(null); setSaved(true); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }

  return (
    <Card>
      <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
        <ScrollText size={18} color={C.gold} />
        <h3 className="pl-display" style={{ fontSize: 20, fontWeight: 600, color: C.ink, margin: 0 }}>{label}</h3>
      </div>
      <Field label="Title"><input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${label} Syllabus`} /></Field>
      <Field label="Syllabus text"><textarea style={{ ...inputStyle, minHeight: 160 }} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Course outline, schedule, expectations, grading policy…" /></Field>
      <Field label="Attach PDF (optional)">
        <label className="flex items-center gap-2" style={{ ...inputStyle, padding: 8, cursor: "pointer" }}>
          <Upload size={16} color={C.muted} />
          <span className="pl-body" style={{ fontSize: 14, color: file ? C.text : C.muted }}>{file ? file.name : (data?.file_path ? "Replace current PDF…" : "Choose a file…")}</span>
          <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => setFile(e.target.files[0])} />
        </label>
      </Field>
      <div className="flex items-center gap-2">
        <Btn icon={Check} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Btn>
        {data?.file_path && <FileLink path={data.file_path} label="View PDF" />}
        {saved && <span className="pl-body" style={{ color: C.green, fontSize: 13 }}>Saved</span>}
      </div>
    </Card>
  );
}

/* ---------- SYLLABUS (student) ---------- */
function StudentSyllabus({ syllabi }) {
  const items = ["fall", "spring"].map((t) => syllabi.find((s) => s.term === t)).filter(Boolean);
  return (
    <>
      <PageHead title="Syllabus" sub="Course outlines for the year." />
      {items.length === 0 ? <Card><span className="pl-body" style={{ color: C.muted }}>No syllabus posted yet.</span></Card> :
        <div className="flex flex-col gap-4">
          {items.map((s) => (
            <Card key={s.term}>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <div className="flex items-center gap-2">
                  <ScrollText size={18} color={C.gold} />
                  <h3 className="pl-display" style={{ fontSize: 20, fontWeight: 600, color: C.ink, margin: 0, textTransform: "capitalize" }}>{s.title || `${s.term} Syllabus`}</h3>
                </div>
                {s.file_path && <FileLink path={s.file_path} label="Download PDF" />}
              </div>
              <p className="pl-body" style={{ fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap", margin: 0 }}>{s.content}</p>
            </Card>
          ))}
        </div>}
    </>
  );
}

/* ---------- HOMEWORK (instructor) — builder + grading ---------- */
function HomeworkManager({ homework, hwSubs, profiles, courses, refresh }) {
  const [mode, setMode] = useState("list");
  const [draft, setDraft] = useState(null);
  const [qs, setQs] = useState([]);
  const [file, setFile] = useState(null);
  const [gradeId, setGradeId] = useState(null);
  const [manual, setManual] = useState({});
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const nameOf = (id) => profiles.find((p) => p.id === id)?.full_name || "Student";
  const titleOf = (id) => homework.find((h) => h.id === id)?.title || "Homework";

  function newHw() { setDraft({ id: null, title: "", instructions: "", program: "all", due_date: "", points: 100, file_path: null, course_id: "", module: "" }); setQs([]); setFile(null); setMode("build"); }
  function editHw(h) { setDraft({ id: h.id, title: h.title, instructions: h.instructions, program: h.program || "all", due_date: h.due_date || "", points: h.points, file_path: h.file_path, course_id: h.course_id || "", module: h.module || "" }); setQs(h.questions.map((q) => ({ ...q }))); setFile(null); setMode("build"); }

  function addQ(type) {
    const base = { id: "tmp" + Date.now() + Math.random(), type, prompt: "", points: type === "essay" ? 20 : type === "short" ? 10 : 5 };
    if (type === "mc") Object.assign(base, { options: ["", "", "", ""], correct_answer: "0" });
    if (type === "tf") base.correct_answer = "true";
    setQs([...qs, base]);
  }
  const upQ = (id, patch) => setQs(qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const delQ = (id) => setQs(qs.filter((q) => q.id !== id));

  async function save() {
    if (!draft.title.trim()) { window.alert("Give the assignment a title."); return; }
    setBusy(true);
    try { await db.saveHomework(draft, qs, file); await refresh(); setMode("list"); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }
  async function removeHw(id) {
    if (!window.confirm("Delete this assignment?")) return;
    try { await db.deleteHomework(id); await refresh(); } catch (e) { window.alert(e.message); }
  }
  function openGrade(s) { setGradeId(s.id); setManual(s.manual || {}); setScore(s.score ?? ""); setFeedback(s.feedback || ""); setMode("grade"); }

  async function finalize() {
    const sub = hwSubs.find((s) => s.id === gradeId);
    const hw = homework.find((h) => h.id === sub.homework_id);
    const hasQs = hw && hw.questions.length > 0;
    let total, max;
    if (hasQs) {
      const auto = autoScore({ questions: hw.questions }, sub);
      const manualTotal = hw.questions.filter((q) => q.type === "short" || q.type === "essay").reduce((a, q) => a + (Number(manual[q.id] ?? 0) || 0), 0);
      max = sumPoints(hw.questions); total = auto + manualTotal;
    } else {
      max = sub.max_points || hw?.points || 0; total = Number(score) || 0;
    }
    setBusy(true);
    try { await db.gradeHomework(gradeId, { manual, score: total, max_points: max, feedback }); await refresh(); setMode("list"); setGradeId(null); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }

  if (mode === "build" && draft) {
    return (
      <>
        <PageHead title="Assignment Builder" sub="Add questions (auto-graded) and/or let students upload work." action={<Btn kind="ghost" icon={ArrowLeft} onClick={() => setMode("list")}>Back</Btn>} />
        <Card style={{ marginBottom: 18 }}>
          <Field label="Title"><input style={inputStyle} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Reading Response — Chapter 3" /></Field>
          <Field label="Instructions"><textarea style={{ ...inputStyle, minHeight: 90 }} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Program / level"><ProgramSelect value={draft.program} onChange={(v) => setDraft({ ...draft, program: v })} /></Field>
            <Field label="Due date (optional)"><input type="date" style={inputStyle} value={draft.due_date} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} /></Field>
            <Field label="Points (if no questions)"><input type="number" style={inputStyle} value={draft.points} onChange={(e) => setDraft({ ...draft, points: e.target.value })} /></Field>
          </div>
          <CourseFields courses={courses} courseId={draft.course_id} module={draft.module} onCourse={(v) => setDraft({ ...draft, course_id: v })} onModule={(v) => setDraft({ ...draft, module: v })} />
          <Field label="Attachment (optional PDF for students)">
            <label className="flex items-center gap-2" style={{ ...inputStyle, padding: 8, cursor: "pointer" }}>
              <Upload size={16} color={C.muted} />
              <span className="pl-body" style={{ fontSize: 14, color: file ? C.text : C.muted }}>{file ? file.name : (draft.file_path ? "Replace current file…" : "Choose a file…")}</span>
              <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => setFile(e.target.files[0])} />
            </label>
          </Field>
        </Card>

        {qs.map((q, i) => (
          <Card key={q.id} style={{ marginBottom: 12 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
              <span className="pl-body" style={{ fontWeight: 700, color: C.gold, fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em" }}>Q{i + 1} · {QTYPE[q.type]}</span>
              <div className="flex items-center gap-3">
                <label className="pl-body flex items-center gap-1" style={{ fontSize: 13, color: C.muted }}>Points
                  <input type="number" value={q.points} onChange={(e) => upQ(q.id, { points: Number(e.target.value) })} style={{ ...inputStyle, width: 64, padding: "5px 8px" }} />
                </label>
                <button onClick={() => delQ(q.id)} className="pl-press" style={{ background: "none", border: "none", cursor: "pointer", color: C.rose }}><Trash2 size={16} /></button>
              </div>
            </div>
            <textarea style={{ ...inputStyle, minHeight: 52 }} placeholder="Question prompt…" value={q.prompt} onChange={(e) => upQ(q.id, { prompt: e.target.value })} />
            {q.type === "mc" && (
              <div style={{ marginTop: 10 }}>
                {q.options.map((opt, oi) => (
                  <div key={oi} className="flex items-center gap-2" style={{ marginBottom: 7 }}>
                    <button onClick={() => upQ(q.id, { correct_answer: String(oi) })} className="pl-press inline-flex items-center justify-center" style={{ width: 24, height: 24, borderRadius: "50%", border: `2px solid ${String(q.correct_answer) === String(oi) ? C.green : C.line}`, background: String(q.correct_answer) === String(oi) ? C.green : "#fff", cursor: "pointer" }}>{String(q.correct_answer) === String(oi) && <Check size={13} color="#fff" />}</button>
                    <input style={{ ...inputStyle, padding: "7px 10px" }} placeholder={`Option ${oi + 1}`} value={opt} onChange={(e) => { const o = [...q.options]; o[oi] = e.target.value; upQ(q.id, { options: o }); }} />
                  </div>
                ))}
                <div className="pl-body" style={{ fontSize: 12, color: C.muted }}>Click the circle to mark the correct answer.</div>
              </div>
            )}
            {q.type === "tf" && (
              <div className="flex gap-2" style={{ marginTop: 10 }}>
                {["true", "false"].map((v) => (
                  <button key={v} onClick={() => upQ(q.id, { correct_answer: v })} className="pl-press" style={{ padding: "7px 18px", borderRadius: 8, cursor: "pointer", textTransform: "capitalize", fontWeight: 600, border: `1px solid ${q.correct_answer === v ? C.green : C.line}`, background: q.correct_answer === v ? C.greenSoft : "#fff", color: q.correct_answer === v ? C.green : C.muted }}>{v}</button>
                ))}
              </div>
            )}
            {(q.type === "short" || q.type === "essay") && <div className="pl-body" style={{ marginTop: 10, fontSize: 13, color: C.muted, fontStyle: "italic" }}>Graded manually after submission.</div>}
          </Card>
        ))}

        <Card>
          <div className="pl-body" style={{ fontWeight: 600, color: C.ink, marginBottom: 10 }}>Add a question (optional)</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(QTYPE).map(([k, v]) => <Btn key={k} small kind="ghost" icon={Plus} onClick={() => addQ(k)}>{v}</Btn>)}
          </div>
        </Card>

        <div className="flex items-center justify-between" style={{ marginTop: 18 }}>
          <span className="pl-body" style={{ color: C.muted, fontSize: 14 }}>{qs.length} questions · {qs.length ? sumPoints(qs) : draft.points} points · {programLabel(draft.program)}</span>
          <Btn icon={Check} kind="gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save assignment"}</Btn>
        </div>
      </>
    );
  }

  if (mode === "grade" && gradeId) {
    const sub = hwSubs.find((s) => s.id === gradeId);
    if (!sub) { setMode("list"); return null; }
    const hw = homework.find((h) => h.id === sub.homework_id);
    const hasQs = hw && hw.questions.length > 0;
    const auto = hasQs ? autoScore({ questions: hw.questions }, sub) : 0;
    const manualTotal = hasQs ? hw.questions.filter((q) => q.type === "short" || q.type === "essay").reduce((a, q) => a + (Number(manual[q.id] ?? 0) || 0), 0) : 0;
    const max = hasQs ? sumPoints(hw.questions) : (sub.max_points || hw?.points || 0);
    const total = hasQs ? auto + manualTotal : (Number(score) || 0);
    return (
      <>
        <PageHead title="Grade Homework" sub={`${nameOf(sub.student_id)} · ${titleOf(sub.homework_id)}`} action={<Btn kind="ghost" icon={ArrowLeft} onClick={() => setMode("list")}>Back</Btn>} />
        {hasQs && hw.questions.map((q, i) => {
          const ans = sub.answers?.[q.id];
          const isAuto = q.type === "mc" || q.type === "tf";
          const correct = q.type === "mc" ? String(ans) === String(q.correct_answer) : q.type === "tf" ? ans === q.correct_answer : false;
          return (
            <Card key={q.id} style={{ marginBottom: 12 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="pl-body" style={{ fontWeight: 700, color: C.gold, fontSize: 12.5, textTransform: "uppercase", letterSpacing: ".06em" }}>Q{i + 1} · {QTYPE[q.type]} · {q.points} pts</span>
                {isAuto && <span className="pl-body" style={{ fontSize: 12.5, fontWeight: 700, color: correct ? C.green : C.rose }}>{correct ? "Correct (auto)" : "Incorrect (auto)"}</span>}
              </div>
              <p className="pl-body" style={{ fontWeight: 600, color: C.ink, marginBottom: 8 }}>{q.prompt}</p>
              {q.type === "mc" && <div className="pl-body" style={{ fontSize: 14 }}>Student answered: <b>{q.options[Number(ans)] ?? "—"}</b> · Correct: {q.options[Number(q.correct_answer)]}</div>}
              {q.type === "tf" && <div className="pl-body" style={{ fontSize: 14, textTransform: "capitalize" }}>Student answered: <b>{ans ?? "—"}</b> · Correct: {q.correct_answer}</div>}
              {(q.type === "short" || q.type === "essay") && (
                <>
                  <div className="pl-body" style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{ans || <i style={{ color: C.muted }}>No response</i>}</div>
                  <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
                    <span className="pl-body" style={{ fontSize: 13, color: C.muted, fontWeight: 600 }}>Award points:</span>
                    <input type="number" min={0} max={q.points} value={manual[q.id] ?? ""} placeholder="0" onChange={(e) => setManual({ ...manual, [q.id]: Math.min(q.points, Math.max(0, Number(e.target.value) || 0)) })} style={{ ...inputStyle, width: 80, padding: "6px 10px" }} />
                    <span className="pl-body" style={{ fontSize: 13, color: C.muted }}>/ {q.points}</span>
                  </div>
                </>
              )}
            </Card>
          );
        })}
        <Card style={{ marginBottom: 12 }}>
          <div className="pl-body" style={{ fontSize: 12, fontWeight: 700, color: C.gold, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Student upload</div>
          <div className="pl-body" style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{sub.response || <i style={{ color: C.muted }}>No written response</i>}</div>
          {sub.file_path && <div style={{ marginTop: 10 }}><FileLink path={sub.file_path} label="Open submitted file" /></div>}
        </Card>
        <Card>
          <Field label="Feedback"><textarea style={{ ...inputStyle, minHeight: 80 }} value={feedback} onChange={(e) => setFeedback(e.target.value)} /></Field>
          <div className="flex items-center justify-between">
            {hasQs ? (
              <div className="pl-display" style={{ fontSize: 24, fontWeight: 600, color: C.ink }}>{total} <span style={{ color: C.muted, fontSize: 18 }}>/ {max}</span> <span className="pl-body" style={{ fontSize: 15, color: C.gold, marginLeft: 8 }}>{max ? Math.round((total / max) * 100) : 0}%</span></div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="pl-body" style={{ fontSize: 13, color: C.muted, fontWeight: 600 }}>Score:</span>
                <input type="number" min={0} max={max} value={score} onChange={(e) => setScore(e.target.value)} style={{ ...inputStyle, width: 90, padding: "6px 10px" }} />
                <span className="pl-body" style={{ fontSize: 13, color: C.muted }}>/ {max}</span>
              </div>
            )}
            <Btn icon={Award} kind="gold" onClick={finalize} disabled={busy}>{busy ? "Saving…" : "Finalize & release"}</Btn>
          </div>
        </Card>
      </>
    );
  }

  const pending = hwSubs.filter((s) => s.status !== "graded");
  const graded = hwSubs.filter((s) => s.status === "graded");
  return (
    <>
      <PageHead title="Homework" sub="Assignments and submissions." action={<Btn icon={Plus} onClick={newHw}>New assignment</Btn>} />
      <h3 className="pl-display" style={{ fontSize: 18, color: C.ink, marginBottom: 10 }}>Assignments</h3>
      <div className="flex flex-col gap-3" style={{ marginBottom: 24 }}>
        {homework.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>No assignments yet.</span></Card>}
        {homework.map((h) => (
          <Card key={h.id}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="pl-display" style={{ fontSize: 18, fontWeight: 600, color: C.ink, margin: 0 }}>{h.title}</h3>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{programLabel(h.program)} · {h.questions.length ? `${h.questions.length} questions · ${sumPoints(h.questions)} pts` : `${h.points} pts`}{h.due_date ? ` · due ${fdate(h.due_date)}` : ""} · {hwSubs.filter((s) => s.homework_id === h.id).length} submitted</div>
              </div>
              <div className="flex items-center gap-2">
                {h.file_path && <FileLink path={h.file_path} label="Attachment" />}
                <Btn small kind="ghost" icon={PencilLine} onClick={() => editHw(h)}>Edit</Btn>
                <button onClick={() => removeHw(h.id)} className="pl-press" style={{ background: "none", border: "none", cursor: "pointer", color: C.rose }}><Trash2 size={18} /></button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <h3 className="pl-display" style={{ fontSize: 18, color: C.ink, marginBottom: 10 }}>Awaiting grading</h3>
      <div className="flex flex-col gap-3" style={{ marginBottom: 24 }}>
        {pending.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>Nothing pending.</span></Card>}
        {pending.map((s) => (
          <Card key={s.id}>
            <div className="flex items-center justify-between">
              <div>
                <div className="pl-body" style={{ fontWeight: 600, fontSize: 15.5 }}>{nameOf(s.student_id)}</div>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted }}>{titleOf(s.homework_id)} · submitted {fdate(s.submitted_at)}</div>
              </div>
              <Btn icon={ClipboardCheck} onClick={() => openGrade(s)}>Grade</Btn>
            </div>
          </Card>
        ))}
      </div>

      <h3 className="pl-display" style={{ fontSize: 18, color: C.ink, marginBottom: 10 }}>Graded</h3>
      <div className="flex flex-col gap-3">
        {graded.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>None yet.</span></Card>}
        {graded.map((s) => (
          <Card key={s.id}>
            <div className="flex items-center justify-between">
              <div>
                <div className="pl-body" style={{ fontWeight: 600, fontSize: 15.5 }}>{nameOf(s.student_id)}</div>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted }}>{titleOf(s.homework_id)}</div>
              </div>
              <span className="pl-display" style={{ fontSize: 20, fontWeight: 600, color: C.green }}>{s.score}/{s.max_points}</span>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ---------- HOMEWORK (student) ---------- */
function StudentHomework({ availableHw, myHwSubs, homework, courses, refresh }) {
  const [doing, setDoing] = useState(null);
  const [answers, setAnswers] = useState({});
  const [response, setResponse] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const titleOf = (id) => homework.find((h) => h.id === id)?.title || "Homework";

  function start(h) { setDoing(h); setAnswers({}); setResponse(""); setFile(null); }

  async function submit() {
    const maxPts = doing.questions.length ? sumPoints(doing.questions) : doing.points;
    setBusy(true);
    try { await db.submitHomework({ homework_id: doing.id, answers, response, file, max_points: maxPts }); await refresh(); setDoing(null); setAnswers({}); setResponse(""); setFile(null); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }

  if (doing) {
    const qs = doing.questions || [];
    return (
      <>
        <PageHead title={doing.title} sub={doing.due_date ? `Due ${fdate(doing.due_date)}` : ""} action={<Btn kind="ghost" icon={X} onClick={() => setDoing(null)}>Exit</Btn>} />
        <Card style={{ marginBottom: 12 }}>
          <p className="pl-body" style={{ fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap", margin: 0 }}>{doing.instructions}</p>
          {doing.file_path && <div style={{ marginTop: 10 }}><FileLink path={doing.file_path} label="Open attachment" /></div>}
        </Card>
        {qs.map((q, i) => (
          <Card key={q.id} style={{ marginBottom: 12 }}>
            <span className="pl-body" style={{ fontWeight: 700, color: C.gold, fontSize: 12.5, textTransform: "uppercase", letterSpacing: ".06em" }}>Question {i + 1} · {q.points} pts</span>
            <p className="pl-body" style={{ fontWeight: 600, color: C.ink, fontSize: 16, margin: "8px 0 12px" }}>{q.prompt}</p>
            {q.type === "mc" && q.options.map((opt, oi) => (
              <button key={oi} onClick={() => setAnswers({ ...answers, [q.id]: oi })} className="pl-body pl-press flex items-center gap-3" style={{ width: "100%", textAlign: "left", padding: "11px 14px", borderRadius: 9, marginBottom: 8, cursor: "pointer", border: `1px solid ${answers[q.id] === oi ? C.gold : C.line}`, background: answers[q.id] === oi ? C.paper2 : "#fff", fontSize: 15 }}>
                <span className="inline-flex items-center justify-center" style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${answers[q.id] === oi ? C.gold : C.line}`, background: answers[q.id] === oi ? C.gold : "#fff" }}>{answers[q.id] === oi && <Check size={12} color="#1a1407" />}</span>
                {opt}
              </button>
            ))}
            {q.type === "tf" && ["true", "false"].map((v) => (
              <button key={v} onClick={() => setAnswers({ ...answers, [q.id]: v })} className="pl-press" style={{ padding: "9px 22px", borderRadius: 9, marginRight: 8, cursor: "pointer", textTransform: "capitalize", fontWeight: 600, fontSize: 15, border: `1px solid ${answers[q.id] === v ? C.gold : C.line}`, background: answers[q.id] === v ? C.paper2 : "#fff", color: C.ink }}>{v}</button>
            ))}
            {(q.type === "short" || q.type === "essay") && (
              <textarea style={{ ...inputStyle, minHeight: q.type === "essay" ? 120 : 60 }} placeholder="Type your answer…" value={answers[q.id] || ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
            )}
          </Card>
        ))}
        <Card>
          <div className="pl-body" style={{ fontWeight: 600, color: C.ink, marginBottom: 8 }}>{qs.length ? "Additional work (optional)" : "Your submission"}</div>
          <Field label="Written response"><textarea style={{ ...inputStyle, minHeight: 100 }} value={response} onChange={(e) => setResponse(e.target.value)} placeholder="Type here…" /></Field>
          <Field label="Attach a file (optional)">
            <label className="flex items-center gap-2" style={{ ...inputStyle, padding: 8, cursor: "pointer" }}>
              <Upload size={16} color={C.muted} />
              <span className="pl-body" style={{ fontSize: 14, color: file ? C.text : C.muted }}>{file ? file.name : "Choose a file…"}</span>
              <input type="file" style={{ display: "none" }} onChange={(e) => setFile(e.target.files[0])} />
            </label>
          </Field>
          <Btn icon={Send} kind="gold" onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit homework"}</Btn>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHead title="Homework" sub="Your assignments." />
      <h3 className="pl-display" style={{ fontSize: 18, color: C.ink, marginBottom: 10 }}>To do</h3>
      <div style={{ marginBottom: 24 }}>
        {availableHw.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>You're all caught up.</span></Card>}
        <Grouped items={availableHw} courses={courses}>
          {(items) => (
            <div className="flex flex-col gap-3">
              {items.map((h) => (
                <Card key={h.id}>
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="pl-display" style={{ fontSize: 18, fontWeight: 600, color: C.ink, margin: 0 }}>{h.title}</h3>
                      <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{h.questions.length ? `${h.questions.length} questions · ${sumPoints(h.questions)} pts` : `${h.points} pts`}{h.due_date ? ` · due ${fdate(h.due_date)}` : ""}</div>
                    </div>
                    <Btn icon={PencilLine} onClick={() => start(h)}>Start</Btn>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Grouped>
      </div>

      <h3 className="pl-display" style={{ fontSize: 18, color: C.ink, marginBottom: 10 }}>Submitted</h3>
      <div className="flex flex-col gap-3">
        {myHwSubs.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>Nothing submitted yet.</span></Card>}
        {myHwSubs.map((s) => (
          <Card key={s.id}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="pl-display" style={{ fontSize: 17, fontWeight: 600, color: C.ink, margin: 0 }}>{titleOf(s.homework_id)}</h3>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>Submitted {fdate(s.submitted_at)}</div>
              </div>
              {s.status === "graded"
                ? <span className="pl-display" style={{ fontSize: 20, fontWeight: 600, color: C.green }}>{s.score}/{s.max_points}</span>
                : <span className="pl-body" style={{ fontSize: 13, fontWeight: 600, color: C.gold, background: C.goldSoft, padding: "5px 12px", borderRadius: 20 }}>Awaiting grade</span>}
            </div>
            {s.status === "graded" && s.feedback && (
              <div style={{ marginTop: 12, padding: "12px 14px", background: C.paper, borderRadius: 9, borderLeft: `3px solid ${C.gold}` }}>
                <div className="pl-body" style={{ fontSize: 12, fontWeight: 700, color: C.gold, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Feedback</div>
                <p className="pl-body" style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>{s.feedback}</p>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}

/* ---------- COURSES (instructor) ---------- */
function CoursesManager({ courses, refresh }) {
  const [form, setForm] = useState({ title: "", description: "", program: "all" });
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  async function create() {
    if (!form.title.trim()) return;
    setBusy(true);
    try { await db.createCourse(form); await refresh(); setForm({ title: "", description: "", program: "all" }); setShow(false); }
    catch (e) { window.alert(e.message); }
    setBusy(false);
  }
  async function remove(id) {
    if (!window.confirm("Delete this course? Its lessons/tests/homework remain, but lose the course label.")) return;
    try { await db.deleteCourse(id); await refresh(); } catch (e) { window.alert(e.message); }
  }

  return (
    <>
      <PageHead title="Courses" sub="Group lessons, tests, and homework into courses and weeks." action={<Btn icon={Plus} onClick={() => setShow(true)}>New course</Btn>} />
      {show && (
        <Card style={{ marginBottom: 18, maxWidth: 640 }}>
          <Field label="Course title"><input style={inputStyle} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Systematic Theology I" /></Field>
          <Field label="Description"><textarea style={{ ...inputStyle, minHeight: 80 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Program / level"><ProgramSelect value={form.program} onChange={(v) => setForm({ ...form, program: v })} /></Field>
          <div className="flex gap-2"><Btn icon={Check} onClick={create} disabled={busy}>{busy ? "Saving…" : "Create course"}</Btn><Btn kind="ghost" onClick={() => setShow(false)}>Cancel</Btn></div>
        </Card>
      )}
      <div className="flex flex-col gap-3">
        {courses.length === 0 && <Card><span className="pl-body" style={{ color: C.muted }}>No courses yet. Create one, then choose it when you add a lesson, test, or homework.</span></Card>}
        {courses.map((c) => (
          <Card key={c.id}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="pl-display" style={{ fontSize: 19, fontWeight: 600, color: C.ink, margin: 0 }}>{c.title}</h3>
                <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{programLabel(c.program)}{c.description ? ` · ${c.description}` : ""}</div>
              </div>
              <button onClick={() => remove(c.id)} className="pl-press" style={{ background: "none", border: "none", cursor: "pointer", color: C.rose }}><Trash2 size={18} /></button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
