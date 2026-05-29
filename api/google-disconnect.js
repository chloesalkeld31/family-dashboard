// Clear the Google Calendar cookie
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://family-dashboard-rho-nine.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  res.setHeader('Set-Cookie', 'gcal_tokens=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/')
  return res.status(200).json({ ok: true })
}
