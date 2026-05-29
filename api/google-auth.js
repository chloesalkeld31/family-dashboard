// Vercel serverless function — handles Google OAuth token exchange
export default async function handler(req, res) {
  // Allow CORS from your app
  res.setHeader('Access-Control-Allow-Origin', 'https://family-dashboard-rho-nine.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { code, action } = req.body

  if (action === 'exchange') {
    // Exchange auth code for tokens
    const params = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'https://family-dashboard-rho-nine.vercel.app',
      grant_type: 'authorization_code',
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
    const data = await response.json()
    if (data.error) return res.status(400).json({ error: data.error_description })
    return res.status(200).json(data)
  }

  if (action === 'refresh') {
    // Refresh an expired access token
    const { refresh_token } = req.body
    const params = new URLSearchParams({
      refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
    const data = await response.json()
    if (data.error) return res.status(400).json({ error: data.error_description })
    return res.status(200).json(data)
  }

  return res.status(400).json({ error: 'Unknown action' })
}
