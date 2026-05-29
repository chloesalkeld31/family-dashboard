export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://family-dashboard-rho-nine.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { access_token } = req.body
  if (!access_token) return res.status(400).json({ error: 'Missing access_token' })

  const now = new Date().toISOString()
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const calListRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${access_token}` }
  })
  const calList = await calListRes.json()
  if (calList.error) return res.status(401).json({ error: calList.error.message })

  const calendars = (calList.items || []).filter(c => c.selected !== false)
  const allEvents = []

  await Promise.all(calendars.map(async cal => {
    const evRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
      `timeMin=${now}&timeMax=${future}&singleEvents=true&orderBy=startTime&maxResults=50`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    )
    const evData = await evRes.json()
    if (evData.items) evData.items.forEach(ev => allEvents.push({
      id: ev.id, title: ev.summary || '(No title)',
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
      allDay: !ev.start?.dateTime,
      calendar: cal.summary, color: cal.backgroundColor || '#4285f4',
      location: ev.location || null,
    }))
  }))

  allEvents.sort((a, b) => new Date(a.start) - new Date(b.start))
  return res.status(200).json({ events: allEvents })
}
