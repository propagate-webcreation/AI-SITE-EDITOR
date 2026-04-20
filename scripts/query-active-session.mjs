#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const { data, error } = await supabase
  .from("sessions")
  .select("id, record_number, sandbox_id, preview_url, status, started_at")
  .order("started_at", { ascending: false })
  .limit(5);
if (error) console.error(error);
console.log(JSON.stringify(data, null, 2));
