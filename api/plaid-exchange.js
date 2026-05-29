export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://family-dashboard-rho-nine.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = 'sandbox' } = process.env
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) return res.status(500).json({ error: 'Plaid not configured' })

  const baseUrl = PLAID_ENV === 'production' ? 'https://production.plaid.com'
    : PLAID_ENV === 'development' ? 'https://development.plaid.com'
    : 'https://sandbox.plaid.com'

  const { public_token } = req.body
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' })

  try {
    const response = await fetch(`${baseUrl}/item/public_token/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
      body: JSON.stringify({ public_token }),
    })
    const data = await response.json()
    if (data.error_code) return res.status(400).json({ error: data.error_message })
    return res.status(200).json({ access_token: data.access_token, item_id: data.item_id })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
