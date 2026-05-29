// Google Calendar helper — fully server-side OAuth, secret never in browser

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const REDIRECT_URI = 'https://family-dashboard-rho-nine.vercel.app/api/google-callback'
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly'

export function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

// Get a valid access token from the server (uses httpOnly cookie — secret stays server-side)
export async function getAccessToken() {
  const res = await fetch('/api/google-refresh', { method: 'POST' })
  if (!res.ok) return null
  const data = await res.json()
  return data.access_token || null
}

export async function fetchEvents(access_token) {
  const res = await fetch('/api/google-calendar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token }),
  })
  return res.json()
}

export async function disconnect() {
  await fetch('/api/google-disconnect', { method: 'POST' })
}
