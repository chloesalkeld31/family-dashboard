module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Server configuration error', detail: `Client ID: ${!!clientId}, Secret: ${!!clientSecret}` })
  }

  const { code, action, refresh_token } = req.body

  if (action === 'exchange') {
    const params = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: 'https://family-dashboard-rho-nine.vercel.app',
      grant_type: 'authorization_code',
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const data = await response.json()
    if (data.error) return res.status(400).json({ error: data.error, detail: data.error_description })
    return res.status(200).json(data)
  }

  if (action === 'refresh') {
    const params = new URLSearchParams({
      refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const data = await response.json()
    if (data.error) return res.status(400).json({ error: data.error, detail: data.error_description })
    return res.status(200).json(data)
  }

  return res.status(400).json({ error: 'Unknown action' })
}
