export default async function handler(req, res) {
  const { code, error } = req.query
  if (error) return res.redirect(`/?gcal_error=${encodeURIComponent(error)}`)
  if (!code) return res.redirect('/?gcal_error=no_code')

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return res.redirect('/?gcal_error=server_config')

  try {
    const params = new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: 'https://family-dashboard-rho-nine.vercel.app/api/google-callback',
      grant_type: 'authorization_code',
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const tokens = await response.json()
    if (tokens.error) return res.redirect(`/?gcal_error=${encodeURIComponent(tokens.error_description || tokens.error)}`)

    const tokenData = Buffer.from(JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
    })).toString('base64')

    res.setHeader('Set-Cookie', `gcal_tokens=${tokenData}; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`)
    return res.redirect('/?gcal_connected=true')
  } catch (e) {
    console.error('Callback error:', e)
    return res.redirect(`/?gcal_error=token_exchange_failed`)
  }
}
