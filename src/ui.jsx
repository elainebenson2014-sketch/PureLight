import React from "react";
import { Sparkles, LogOut } from "lucide-react";

// ── White-label branding ─────────────────────────────────────────────
// Each school sets these as environment variables in its OWN Vercel
// project. If a value isn't set, it falls back to the NCTS default — so
// the original NCTS site is never affected.
const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
export const BRAND = {
  name:    ENV.VITE_SCHOOL_NAME    || "Yona LMS",
  short:   ENV.VITE_SCHOOL_SHORT   || "Yona",
  tagline: ENV.VITE_SCHOOL_TAGLINE || "Learning That Transforms",
  logoUrl: ENV.VITE_LOGO_URL       || "",
};

// ── Feature flags ────────────────────────────────────────────────────
// Set per white-label instance via Vercel environment variables.
// true = show, false = hide. Defaults keep the full NCTS feature set.
export const FEATURES = {
  library:         (ENV.VITE_FEATURE_LIBRARY         ?? "true") !== "false",
  syllabus:        (ENV.VITE_FEATURE_SYLLABUS         ?? "true") !== "false",
  homework:        (ENV.VITE_FEATURE_HOMEWORK         ?? "true") !== "false",
  live_classes:    (ENV.VITE_FEATURE_LIVE_CLASSES     ?? "true") !== "false",
  tests:           (ENV.VITE_FEATURE_TESTS            ?? "true") !== "false",
  grading:         (ENV.VITE_FEATURE_GRADING          ?? "true") !== "false",
  attendance:      (ENV.VITE_FEATURE_ATTENDANCE       ?? "true") !== "false",
  grades:          (ENV.VITE_FEATURE_GRADES           ?? "true") !== "false",
  degree_progress: (ENV.VITE_FEATURE_DEGREE_PROGRESS  ?? "true") !== "false",
  gradebook:       (ENV.VITE_FEATURE_GRADEBOOK        ?? "true") !== "false",
  reports:         (ENV.VITE_FEATURE_REPORTS          ?? "true") !== "false",
  ce_hours:        (ENV.VITE_FEATURE_CE_HOURS         ?? "true") !== "false",
  cert_classes:    (ENV.VITE_FEATURE_CERT_CLASSES     ?? "true") !== "false",
  billing:         (ENV.VITE_FEATURE_BILLING          ?? "true") !== "false",
  tuition:         (ENV.VITE_FEATURE_TUITION          ?? "true") !== "false",
  certificates:    (ENV.VITE_FEATURE_CERTIFICATES     ?? "true") !== "false",
  messages:        (ENV.VITE_FEATURE_MESSAGES         ?? "true") !== "false",
  people:          (ENV.VITE_FEATURE_PEOPLE           ?? "true") !== "false",
};

export const C = {
  ink:      ENV.VITE_BRAND_INK       || "#15213d",
  ink2:     ENV.VITE_BRAND_INK2      || "#23315a",
  paper:    ENV.VITE_BRAND_PAPER     || "#f6f1e7",
  paper2:   "#efe7d5",
  card:     "#fffdf8",
  gold:     ENV.VITE_BRAND_GOLD      || "#bd9a44",
  goldSoft: ENV.VITE_BRAND_GOLD_SOFT || "#e7d9a8",
  line:     "#e4d9c2",
  text: "#2c2a24", muted: "#7a7264", green: "#4d7c5a", greenSoft: "#dcebe0",
  rose: "#a8534f", roseSoft: "#f1ddd9",
};

