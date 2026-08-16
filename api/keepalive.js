// Vercel Cron target — pings Supabase's REST API on a schedule so the free-tier
// project never accumulates 7 days of inactivity and gets auto-paused.
// Reuses the same public URL/anon key already shipped to the browser in
// src/supabaseClient.js, so no extra Supabase secret is needed.

const SUPABASE_URL = 'https://ccbtrvbwggsrlxkqkess.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjYnRydmJ3Z2dzcmx4a3FrZXNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5ODQzNTQsImV4cCI6MjA5NTU2MDM1NH0.OywSaKbie5cT-tHy0129PR2HckbNv8RzQqhCEAKIW8I'

export default async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/todos?select=id&limit=1`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  })

  return res.status(200).json({
    ok: response.ok,
    status: response.status,
    pinged_at: new Date().toISOString(),
  })
}
