export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://family-dashboard-rho-nine.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const cookieHeader = req.headers.cookie || ''
  const match = cookieHeader.match(/gcal_tokens=([^;]+)/)
  if (!match) return res.status(401).json({ error: 'Not connected' })

  let tokens
  try { tokens = JSON.parse(Buffer.from(match[1], 'base64').toString()) }
  catch { return res.status(401).json({ error: 'Invalid token' }) }

  if (tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return res.status(200).json({ access_token: tokens.access_token })
  }

  if (!tokens.refresh_token) return res.status(401).json({ error: 'No refresh token' })

  const params = new URLSearchParams({
    refresh_token: tokens.refresh_token,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  })

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const fresh = await response.json()
  if (fresh.error) return res.status(401).json({ error: fresh.error_description })

  const newTokens = { ...tokens, access_token: fresh.access_token, expires_at: Date.now() + (fresh.expires_in * 1000) }
  const encoded = Buffer.from(JSON.stringify(newTokens)).toString('base64')
  res.setHeader('Set-Cookie', `gcal_tokens=${encoded}; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`)
  return res.status(200).json({ access_token: fresh.access_token })
}
