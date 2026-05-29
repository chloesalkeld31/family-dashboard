// Google Calendar helper — handles auth and event fetching

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '651702299707-7mhrmif2joquubf9112s9r8b66n4h4eg.apps.googleusercontent.com'
const REDIRECT_URI = 'https://family-dashboard-rho-nine.vercel.app'
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
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  console.log('Google Auth URL:', url)
  console.log('Client ID being used:', CLIENT_ID)
  return url
}

export async function exchangeCode(code) {
  const res = await fetch('/api/google-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'exchange',
      code,
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      client_secret: import.meta.env.VITE_GOOGLE_CLIENT_SECRET,
    }),
  })
  return res.json()
}

export async function refreshToken(refresh_token) {
  const res = await fetch('/api/google-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'refresh',
      refresh_token,
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      client_secret: import.meta.env.VITE_GOOGLE_CLIENT_SECRET,
    }),
  })
  return res.json()
}

export async function fetchEvents(access_token) {
  const res = await fetch('/api/google-calendar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token }),
  })
  return res.json()
}
