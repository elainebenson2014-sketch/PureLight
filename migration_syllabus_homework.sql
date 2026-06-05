import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // Helpful console error during setup
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Check your .env / Vercel env vars.");
}

export const supabase = createClient(url, anon);
