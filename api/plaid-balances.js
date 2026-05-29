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

  const { access_tokens } = req.body // array of {access_token, institution_name}
  if (!access_tokens?.length) return res.status(400).json({ error: 'No access tokens provided' })

  try {
    const results = await Promise.all(access_tokens.map(async ({ access_token, institution_name }) => {
      const response = await fetch(`${baseUrl}/accounts/balance/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
          'PLAID-SECRET': PLAID_SECRET,
        },
        body: JSON.stringify({ access_token }),
      })
      const data = await response.json()
      if (data.error_code) return { institution_name, error: data.error_message, accounts: [] }
      return {
        institution_name,
        accounts: data.accounts.map(acc => ({
          id: acc.account_id,
          name: acc.name,
          official_name: acc.official_name,
          type: acc.type,
          subtype: acc.subtype,
          current: acc.balances.current,
          available: acc.balances.available,
          limit: acc.balances.limit,
          iso_currency_code: acc.balances.iso_currency_code,
        }))
      }
    }))
    return res.status(200).json({ institutions: results })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