export const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap');
* { -webkit-font-smoothing: antialiased; box-sizing: border-box; }
body { margin: 0; }
.pl-display { font-family: 'Fraunces', Georgia, serif; }
.pl-body { font-family: 'Source Serif 4', Georgia, serif; }
.pl-fade { animation: plfade .5s ease both; }
@keyframes plfade { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform:none; } }
@keyframes plspin { to { transform: rotate(360deg); } }
.pl-press:active { transform: translateY(1px); }
input, textarea, select { font-family: 'Source Serif 4', Georgia, serif; }
/* minimal layout utilities (no Tailwind dependency) */
.flex{display:flex;}.inline-flex{display:inline-flex;}.grid{display:grid;}.block{display:block;}
.flex-col{flex-direction:column;}.flex-wrap{flex-wrap:wrap;}.flex-1{flex:1 1 0%;}
.items-center{align-items:center;}.items-end{align-items:flex-end;}.items-start{align-items:flex-start;}
.justify-center{justify-content:center;}.justify-between{justify-content:space-between;}
.text-center{text-align:center;}.text-right{text-align:right;}.text-left{text-align:left;}
.w-full{width:100%;}.rounded-md{border-radius:8px;}.transition{transition:all .15s ease;}
.gap-1{gap:4px;}.gap-2{gap:8px;}.gap-3{gap:12px;}.gap-4{gap:16px;}
.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr));}
.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr));}
.grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr));}
@media (max-width:820px){
  .grid-cols-2,.grid-cols-3,.grid-cols-4{grid-template-columns:1fr;}
}
`;

export const QTYPE = { mc: "Multiple Choice", tf: "True / False", short: "Short Answer", essay: "Essay" };

export const inputStyle = {
  width: "100%", padding: "10px 12px", borderRadius: 9, border: `1px solid ${C.line}`,
  background: "#fff", color: C.text, fontSize: 15, outline: "none",
};

export function Btn({ children, onClick, kind = "primary", icon: Icon, small, full, type, disabled }) {
  const styles = {
    primary: { background: C.ink, color: "#fff", border: `1px solid ${C.ink}` },
    gold: { background: C.gold, color: "#1a1407", border: `1px solid ${C.gold}` },
    ghost: { background: "transparent", color: C.ink, border: `1px solid ${C.line}` },
    danger: { background: C.roseSoft, color: C.rose, border: `1px solid ${C.rose}` },
  }[kind];
  return (
    <button type={type || "button"} onClick={onClick} disabled={disabled}
      className="pl-body pl-press inline-flex items-center justify-center gap-2 rounded-md transition"
      style={{ ...styles, padding: small ? "7px 12px" : "10px 18px", fontSize: small ? 13 : 15,
        fontWeight: 600, width: full ? "100%" : "auto", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1, letterSpacing: ".01em" }}>
      {Icon && <Icon size={small ? 15 : 17} strokeWidth={2} />}
      {children}
    </button>
  );
}

export function Card({ children, pad = true, style }) {
  return (
    <div className="pl-fade" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14,
      padding: pad ? 22 : 0, boxShadow: "0 1px 0 rgba(0,0,0,.02), 0 12px 30px -22px rgba(21,33,61,.4)", ...style }}>
      {children}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="block" style={{ marginBottom: 14, display: "block" }}>
      <span className="pl-body block" style={{ fontSize: 13, fontWeight: 600, color: C.muted, marginBottom: 6,
        textTransform: "uppercase", letterSpacing: ".08em", display: "block" }}>{label}</span>
      {children}
    </label>
  );
}

export function PageHead({ title, sub, action }) {
  return (
    <div className="flex items-end justify-between" style={{ marginBottom: 24, gap: 12 }}>
      <div>
        <h1 className="pl-display" style={{ fontSize: 32, fontWeight: 600, color: C.ink, margin: 0 }}>{title}</h1>
        {sub && <p className="pl-body" style={{ color: C.muted, fontSize: 15, marginTop: 2, marginBottom: 0 }}>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ icon: Icon, label, value, tone = C.ink }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="inline-flex items-center justify-center" style={{ width: 46, height: 46, borderRadius: 12, background: C.paper2, color: tone }}>
          <Icon size={22} />
        </div>
        <div>
          <div className="pl-display" style={{ fontSize: 28, fontWeight: 600, color: C.ink, lineHeight: 1 }}>{value}</div>
          <div className="pl-body" style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>{label}</div>
        </div>
      </div>
    </Card>
  );
}

export function Spinner({ label = "Loading…" }) {
  return (
    <div className="flex items-center gap-3 pl-body" style={{ color: C.muted, padding: "30px 0" }}>
      <span style={{ width: 18, height: 18, border: `2px solid ${C.line}`, borderTopColor: C.gold, borderRadius: "50%", display: "inline-block", animation: "plspin .8s linear infinite" }} />
      {label}
    </div>
  );
}

export function Initials({ name, size = 38 }) {
  return (
    <div className="inline-flex items-center justify-center pl-display" style={{ width: size, height: size,
      borderRadius: "50%", background: C.paper2, color: C.ink, fontWeight: 700, fontSize: size * 0.36 }}>
      {(name || "?").split(" ").map((n) => n[0]).join("").slice(0, 2)}
    </div>
  );
}

export function Shell({ user, onLogout, nav, active, setActive, children, badge }) {
  return (
    <div className="flex" style={{ minHeight: "100vh" }}>
      <aside style={{ width: 248, background: C.ink, color: "#fff", padding: "22px 16px",
        display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
        <div className="flex items-center gap-2" style={{ padding: "0 8px 18px", borderBottom: "1px solid #ffffff1a", marginBottom: 14 }}>
          {BRAND.logoUrl ? (
            <img src={BRAND.logoUrl} alt={BRAND.name} style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", background: "#fff", flexShrink: 0 }} />
          ) : (
            <div className="inline-flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: "50%", background: `radial-gradient(circle at 35% 30%, ${C.goldSoft}, ${C.gold})`, flexShrink: 0 }}>
              <Sparkles size={18} color="#1a1407" />
            </div>
          )}
          <div>
            <div className="pl-display" style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.05 }}>{BRAND.name}</div>
            {BRAND.short && <div className="pl-body" style={{ fontSize: 10, letterSpacing: ".18em", color: C.goldSoft, textTransform: "uppercase" }}>{BRAND.short}</div>}
          </div>
        </div>

        <nav className="flex flex-col gap-1" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {nav.map((n) => (
            <button key={n.key} onClick={() => setActive(n.key)}
              className="pl-body pl-press flex items-center gap-3 transition" style={{ textAlign: "left",
                padding: "10px 12px", borderRadius: 9, cursor: "pointer", fontSize: 14.5,
                fontWeight: active === n.key ? 600 : 500, background: active === n.key ? "#ffffff14" : "transparent",
                color: active === n.key ? "#fff" : "#ffffffb0", border: "none",
                borderLeft: active === n.key ? `3px solid ${C.gold}` : "3px solid transparent" }}>
              <n.icon size={18} strokeWidth={2} />
              <span style={{ flex: 1 }}>{n.label}</span>
              {badge && badge[n.key] > 0 && (
                <span className="pl-body inline-flex items-center justify-center" style={{ minWidth: 20, height: 20,
                  padding: "0 6px", borderRadius: 10, background: C.gold, color: "#1a1407", fontSize: 11, fontWeight: 700 }}>{badge[n.key]}</span>
              )}
            </button>
          ))}
        </nav>

        <div style={{ borderTop: "1px solid #ffffff1a", paddingTop: 14 }}>
          <div className="flex items-center gap-3" style={{ marginBottom: 10, padding: "0 4px" }}>
            <div className="inline-flex items-center justify-center pl-display" style={{ width: 36, height: 36, borderRadius: "50%", background: "#ffffff1a", fontWeight: 700, fontSize: 14, color: "#fff" }}>
              {(user.full_name || "?").split(" ").map((n) => n[0]).join("").slice(0, 2)}
            </div>
            <div style={{ overflow: "hidden" }}>
              <div className="pl-body" style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{user.full_name}</div>
              <div className="pl-body" style={{ fontSize: 11, color: "#ffffff80", textTransform: "capitalize" }}>{user.role}</div>
            </div>
          </div>
          <button onClick={onLogout} className="pl-body pl-press flex items-center gap-2"
            style={{ width: "100%", padding: "9px 12px", borderRadius: 9, background: "#ffffff10", color: "#fff", border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600 }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: "30px 38px", maxWidth: 1100 }}>{children}</main>
    </div>
  );
}
