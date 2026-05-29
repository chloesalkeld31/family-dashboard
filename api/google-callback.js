// Serverless OAuth callback — Google redirects here with the auth code
// This exchanges it for tokens entirely server-side, stores in a cookie,
// and redirects back to the app. Secret never touches the browser.
module.exports = async function handler(req, res) {
  const { code, error } = req.query

  if (error) {
    return res.redirect(`/?gcal_error=${encodeURIComponent(error)}`)
  }

  if (!code) {
    return res.redirect('/?gcal_error=no_code')
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return res.redirect('/?gcal_error=server_config')
  }

  try {
    const params = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: 'https://family-dashboard-rho-nine.vercel.app/api/google-callback',
      grant_type: 'authorization_code',
    })

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })

    const tokens = await response.json()

    if (tokens.error) {
      return res.redirect(`/?gcal_error=${encodeURIComponent(tokens.error_description || tokens.error)}`)
    }

    // Store tokens in a secure httpOnly cookie
    const tokenData = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
    })

    // Encode for cookie storage
    const encoded = Buffer.from(tokenData).toString('base64')

    res.setHeader('Set-Cookie', `gcal_tokens=${encoded}; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`)
    return res.redirect('/?gcal_connected=true')

  } catch (e) {
    console.error('Token exchange error:', e)
    return res.redirect(`/?gcal_error=${encodeURIComponent('Token exchange failed')}`)
  }
}
