import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { getAuthUrl, exchangeCode, refreshToken, fetchEvents } from './googleCalendar'
import './App.css'

const today = new Date(); today.setHours(0,0,0,0)
const yr = today.getFullYear(), mo = today.getMonth(), todayDay = today.getDate()
const daysLeftInMonth = new Date(yr, mo+1, 0).getDate() - todayDay
// If fewer than 5 days left in the month, show next month as "this month"
const displayMo = daysLeftInMonth < 5 ? mo + 1 : mo
const displayYr = displayMo > 11 ? yr + 1 : yr
const normDisplayMo = displayMo % 12
const PACE_WARN = 0.20
const STORES = { grocery: 150, costco: 300, custom: 0 }

// ── Date helpers ──────────────────────────────────────────────
function lastThursdayOfMonth(y, m) {
  const last = new Date(y, m+1, 0), dow = last.getDay()
  return new Date(y, m, last.getDate() - (dow >= 4 ? dow-4 : dow+3))
}
function nextOccurrence(day) {
  let d = new Date(yr, mo, day); if (d <= today) d = new Date(yr, mo+1, day); return d
}
function nextLastDay() {
  const lastOfThisMonth = new Date(yr, mo+1, 0)
  if (lastOfThisMonth <= today) return new Date(yr, mo+2, 0)
  return lastOfThisMonth
}
function nextLastThursday() {
  let d = lastThursdayOfMonth(yr, mo); if (d <= today) d = lastThursdayOfMonth(yr, mo+1); return d
}
function daysUntil(date) { return Math.round((date - today) / 86400000) }
function fmt(n) { return '$' + Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) }
function fmtR(n) { return '$' + Math.abs(n).toFixed(2) }

function getFixedDueDate(f) {
  if (f.due_type === 'day') return nextOccurrence(f.due_day)
  if (f.due_type === 'lastDay') {
    const lastOfThisMonth = new Date(yr, mo+1, 0)
    if (f.paid_this_month) return new Date(yr, mo+2, 0)
    if (lastOfThisMonth <= today) return new Date(yr, mo+2, 0)
    return lastOfThisMonth
  }
  return nextLastThursday()
}

// ── Finance logic ─────────────────────────────────────────────
function cardRunRate(card) {
  const hist = [card.history_1mo, card.history_2mo, card.history_3mo].filter(v => v != null)
  const stmtBal = card.statement_balance ?? card.balance
  // Current cycle charges = what's been spent since last statement closed
  const cycleCharges = Math.max(0, card.balance - stmtBal)

  if (!hist.length) return { projected: cycleCharges, dailyRate: 0, expectedNow: 0, paceOver: false, remainingSpend: 0, avg: 0, daysElapsed: 0, daysToTarget: 0, cycleLength: 30, paceRatio: 1, cycleCharges }
  const avg = hist.reduce((s,v) => s+v, 0) / hist.length

  // Use real statement close day if set, otherwise assume 1st of month
  const closeDay = card.statement_close_day || 1

  // Cycle started at the most recent statement close date
  let cycleStart = new Date(yr, mo, closeDay)
  if (cycleStart > today) cycleStart = new Date(yr, mo-1, closeDay)

  // Next statement close = one month after cycleStart
  const cycleEnd = new Date(cycleStart.getFullYear(), cycleStart.getMonth()+1, closeDay)
  const cycleLength = Math.round((cycleEnd - cycleStart) / 86400000)

  const daysElapsed = Math.max(1, Math.round((today - cycleStart) / 86400000))
  const daysToClose = Math.max(0, Math.round((cycleEnd - today) / 86400000))
  const dailyRate = avg / cycleLength
  // Expected cycle charges by today based on historical rate
  const expectedNow = dailyRate * daysElapsed
  // Project remaining spend until next statement close
  const remainingSpend = dailyRate * daysToClose
  // Projected total for this cycle = actual charges so far + projected remaining
  const projected = cycleCharges + remainingSpend

  // Pace: are we spending faster than historical average suggests?
  const paceOver = expectedNow > 0 && cycleCharges > expectedNow * (1 + PACE_WARN)
  const paceRatio = expectedNow > 0 ? cycleCharges / expectedNow : 1

  // Keep daysToTarget for coverage block (days to due date)
  const dueDate = nextOccurrence(card.due_day)
  const daysToTarget = Math.max(0, daysUntil(dueDate))

  return { projected, dailyRate, expectedNow, paceOver, paceRatio, remainingSpend, avg, daysElapsed, daysToTarget, daysToClose, cycleLength, cycleStart, cycleEnd, cycleCharges }
}

function depositsBeforeDue(deposits, dueDate) {
  let t = 0
  deposits.forEach(dep => {
    for (let o = 0; o <= 2; o++) {
      const d = new Date(yr, mo+o, dep.expected_day)
      if (d > today && d <= dueDate) t += dep.amount
    }
  })
  return t
}

function seasonalEstimate(v) {
  const hist = typeof v.history === 'string' ? JSON.parse(v.history) : v.history
  const a = hist[(mo+11)%12], b = hist[mo]
  const vals = [a, b].filter(x => x != null)
  if (!vals.length) return null
  return vals.reduce((s,x) => s+x, 0) / vals.length
}

// ── Small UI components ───────────────────────────────────────
function CountdownPill({ days }) {
  const cls = days <= 5 ? 'pill-urgent' : days <= 10 ? 'pill-soon' : 'pill-ok'
  return <span className={`countdown-pill ${cls}`}>Due in {days}d</span>
}

function CoverageBlock({ dueDate, amount, deposits, joint, otherBillsBefore = 0 }) {
  const depsBeforeDue = depositsBeforeDue(deposits, dueDate)
  const projectedBalance = joint + depsBeforeDue - otherBillsBefore
  const surplus = projectedBalance - amount
  const dueStr = dueDate.toLocaleDateString('en-US', {month:'short', day:'numeric'})
  return (
    <div>
      <div className="detail-row" style={{borderBottom:'none',paddingBottom:0}}>
        <span className="detail-label">Projected joint balance at due date</span>
        <span className="detail-value" style={{color: projectedBalance < 0 ? '#D85A30' : 'var(--color-text-primary)'}}>{projectedBalance < 0 ? '-' : ''}{fmt(projectedBalance)}</span>
      </div>
      <div className="detail-row" style={{borderBottom:'none',paddingBottom:0,marginTop:4}}>
        <span className="detail-label">After paying this bill</span>
        <span className="detail-value" style={{color: surplus >= 0 ? '#1D9E75' : '#D85A30', fontSize:15}}>{surplus < 0 ? '-' : '+'}{fmt(Math.abs(surplus))}</span>
      </div>
      <div className={`coverage-row ${surplus >= 0 ? 'cov-good' : 'cov-bad'}`} style={{marginTop:8}}>
        {surplus >= 0 ? `✓ Covered — ${fmt(surplus)} to spare by ${dueStr}` : `✗ Short by ${fmt(Math.abs(surplus))} — add funds before ${dueStr}`}
      </div>
      <div className="dep-note">
        {depsBeforeDue > 0 && otherBillsBefore > 0
          ? `↓ ${fmt(depsBeforeDue)} deposit · −${fmt(otherBillsBefore)} other bills paid before this date`
          : depsBeforeDue > 0 ? `↓ Includes ${fmt(depsBeforeDue)} deposit before due date`
          : otherBillsBefore > 0 ? `−${fmt(otherBillsBefore)} other bills paid before this date`
          : 'No deposits or earlier bills before this due date'}
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [tab, setTab] = useState('finances')
  const [loading, setLoading] = useState(true)
  const [joint, setJoint] = useState(0)
  const [deposits, setDeposits] = useState([])
  const [cards, setCards] = useState([])
  const [fixed, setFixed] = useState([])
  const [variable, setVariable] = useState([])
  const [todos, setTodos] = useState([])
  const [shoppingList, setShoppingList] = useState([])
  const [birthdays, setBirthdays] = useState([])
  const [calEvents, setCalEvents] = useState([])
  const [calConnected, setCalConnected] = useState(false)
  const [calLoading, setCalLoading] = useState(false)
  const [calError, setCalError] = useState(null)
  const [activeShoppingList, setActiveShoppingList] = useState('grocery')
  const [store, setStore] = useState('grocery')
  const [customSpend, setCustomSpend] = useState('')
  const [openEdit, setOpenEdit] = useState(null)
  const [editVals, setEditVals] = useState({})

  // ── Auth ──────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  async function handleLogin(e) {
    e.preventDefault()
    setLoginLoading(true)
    setLoginError('')
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPassword })
    if (error) setLoginError(error.message)
    setLoginLoading(false)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
  }

  // ── Load all data ─────────────────────────────────────────
  const loadAll = useCallback(async (showSpinner = true) => {
    const { data: { session: currentSession } } = await supabase.auth.getSession()
    if (!currentSession) return
    if (showSpinner) setLoading(true)
    const [ja, dep, cc, fx, vx, td, sl, bd] = await Promise.all([
      supabase.from('joint_account').select('*').limit(1),
      supabase.from('deposits').select('*').order('deposit_number'),
      supabase.from('credit_cards').select('*').order('sort_order'),
      supabase.from('fixed_expenses').select('*').order('sort_order'),
      supabase.from('variable_expenses').select('*').order('sort_order'),
      supabase.from('todos').select('*').order('created_at'),
      supabase.from('shopping_lists').select('*').order('created_at'),
      supabase.from('birthdays').select('*').order('birth_date'),
    ])
    if (ja.data && ja.data.length > 0) { setJoint(parseFloat(ja.data[0].balance)) }
    if (dep.data) setDeposits(dep.data.map(d => ({...d, amount: parseFloat(d.amount)})))
    if (cc.data) setCards(cc.data.map(c => ({...c, balance: parseFloat(c.balance), statement_balance: c.statement_balance != null ? parseFloat(c.statement_balance) : parseFloat(c.balance), statement_close_day: c.statement_close_day ? parseInt(c.statement_close_day) : null, history_1mo: c.history_1mo != null ? parseFloat(c.history_1mo) : null, history_2mo: c.history_2mo != null ? parseFloat(c.history_2mo) : null, history_3mo: c.history_3mo != null ? parseFloat(c.history_3mo) : null})))
    if (fx.data) setFixed(fx.data.map(f => ({...f, amount: parseFloat(f.amount), extra_payment: parseFloat(f.extra_payment||0), paid_this_month: f.paid_this_month || false})))
    if (vx.data) setVariable(vx.data.map(v => ({...v, current_bill: v.current_bill != null ? parseFloat(v.current_bill) : null, history: typeof v.history === 'string' ? JSON.parse(v.history) : v.history})))
    if (td.data) setTodos(td.data)
    if (sl.data) setShoppingList(sl.data)
    if (bd.data) {
      setBirthdays(bd.data)
      // Auto-create "send card" todos for birthdays within 30 days
      // that aren't card_sent and don't already have an active task
      if (td.data && bd.data.length > 0) {
        const existingTasks = new Set(td.data.filter(t => t.status !== 'done').map(t => t.text))
        for (const bday of bd.data) {
          if (bday.card_sent) continue
          const birth = new Date(bday.birth_date + 'T00:00:00')
          const thisYear = new Date(today.getFullYear(), birth.getMonth(), birth.getDate())
          const nextBday = thisYear < today
            ? new Date(today.getFullYear()+1, birth.getMonth(), birth.getDate())
            : thisYear
          const daysAway = Math.round((nextBday - today) / 86400000)
          const taskText = `Send birthday card — ${bday.name}`
          if (daysAway <= 30 && !existingTasks.has(taskText)) {
            const dueLabel = nextBday.toLocaleDateString('en-US',{month:'short',day:'numeric'})
            await supabase.from('todos').insert({ text: taskText, status: 'todo', assigned_to: '', due_label: dueLabel })
          }
        }
        // Reload todos if we inserted any
        const { data: freshTodos } = await supabase.from('todos').select('*').order('created_at')
        if (freshTodos) setTodos(freshTodos)
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => { if (session) loadAll() }, [session, loadAll])

  // ── Google Calendar ───────────────────────────────────────
  useEffect(() => {
    // Check if we're returning from Google OAuth with a code
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code) {
      // Clean the URL
      window.history.replaceState({}, '', '/')
      handleGoogleCode(code)
    } else {
      // Try to load stored tokens
      loadCalendarTokens()
    }
  }, [session])

  async function loadCalendarTokens() {
    const stored = localStorage.getItem('gcal_tokens')
    if (!stored) return
    const tokens = JSON.parse(stored)
    // Check if access token is still valid (expires_at stored in ms)
    if (tokens.expires_at && Date.now() < tokens.expires_at) {
      await loadCalEvents(tokens.access_token)
    } else if (tokens.refresh_token) {
      // Refresh the token
      const fresh = await refreshToken(tokens.refresh_token)
      if (fresh.access_token) {
        const newTokens = {
          ...tokens,
          access_token: fresh.access_token,
          expires_at: Date.now() + (fresh.expires_in * 1000)
        }
        localStorage.setItem('gcal_tokens', JSON.stringify(newTokens))
        await loadCalEvents(fresh.access_token)
      }
    }
  }

  async function handleGoogleCode(code) {
    setCalLoading(true)
    setCalError(null)
    try {
      const tokens = await exchangeCode(code)
      if (tokens.error) { setCalError(tokens.error); setCalLoading(false); return }
      const stored = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      }
      localStorage.setItem('gcal_tokens', JSON.stringify(stored))
      await loadCalEvents(tokens.access_token)
    } catch(e) {
      setCalError('Failed to connect Google Calendar')
    }
    setCalLoading(false)
  }

  async function loadCalEvents(access_token) {
    setCalLoading(true)
    setCalError(null)
    try {
      const data = await fetchEvents(access_token)
      if (data.error) {
        setCalError(data.error)
        setCalConnected(false)
      } else {
        setCalEvents(data.events || [])
        setCalConnected(true)
      }
    } catch(e) {
      setCalError('Failed to load events')
    }
    setCalLoading(false)
  }

  function disconnectCalendar() {
    localStorage.removeItem('gcal_tokens')
    setCalConnected(false)
    setCalEvents([])
  }

  // ── Realtime sync ─────────────────────────────────────────
  useEffect(() => {
    const channel = supabase.channel('db-changes')
      .on('postgres_changes', {event:'*', schema:'public'}, () => loadAll())
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [loadAll])

  // ── Computed values ───────────────────────────────────────
  const totalProjectedCards = cards.reduce((s,c) => s + (c.statement_balance ?? c.balance), 0)
  const totalFixedAndVar = fixed.reduce((s,f) => s + f.amount + (f.extra_payment||0), 0) +
    variable.reduce((s,v) => { const e = seasonalEstimate(v); return s + (v.current_bill != null ? v.current_bill : (e||0)) }, 0)
  const totalAllBills = totalProjectedCards + totalFixedAndVar
  const totalAllDeposits = deposits.reduce((s,d) => s+d.amount, 0)
  const leftover = joint + totalAllDeposits - totalAllBills

  // Next month — no card estimate, just fixed & variable + same deposits
  const nextMonthDeposits = totalAllDeposits
  const nextMonthFixed = fixed.reduce((s,f) => s + f.amount, 0)
  const nextMonthVariable = variable.reduce((s,v) => {
    const hist = typeof v.history === 'string' ? JSON.parse(v.history) : v.history
    const nextMo = (mo+1)%12
    const a = hist[(nextMo+11)%12], b = hist[nextMo]
    const vals = [a,b].filter(x=>x!=null)
    return s + (vals.length ? vals.reduce((s,x)=>s+x,0)/vals.length : 0)
  }, 0)
  const nextMonthStart = Math.max(0, leftover)
  const nextMonthBills = nextMonthFixed + nextMonthVariable
  // Next month card estimate = charges already on card beyond the statement balance
  const nextMonthCards = cards.reduce((s,c) => {
    const stmtBal = c.statement_balance ?? c.balance
    const rollover = Math.max(0, c.balance - stmtBal)
    return s + rollover
  }, 0)
  const nextMonthLeftover = nextMonthStart + nextMonthDeposits - nextMonthBills - nextMonthCards

  // Upcoming bills sorted chronologically
  const upcomingBills = [
    ...cards.map(c => ({
      name: c.name,
      icon: 'ti-credit-card',
      due: nextOccurrence(c.due_day),
      amount: c.statement_balance ?? c.balance,
      label: 'Statement balance'
    })),
    ...fixed.map(f => ({
      name: f.name,
      icon: f.icon,
      due: getFixedDueDate(f),
      amount: f.amount + (f.extra_payment||0),
      label: f.due_type==='lastThursday'?'Last Thursday':f.due_type==='lastDay'?'Last day of month':`Day ${f.due_day}`
    })),
    ...variable.map(v => {
      const e = seasonalEstimate(v)
      return {
        name: v.name,
        icon: v.icon,
        due: nextOccurrence(v.scheduled_day),
        amount: v.current_bill != null ? v.current_bill : (e||0),
        label: v.current_bill != null ? 'Actual bill' : 'Estimated'
      }
    })
  ].sort((a,b) => a.due - b.due)

  // Per-card safe-to-spend: joint + deposits before close date − bills due before close date
  function nextCloseDate(card) {
    const closeDay = card.statement_close_day || 1
    let d = new Date(yr, mo, closeDay)
    if (d <= today) d = new Date(yr, mo+1, closeDay)
    return d
  }

  function billsDueBeforeDate(targetDate, excludeCardId = null) {
    let total = 0
    fixed.forEach(f => {
      const due = getFixedDueDate(f)
      if (due < targetDate) total += f.amount + (f.extra_payment||0)
    })
    variable.forEach(v => {
      const due = nextOccurrence(v.scheduled_day)
      const e = seasonalEstimate(v)
      const amt = v.current_bill != null ? v.current_bill : (e||0)
      if (due < targetDate) total += amt
    })
    cards.forEach(c => {
      if (excludeCardId && c.id === excludeCardId) return
      const due = nextOccurrence(c.due_day)
      if (due < targetDate) total += c.statement_balance ?? c.balance
    })
    return total
  }

  const plannedSpend = store === 'custom' ? (parseFloat(customSpend)||0) : STORES[store]

  const allItems = [
    ...cards.map(c => ({ due: nextOccurrence(c.due_day), amount: c.statement_balance ?? c.balance })),
    ...fixed.map(f => ({ due: getFixedDueDate(f), amount: f.amount + (f.extra_payment||0) })),
    ...variable.map(v => { const e = seasonalEstimate(v); return { due: nextOccurrence(v.scheduled_day), amount: v.current_bill != null ? v.current_bill : (e||0) } })
  ]
  const totalShortfall = allItems.reduce((s, item) => {
    const proj = joint + depositsBeforeDue(deposits, item.due)
    const surplus = proj - item.amount
    return surplus < 0 ? s + Math.abs(surplus) : s
  }, 0)

  // ── Save helpers ──────────────────────────────────────────
  async function saveJoint() {
    const v = parseFloat(editVals.joint ?? joint)
    if (isNaN(v)) return
    await supabase.from('joint_account').update({ balance: v, updated_at: new Date() }).not('id', 'is', null)
    setOpenEdit(null)
    await loadAll(false)
  }

  async function saveDeposit(dep) {
    const day = parseInt(editVals[`dep_day_${dep.id}`] ?? dep.expected_day)
    const amt = parseFloat(editVals[`dep_amt_${dep.id}`] ?? dep.amount)
    if (isNaN(day) || isNaN(amt)) return
    await supabase.from('deposits').update({ expected_day: day, amount: amt, updated_at: new Date() }).eq('id', dep.id)
    setOpenEdit(null)
    await loadAll(false)
  }

  async function saveCard(card) {
    const name = editVals[`cn_${card.id}`] ?? card.name
    const bal = parseFloat(editVals[`cb_${card.id}`] ?? card.balance)
    const stmtBal = parseFloat(editVals[`cs_${card.id}`] ?? card.statement_balance)
    const closeDay = parseInt(editVals[`cc_${card.id}`] ?? card.statement_close_day)
    const day = parseInt(editVals[`cd_${card.id}`] ?? card.due_day)
    const h1 = parseFloat(editVals[`ch1_${card.id}`])
    const h2 = parseFloat(editVals[`ch2_${card.id}`])
    const h3 = parseFloat(editVals[`ch3_${card.id}`])
    await supabase.from('credit_cards').update({
      name: name || card.name,
      balance: isNaN(bal) ? card.balance : bal,
      statement_balance: isNaN(stmtBal) ? card.statement_balance : stmtBal,
      statement_close_day: isNaN(closeDay) ? card.statement_close_day : closeDay,
      due_day: isNaN(day) ? card.due_day : day,
      history_1mo: isNaN(h1) ? card.history_1mo : h1,
      history_2mo: isNaN(h2) ? card.history_2mo : h2,
      history_3mo: isNaN(h3) ? card.history_3mo : h3,
      updated_at: new Date()
    }).eq('id', card.id)
    setOpenEdit(null)
    await loadAll(false)
  }

  async function saveFixed(f) {
    const amt = parseFloat(editVals[`fa_${f.id}`] ?? f.amount)
    const extra = parseFloat(editVals[`fe_${f.id}`] ?? f.extra_payment) || 0
    await supabase.from('fixed_expenses').update({ amount: isNaN(amt)?f.amount:amt, extra_payment: isNaN(extra)?0:extra, updated_at: new Date() }).eq('id', f.id)
    setOpenEdit(null)
    await loadAll(false)
  }

  async function togglePaidThisMonth(f) {
    await supabase.from('fixed_expenses').update({ paid_this_month: !f.paid_this_month, updated_at: new Date() }).eq('id', f.id)
    await loadAll(false)
  }

  async function saveVariable(v) {
    const bill = parseFloat(editVals[`vb_${v.id}`])
    const schedDay = parseInt(editVals[`vd_${v.id}`])
    const lastMo = parseFloat(editVals[`vlm_${v.id}`])
    const lastYr = parseFloat(editVals[`vly_${v.id}`])
    const newHist = [...v.history]
    if (!isNaN(lastMo)) newHist[(mo+11)%12] = lastMo
    if (!isNaN(lastYr)) newHist[mo] = lastYr
    await supabase.from('variable_expenses').update({
      current_bill: isNaN(bill) ? v.current_bill : bill,
      scheduled_day: isNaN(schedDay) ? v.scheduled_day : schedDay,
      history: newHist,
      updated_at: new Date()
    }).eq('id', v.id)
    setOpenEdit(null)
    await loadAll(false)
  }

  async function addTodo() {
    const text = editVals.new_todo?.trim()
    if (!text) return
    await supabase.from('todos').insert({ text, status: 'todo', assigned_to: editVals.new_who||'', due_label: editVals.new_due||'' })
    setEditVals(v => ({...v, new_todo:'', new_who:'', new_due:''}))
    setOpenEdit(null)
    await loadAll(false)
  }

  async function setTodoStatus(todo, newStatus) {
    const updates = { status: newStatus, updated_at: new Date() }
    if (newStatus === 'done') updates.archived_at = new Date()
    if (newStatus !== 'done') updates.archived_at = null
    await supabase.from('todos').update(updates).eq('id', todo.id)
    // If this is a birthday card task being marked done, auto-mark card_sent
    if (newStatus === 'done' && todo.text.startsWith('Send birthday card — ')) {
      const bdName = todo.text.replace('Send birthday card — ', '').trim()
      const match = birthdays.find(b => b.name === bdName)
      if (match) await supabase.from('birthdays').update({ card_sent: true, updated_at: new Date() }).eq('id', match.id)
    }
    await loadAll(false)
  }

  async function deleteTodo(todo) {
    await supabase.from('todos').delete().eq('id', todo.id)
    await loadAll(false)
  }

  async function addBirthday() {
    const name = editVals.bd_name?.trim()
    const month = editVals.bd_month
    const day = editVals.bd_day
    const year = editVals.bd_year?.trim()
    if (!name || !month || !day) return
    // Use 1900 as placeholder year when unknown — we'll check for this to hide age
    const useYear = year ? year.padStart(4,'0') : '1900'
    const dateStr = `${useYear}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`
    const { error } = await supabase.from('birthdays').insert({
      name,
      birth_date: dateStr,
      card_sent: false,
      year_known: !!year
    })
    if (error) { console.error('Birthday insert error:', error); alert('Error saving: ' + error.message); return }
    setEditVals(v => ({...v, bd_name:'', bd_month:'', bd_day:'', bd_year:''}))
    setOpenEdit(null)
    await loadAll(false)
  }

  async function toggleCardSent(bd) {
    await supabase.from('birthdays').update({ card_sent: !bd.card_sent, updated_at: new Date() }).eq('id', bd.id)
    await loadAll(false)
  }

  async function deleteBirthday(bd) {
    await supabase.from('birthdays').delete().eq('id', bd.id)
    await loadAll(false)
  }

  async function addShoppingItem() {
    const text = editVals.new_shop_item?.trim()
    if (!text) return
    await supabase.from('shopping_lists').insert({ list: activeShoppingList, item: text, checked: false })
    setEditVals(v => ({...v, new_shop_item: ''}))
    await loadAll(false)
  }

  async function toggleShoppingItem(item) {
    await supabase.from('shopping_lists').update({ checked: !item.checked, updated_at: new Date() }).eq('id', item.id)
    await loadAll(false)
  }

  async function deleteShoppingItem(item) {
    await supabase.from('shopping_lists').delete().eq('id', item.id)
    await loadAll(false)
  }

  async function clearChecked() {
    const checkedIds = shoppingList.filter(i => i.list === activeShoppingList && i.checked).map(i => i.id)
    if (!checkedIds.length) return
    await supabase.from('shopping_lists').delete().in('id', checkedIds)
    await loadAll(false)
  }

  function ev(key) {
    return (e) => setEditVals(v => ({...v, [key]: e.target.value}))
  }

  function toggleEdit(key) {
    setOpenEdit(p => p === key ? null : key)
  }

  // Auth loading state
  if (authLoading) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',flexDirection:'column',gap:12}}>
      <div className="spinner"></div>
    </div>
  )

  // Login screen
  if (!session) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',background:'var(--color-background-tertiary)'}}>
      <div style={{background:'var(--color-background-primary)',border:'0.5px solid var(--color-border-tertiary)',borderRadius:'var(--border-radius-lg)',padding:'2rem 1.5rem',width:'100%',maxWidth:380,margin:'0 1rem'}}>
        <div style={{textAlign:'center',marginBottom:'1.5rem'}}>
          <div style={{fontSize:32,marginBottom:8}}>🏠</div>
          <div style={{fontSize:20,fontWeight:500,color:'var(--color-text-primary)'}}>Family Dashboard</div>
          <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:4}}>Sign in to continue</div>
        </div>
        <form onSubmit={handleLogin}>
          <div style={{marginBottom:12}}>
            <label style={{fontSize:12,color:'var(--color-text-secondary)',display:'block',marginBottom:6}}>Email</label>
            <input type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="your@email.com" required style={{width:'100%'}} />
          </div>
          <div style={{marginBottom:16}}>
            <label style={{fontSize:12,color:'var(--color-text-secondary)',display:'block',marginBottom:6}}>Password</label>
            <input type="password" value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="••••••••" required style={{width:'100%'}} />
          </div>
          {loginError && <div style={{fontSize:13,color:'#D85A30',marginBottom:12,padding:'8px 10px',background:'#FCEBEB',borderRadius:'var(--border-radius-md)'}}>{loginError}</div>}
          <button type="submit" className="save-btn" disabled={loginLoading} style={{opacity:loginLoading?0.6:1}}>
            {loginLoading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )

  if (loading) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',flexDirection:'column',gap:12}}>
      <div className="spinner"></div>
      <p style={{color:'var(--color-text-secondary)',fontSize:14}}>Loading your dashboard…</p>
    </div>
  )

  const statusLabels = {todo:'To do',inprogress:'In progress',done:'Done',blocked:'Blocked'}
  const statusClass = {todo:'badge-todo',inprogress:'badge-inprogress',done:'badge-done',blocked:'badge-blocked'}

  return (
    <div className="app">
      {/* NAV */}
      <nav className="nav">
        {[['finances','ti-credit-card','Finances'],['todos','ti-checkbox','To-do'],['shopping','ti-shopping-cart','Lists'],['calendar','ti-calendar','Calendar']].map(([t,icon,label]) => (
          <button key={t} className={`nav-btn ${tab===t?'active':''}`} onClick={() => setTab(t)}>
            <i className={`ti ${icon}`} aria-hidden="true"></i>{label}
          </button>
        ))}
        <button className="nav-btn" onClick={handleLogout} title="Sign out" style={{maxWidth:44}}>
          <i className="ti ti-logout" aria-hidden="true"></i>
        </button>
      </nav>

      {/* ── FINANCES ── */}
      {tab === 'finances' && (
        <div className="section">

          {/* Monthly overview — this month + next month */}
          {[
            {
              label: `${new Date(displayYr,normDisplayMo,1).toLocaleDateString('en-US',{month:'long',year:'numeric'})} (this month)`,
              startBalance: joint,
              deposits: totalAllDeposits,
              cards: totalProjectedCards,
              cardsLabel: 'Card statements (actual)',
              fixedVar: totalFixedAndVar,
              leftover: leftover,
              leftoverRR: null,
              isThisMonth: true,
            },
            {
              label: `${new Date(displayYr,normDisplayMo+1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'})} (next month)`,
              startBalance: nextMonthStart,
              deposits: nextMonthDeposits,
              cards: nextMonthCards,
              cardsLabel: `Est. card charges (current − statement)`,
              fixedVar: nextMonthBills,
              leftover: nextMonthLeftover,
              leftoverRR: null,
              isThisMonth: false,
            }
          ].map((m, i) => (
            <div key={i} className="spend-card" style={{marginBottom:'0.75rem'}}>
              <div style={{fontSize:12,fontWeight:500,color:'var(--color-text-secondary)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:10}}>{m.label}</div>
              <div style={{display:'flex',gap:10,marginBottom:12}}>
                <div style={{flex:1,background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)',padding:'12px'}}>
                  <div style={{fontSize:11,color:'var(--color-text-secondary)',marginBottom:4}}>Leftover</div>
                  <div style={{fontSize:22,fontWeight:500,color:m.leftover>=200?'#1D9E75':m.leftover>=0?'#BA7517':'#D85A30'}}>{m.leftover<0?'-':''}{fmt(m.leftover)}</div>
                </div>
                <div style={{flex:1,background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)',padding:'12px'}}>
                  <div style={{fontSize:11,color:'var(--color-text-secondary)',marginBottom:4}}>{m.isThisMonth ? 'Joint now' : 'Starting balance'}</div>
                  <div style={{fontSize:22,fontWeight:500,color:m.startBalance>=0?'var(--color-text-primary)':'#D85A30'}}>{m.startBalance<0?'-':''}{fmt(m.startBalance)}</div>
                </div>
              </div>
              <div className="spend-breakdown" style={{marginTop:0}}>
                <div className="spend-line"><span>{m.isThisMonth?'Joint account now':'This month\'s leftover'}</span><span className={m.startBalance>=0?'val-pos':'val-neg'}>{m.startBalance<0?'-':''}{fmt(m.startBalance)}</span></div>
                <div className="spend-line"><span>Deposits</span><span className="val-pos">+{fmt(m.deposits)}</span></div>
                {m.cards > 0 && <div className="spend-line"><span>{m.cardsLabel}</span><span className="val-neg">-{fmt(m.cards)}</span></div>}
                <div className="spend-line"><span>Fixed &amp; variable bills</span><span className="val-neg">-{fmt(m.fixedVar)}</span></div>
                <div className="spend-line total"><span>Leftover</span><span style={{color:m.leftover>=200?'#1D9E75':m.leftover>=0?'#BA7517':'#D85A30'}}>{m.leftover<0?'-':''}{fmt(m.leftover)}</span></div>
              </div>
            </div>
          ))}

          {/* Action items — what needs to be added and by when */}
          {(() => {
            // Build a chronological list of all bills with their shortfalls
            const allBillItems = [
              ...cards.map(c => ({
                name: c.name,
                due: nextOccurrence(c.due_day),
                amount: c.statement_balance ?? c.balance,
                id: `card_${c.id}`
              })),
              ...fixed.map(f => ({
                name: f.name,
                due: getFixedDueDate(f),
                amount: f.amount + (f.extra_payment||0),
                id: `fixed_${f.id}`
              })),
              ...variable.map(v => {
                const e = seasonalEstimate(v)
                return {
                  name: v.name,
                  due: nextOccurrence(v.scheduled_day),
                  amount: v.current_bill != null ? v.current_bill : (e||0),
                  id: `var_${v.id}`
                }
              })
            ].sort((a,b) => a.due - b.due)

            // Simulate paying bills in chronological order with deposits landing on schedule
            // Track running balance and flag anything that would overdraw
            const actionItems = []
            let runningBal = joint

            // Build a timeline of all events (deposits and bills) sorted by date
            const timeline = []

            // Add deposits
            deposits.forEach(dep => {
              let d = new Date(yr, mo, dep.expected_day)
              if (d <= today) d = new Date(yr, mo+1, dep.expected_day)
              timeline.push({ date: d, type: 'deposit', amount: dep.amount, name: `Deposit` })
            })

            // Add all bills
            allBillItems.forEach(bill => {
              timeline.push({ date: bill.due, type: 'bill', amount: bill.amount, name: bill.name, id: bill.id })
            })

            // Sort by date
            timeline.sort((a,b) => a.date - b.date)

            // Simulate
            timeline.forEach(event => {
              if (event.type === 'deposit') {
                runningBal += event.amount
              } else {
                runningBal -= event.amount
                if (runningBal < 0) {
                  actionItems.push({
                    name: event.name,
                    id: event.id,
                    shortfall: Math.abs(runningBal),
                    daysUntilDue: daysUntil(event.date),
                    dueStr: event.date.toLocaleDateString('en-US',{month:'short',day:'numeric'})
                  })
                  // Reset to 0 so subsequent items show their own shortfall from this point
                  runningBal = 0
                }
              }
            })

            if (actionItems.length === 0) {
              return (
                <div className="banner banner-good">
                  <i className="ti ti-circle-check" style={{fontSize:20,flexShrink:0}} aria-hidden="true"></i>
                  <span>All expenses covered this month — no action needed.</span>
                </div>
              )
            }

            // Total needed = max shortfall across all items (they share the same account)
            // Find the earliest deadline and the amount needed by then
            const earliest = actionItems[0]
            const totalNeeded = actionItems.reduce((s,i) => s + i.shortfall, 0)

            return (
              <div className="exp-card" style={{borderColor:'#D85A30',marginBottom:'1rem'}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                  <i className="ti ti-alert-circle" style={{fontSize:22,color:'#D85A30',flexShrink:0}} aria-hidden="true"></i>
                  <div>
                    <div style={{fontSize:15,fontWeight:500,color:'#A32D2D'}}>Action required</div>
                    <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>Add funds to the joint account to avoid overdrafts</div>
                  </div>
                </div>

                {actionItems.map((item,i) => (
                  <div key={item.id} style={{
                    display:'flex',justifyContent:'space-between',alignItems:'center',
                    padding:'10px 12px',borderRadius:'var(--border-radius-md)',
                    background: i===0?'#FCEBEB':'var(--color-background-secondary)',
                    marginBottom: i<actionItems.length-1?8:0
                  }}>
                    <div>
                      <div style={{fontSize:13,fontWeight:500,color: i===0?'#A32D2D':'var(--color-text-primary)'}}>
                        {i===0 && <span style={{fontSize:11,background:'#D85A30',color:'white',borderRadius:99,padding:'1px 7px',marginRight:6}}>URGENT</span>}
                        Add {fmt(item.shortfall)} by {item.dueStr}
                      </div>
                      <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>
                        {item.name} · {item.daysUntilDue}d away · short by {fmt(item.shortfall)}
                      </div>
                    </div>
                    <div style={{fontSize:13,fontWeight:500,color:'#D85A30',flexShrink:0,marginLeft:12}}>
                      {fmt(item.shortfall)}
                    </div>
                  </div>
                ))}

                <div style={{marginTop:12,padding:'10px 12px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:13,color:'var(--color-text-secondary)'}}>Add to joint account now to cover all shortfalls</span>
                  <span style={{fontSize:15,fontWeight:500,color:'#D85A30'}}>{fmt(totalNeeded)}</span>
                </div>
              </div>
            )
          })()}

          <div className="metric-grid">
            <div className="metric"><div className="metric-label">Joint account now</div><div className="metric-value">{fmt(joint)}</div></div>
            <div className="metric">
              <div className="metric-label">Total bills this month</div>
              <div className="metric-value">{fmt(totalAllBills)}</div>
              <div className="metric-sub">cards + fixed + variable</div>
            </div>
          </div>
          <div className="metric-grid">
            <div className="metric"><div className="metric-label">Total deposits</div><div className="metric-value">{fmt(totalAllDeposits)}</div></div>
            <div className="metric">
              <div className="metric-label">Leftover after bills</div>
              <div className="metric-value" style={{color:leftover>=500?'#1D9E75':leftover>=0?'#BA7517':'#D85A30'}}>{leftover<0?'-':''}{fmt(leftover)}</div>
              <div className="metric-sub">{leftover>=500?'Extra mortgage possible':leftover>=0?'Tight — hold off':'Short this month'}</div>
            </div>
          </div>

          {/* Joint account edit */}
          <div className="card">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span className="card-title" style={{marginBottom:0}}>Joint account</span>
              <button className="edit-btn" onClick={()=>{ setEditVals(v=>({...v,joint:String(joint)})); toggleEdit('joint') }}>
                <i className="ti ti-edit" aria-hidden="true"></i> Edit
              </button>
            </div>
            {openEdit==='joint' && (
              <div className="inline-edit open">
                <div className="edit-row"><label>Current balance ($)</label><input type="number" min="0" value={editVals.joint??''} onChange={ev('joint')} /></div>
                <button className="save-btn" onClick={saveJoint}>Save</button>
              </div>
            )}
          </div>

          {/* Deposits */}
          <div className="card">
            <div className="card-header"><span className="card-title" style={{marginBottom:0}}>Upcoming deposits</span></div>
            {[...deposits].sort((a,b) => {
              let da = new Date(yr,mo,a.expected_day); if(da<=today) da=new Date(yr,mo+1,a.expected_day)
              let db = new Date(yr,mo,b.expected_day); if(db<=today) db=new Date(yr,mo+1,b.expected_day)
              return da - db
            }).map((dep,i) => {
              let dd = new Date(yr,mo,dep.expected_day); if(dd<=today) dd=new Date(yr,mo+1,dep.expected_day)
              return (
                <div key={dep.id}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom: i<deposits.length-1?'0.5px solid var(--color-border-tertiary)':'none'}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:500,color:'var(--color-text-primary)'}}>Deposit {dep.deposit_number} — {fmt(dep.amount)}</div>
                      <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>Expected {dd.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
                    </div>
                    <div style={{display:'flex',gap:6,alignItems:'center'}}>
                      <span className="countdown-pill pill-ok">In {daysUntil(dd)}d</span>
                      <button className="edit-btn" onClick={()=>{ setEditVals(v=>({...v, [`dep_day_${dep.id}`]:String(dep.expected_day), [`dep_amt_${dep.id}`]:String(dep.amount)})); toggleEdit(`dep_${dep.id}`) }}><i className="ti ti-edit" aria-hidden="true"></i></button>
                    </div>
                  </div>
                  {openEdit===`dep_${dep.id}` && (
                    <div className="inline-edit open">
                      <div className="edit-row"><label>Expected day</label><input type="number" min="1" max="31" value={editVals[`dep_day_${dep.id}`]??''} onChange={ev(`dep_day_${dep.id}`)} /></div>
                      <div className="edit-row"><label>Amount ($)</label><input type="number" min="0" value={editVals[`dep_amt_${dep.id}`]??''} onChange={ev(`dep_amt_${dep.id}`)} /></div>
                      <button className="save-btn" onClick={()=>saveDeposit(dep)}>Save</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Upcoming bills */}
          <div className="card">
            <div className="card-title">Upcoming bills</div>
            {upcomingBills.map((bill, i) => {
              const dueStr = bill.due.toLocaleDateString('en-US',{month:'short',day:'numeric'})
              const days = daysUntil(bill.due)
              const pillCls = days <= 5 ? 'pill-urgent' : days <= 10 ? 'pill-soon' : 'pill-ok'
              return (
                <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<upcomingBills.length-1?'0.5px solid var(--color-border-tertiary)':'none'}}>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <i className={`ti ${bill.icon}`} style={{fontSize:15,color:'var(--color-text-secondary)',flexShrink:0}} aria-hidden="true"></i>
                    <div>
                      <div style={{fontSize:13,fontWeight:500,color:'var(--color-text-primary)'}}>{bill.name}</div>
                      <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>{dueStr} · {bill.label}</div>
                    </div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
                    <span className={`countdown-pill ${pillCls}`}>In {days}d</span>
                    <span style={{fontSize:13,fontWeight:500,color:'var(--color-text-primary)',minWidth:70,textAlign:'right'}}>{fmt(bill.amount)}</span>
                  </div>
                </div>
              )
            })}
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,fontWeight:500,paddingTop:10,marginTop:2,borderTop:'0.5px solid var(--color-border-tertiary)'}}>
              <span style={{color:'var(--color-text-secondary)'}}>Total</span>
              <span>{fmt(totalAllBills)}</span>
            </div>
          </div>

          {/* Credit cards */}
          <div className="section-label">Credit cards</div>
          {cards.map(card => {
            const due = nextOccurrence(card.due_day)
            const days = daysUntil(due)
            const dueStr = due.toLocaleDateString('en-US',{month:'short',day:'numeric'})
            const closeDate = nextCloseDate(card)
            const closeDateStr = closeDate.toLocaleDateString('en-US',{month:'short',day:'numeric'})
            const rr = cardRunRate(card)
            const pctElapsed = Math.min(100, Math.round((rr.daysElapsed/rr.cycleLength)*100))
            const pctCycleCharges = rr.avg>0 ? Math.min(130, Math.round((rr.cycleCharges/rr.avg)*100)) : 0
            const stmtBal = card.statement_balance ?? card.balance
            return (
              <div key={card.id} className="exp-card">
                <div className="exp-header">
                  <div><div className="exp-name"><i className="ti ti-credit-card" aria-hidden="true"></i>{card.name}</div>
                    <div className="exp-meta">Statement closes {closeDateStr} · payment due {dueStr}</div></div>
                  <div style={{display:'flex',gap:6,alignItems:'center'}}>
                    <CountdownPill days={days} />
                    <button className="edit-btn" onClick={()=>{ setEditVals(v=>({...v, [`cn_${card.id}`]:card.name, [`cb_${card.id}`]:String(card.balance), [`cs_${card.id}`]:String(stmtBal), [`cc_${card.id}`]:String(card.statement_close_day??''), [`cd_${card.id}`]:String(card.due_day), [`ch1_${card.id}`]:String(card.history_1mo??''), [`ch2_${card.id}`]:String(card.history_2mo??''), [`ch3_${card.id}`]:String(card.history_3mo??'')})); toggleEdit(`card_${card.id}`) }}><i className="ti ti-edit" aria-hidden="true"></i></button>
                  </div>
                </div>

                {/* Statement & payment section */}
                <div className="detail-row"><span className="detail-label">Statement balance (amount due)</span><span className="detail-value" style={{fontSize:15}}>{fmt(stmtBal)}</span></div>
                <div className="detail-row"><span className="detail-label">Current balance (incl. new charges)</span><span className="detail-value">{fmt(card.balance)}</span></div>

                {/* Current cycle spending section */}
                {rr.avg > 0 && (
                  <div style={{marginTop:10,paddingTop:10,borderTop:'0.5px solid var(--color-border-tertiary)'}}>
                    <div style={{fontSize:12,fontWeight:500,color:'var(--color-text-secondary)',marginBottom:8}}>This cycle's spending (since statement closed)</div>
                    <div className="detail-row"><span className="detail-label">Charges since statement</span><span className="detail-value">{fmt(rr.cycleCharges)}</span></div>
                    <div className="detail-row"><span className="detail-label">Projected remaining ({rr.daysToClose}d × {fmtR(rr.dailyRate)}/d)</span><span className="detail-value" style={{color:'#BA7517'}}>+{fmt(rr.remainingSpend)}</span></div>
                    <div className="detail-row"><span className="detail-label">Projected cycle total</span><span className="detail-value" style={{fontWeight:500}}>{fmt(rr.projected)}</span></div>
                    <div className="pace-bar-wrap" style={{marginTop:8}}>
                      <div className="pace-bar-label">
                        <span>Pace — day {rr.daysElapsed} of {rr.cycleLength}</span>
                        <span style={{color:rr.paceOver?'#D85A30':'var(--color-text-secondary)'}}>{Math.round(rr.paceRatio*100)}% of expected</span>
                      </div>
                      <div className="pace-bar-bg">
                        <div className="pace-bar-fill" style={{width:`${Math.min(100,pctCycleCharges)}%`,background:rr.paceOver?'#D85A30':'#1D9E75'}}></div>
                        <div className="pace-bar-marker" style={{left:`${pctElapsed}%`}}></div>
                      </div>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--color-text-secondary)',marginTop:3}}>
                        <span>This cycle: {fmt(rr.cycleCharges)}</span><span>Expected today: {fmt(rr.expectedNow)}</span>
                      </div>
                      {rr.paceOver && <div className="warn-note"><i className="ti ti-alert-triangle" style={{fontSize:12,flexShrink:0}} aria-hidden="true"></i> Spending {Math.round((rr.paceRatio-1)*100)}% faster than usual this cycle</div>}
                    </div>
                  </div>
                )}

                <CoverageBlock dueDate={due} amount={stmtBal} deposits={deposits} joint={joint} otherBillsBefore={billsDueBeforeDate(due, card.id)} />
                {openEdit===`card_${card.id}` && (
                  <div className="inline-edit open">
                    <div className="edit-section-label">Card details</div>
                    <div className="edit-row"><label>Card name</label><input type="text" value={editVals[`cn_${card.id}`]??''} onChange={ev(`cn_${card.id}`)} /></div>
                    <div className="edit-section-label">Dates</div>
                    <div className="edit-row"><label>Statement close day</label><input type="number" min="1" max="31" value={editVals[`cc_${card.id}`]??''} onChange={ev(`cc_${card.id}`)} /></div>
                    <div className="edit-row"><label>Due day of month</label><input type="number" min="1" max="31" value={editVals[`cd_${card.id}`]??''} onChange={ev(`cd_${card.id}`)} /></div>
                    <div className="edit-section-label">Balances</div>
                    <div className="edit-row"><label>Statement balance ($)</label><input type="number" min="0" step="0.01" value={editVals[`cs_${card.id}`]??''} onChange={ev(`cs_${card.id}`)} /></div>
                    <div className="edit-row"><label>Current balance ($)</label><input type="number" min="0" step="0.01" value={editVals[`cb_${card.id}`]??''} onChange={ev(`cb_${card.id}`)} /></div>
                    <div className="edit-section-label">Last 3 statement totals (for run-rate)</div>
                    <div className="edit-row"><label>1 month ago ($)</label><input type="number" min="0" step="0.01" value={editVals[`ch1_${card.id}`]??''} onChange={ev(`ch1_${card.id}`)} /></div>
                    <div className="edit-row"><label>2 months ago ($)</label><input type="number" min="0" step="0.01" value={editVals[`ch2_${card.id}`]??''} onChange={ev(`ch2_${card.id}`)} /></div>
                    <div className="edit-row"><label>3 months ago ($)</label><input type="number" min="0" step="0.01" value={editVals[`ch3_${card.id}`]??''} onChange={ev(`ch3_${card.id}`)} /></div>
                    <button className="save-btn" onClick={()=>saveCard(card)}>Save</button>
                  </div>
                )}
              </div>
            )
          })}

          {/* Fixed expenses */}
          <div className="section-label">Fixed expenses</div>
          {fixed.map(f => {
            const due = getFixedDueDate(f), days = daysUntil(due)
            const dueStr = due.toLocaleDateString('en-US',{month:'short',day:'numeric'})
            const dueLabel = f.due_type==='lastThursday'?'Last Thursday':f.due_type==='lastDay'?'Last day of month':`Day ${f.due_day}`
            const totalAmt = f.amount + (f.extra_payment||0)
            return (
              <div key={f.id} className="exp-card">
                <div className="exp-header">
                  <div><div className="exp-name"><i className={`ti ${f.icon}`} aria-hidden="true"></i>{f.name}</div>
                    <div className="exp-meta">{dueLabel} · {dueStr}</div></div>
                  <div style={{display:'flex',gap:6}}>
                    <CountdownPill days={days} />
                    <button className="edit-btn" onClick={()=>{ setEditVals(v=>({...v, [`fa_${f.id}`]:String(f.amount), [`fe_${f.id}`]:String(f.extra_payment||'')})); toggleEdit(`fixed_${f.id}`) }}><i className="ti ti-edit" aria-hidden="true"></i></button>
                  </div>
                </div>
                <div className="detail-row"><span className="detail-label">Amount</span><span className="detail-value">{fmt(f.amount)}</span></div>
                {f.name==='Mortgage' && <div className="detail-row"><span className="detail-label">Extra payment</span><span className="detail-value" style={{color:f.extra_payment>0?'#1D9E75':'var(--color-text-secondary)'}}>{f.extra_payment>0?fmt(f.extra_payment):'None'}</span></div>}
                {f.name==='Mortgage' && (
                  <div className="detail-row">
                    <span className="detail-label">Paid this month</span>
                    <button onClick={()=>togglePaidThisMonth(f)} style={{background:'none',border:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:13,fontWeight:500,color:f.paid_this_month?'#1D9E75':'var(--color-text-secondary)',padding:0}}>
                      <i className={`ti ${f.paid_this_month?'ti-circle-check':'ti-circle'}`} style={{fontSize:18}} aria-hidden="true"></i>
                      {f.paid_this_month ? 'Yes — showing next month' : 'No — mark as paid'}
                    </button>
                  </div>
                )}
                <CoverageBlock dueDate={due} amount={totalAmt} deposits={deposits} joint={joint} otherBillsBefore={billsDueBeforeDate(due)} />
                {openEdit===`fixed_${f.id}` && (
                  <div className="inline-edit open">
                    <div className="edit-row"><label>Amount ($)</label><input type="number" min="0" step="0.01" value={editVals[`fa_${f.id}`]??''} onChange={ev(`fa_${f.id}`)} /></div>
                    {f.name==='Mortgage' && <div className="edit-row"><label>Extra payment ($)</label><input type="number" min="0" step="1" value={editVals[`fe_${f.id}`]??''} placeholder="0" onChange={ev(`fe_${f.id}`)} /></div>}
                    <button className="save-btn" onClick={()=>saveFixed(f)}>Save</button>
                  </div>
                )}
              </div>
            )
          })}

          {/* Variable expenses */}
          <div className="section-label">Variable expenses</div>
          {variable.map(vx => {
            const est = seasonalEstimate(vx)
            const actual = vx.current_bill
            const diff = actual!=null && est!=null ? actual-est : null
            const flagged = diff!=null && Math.abs(diff)>50
            const due = nextOccurrence(vx.scheduled_day)
            const hardDue = new Date(due.getFullYear(), due.getMonth()+1, 0)
            const days = daysUntil(due)
            const dueStr = due.toLocaleDateString('en-US',{month:'short',day:'numeric'})
            const hardStr = hardDue.toLocaleDateString('en-US',{month:'short',day:'numeric'})
            const displayAmt = actual!=null ? actual : (est||0)
            return (
              <div key={vx.id} className="exp-card">
                <div className="exp-header">
                  <div><div className="exp-name"><i className={`ti ${vx.icon}`} aria-hidden="true"></i>{vx.name}</div>
                    <div className="exp-meta">Auto-pay {dueStr} · hard due {hardStr}</div></div>
                  <div style={{display:'flex',gap:6}}>
                    <CountdownPill days={days} />
                    <button className="edit-btn" onClick={()=>{ setEditVals(v=>({...v, [`vb_${vx.id}`]:String(vx.current_bill??''), [`vd_${vx.id}`]:String(vx.scheduled_day), [`vlm_${vx.id}`]:String(vx.history[(mo+11)%12]??''), [`vly_${vx.id}`]:String(vx.history[mo]??'')})); toggleEdit(`var_${vx.id}`) }}><i className="ti ti-edit" aria-hidden="true"></i></button>
                  </div>
                </div>
                <div className="detail-row"><span className="detail-label">Seasonal estimate</span><span className="detail-value">{est!=null?fmt(est):'No history'}</span></div>
                <div className="detail-row"><span className="detail-label">This month's bill</span><span className="detail-value">{actual!=null?fmt(actual):'Not entered'}</span></div>
                <div style={{margin:'8px 0 4px'}}>
                  {actual==null ? <span className="flag-pill flag-missing">Estimated — enter actual bill</span>
                    : flagged ? <span className={`flag-pill ${diff>0?'flag-high':'flag-low'}`}>{diff>0?'↑':'↓'} {fmt(Math.abs(diff))} {diff>0?'above':'below'} est.</span>
                    : <span className="flag-pill flag-ok">Within $50 of estimate</span>}
                </div>
                <CoverageBlock dueDate={due} amount={displayAmt} deposits={deposits} joint={joint} otherBillsBefore={billsDueBeforeDate(due)} />
                {openEdit===`var_${vx.id}` && (
                  <div className="inline-edit open">
                    <div className="edit-row"><label>Payment day of month</label><input type="number" min="1" max="31" value={editVals[`vd_${vx.id}`]??''} onChange={ev(`vd_${vx.id}`)} /></div>
                    <div className="edit-row"><label>This month's bill ($)</label><input type="number" min="0" step="0.01" value={editVals[`vb_${vx.id}`]??''} placeholder="Enter amount" onChange={ev(`vb_${vx.id}`)} /></div>
                    <div className="edit-row"><label>Last month ($)</label><input type="number" min="0" step="0.01" value={editVals[`vlm_${vx.id}`]??''} onChange={ev(`vlm_${vx.id}`)} /></div>
                    <div className="edit-row"><label>Same month last year ($)</label><input type="number" min="0" step="0.01" value={editVals[`vly_${vx.id}`]??''} onChange={ev(`vly_${vx.id}`)} /></div>
                    <button className="save-btn" onClick={()=>saveVariable(vx)}>Save</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── TO-DO ── */}
      {tab === 'todos' && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <span className="card-title">All tasks</span>
              <button className="add-btn" onClick={()=>toggleEdit('new_todo')}><i className="ti ti-plus" aria-hidden="true"></i> Add</button>
            </div>
            {openEdit==='new_todo' && (
              <div className="add-form open">
                <div className="form-row"><input type="text" placeholder="Task description" value={editVals.new_todo||''} onChange={ev('new_todo')} /></div>
                <div className="form-row">
                  <select value={editVals.new_who||''} onChange={ev('new_who')}>
                    <option value="">Anyone</option><option value="You">You</option><option value="Partner">Partner</option><option value="Both">Both</option>
                  </select>
                  <input type="text" placeholder="Due (e.g. Jun 3)" value={editVals.new_due||''} onChange={ev('new_due')} />
                </div>
                <button className="save-btn" onClick={addTodo}>Add task</button>
              </div>
            )}
            {(() => {
              const now = new Date()
              const activeTodos = todos.filter(t => {
                if (t.status !== 'done') return true
                if (!t.archived_at) return true
                // Keep in active if done less than 24h ago
                return (now - new Date(t.archived_at)) < 24 * 60 * 60 * 1000
              })
              const archivedTodos = todos.filter(t => {
                if (t.status !== 'done') return false
                if (!t.archived_at) return false
                return (now - new Date(t.archived_at)) >= 24 * 60 * 60 * 1000
              })

              // Group archived by week
              const archivedByWeek = archivedTodos.reduce((groups, t) => {
                const d = new Date(t.archived_at)
                const weekStart = new Date(d)
                weekStart.setDate(d.getDate() - d.getDay())
                weekStart.setHours(0,0,0,0)
                const key = weekStart.toISOString()
                const label = `Week of ${weekStart.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`
                if (!groups[key]) groups[key] = { label, items: [] }
                groups[key].items.push(t)
                return groups
              }, {})

              const statusOptions = [
                { value: 'todo', label: 'To do', cls: 'badge-todo' },
                { value: 'inprogress', label: 'In progress', cls: 'badge-inprogress' },
                { value: 'done', label: 'Done', cls: 'badge-done' },
                { value: 'blocked', label: 'Blocked', cls: 'badge-blocked' },
              ]

              return (
                <>
                  {activeTodos.length === 0 && <div className="empty-state">No active tasks</div>}
                  {activeTodos.map(t => (
                    <div key={t.id} className="todo-item">
                      <div style={{flex:1}}>
                        <div className={`todo-text ${t.status==='done'?'done-text':''}`}>{t.text}</div>
                        <div className="todo-meta">{[t.assigned_to, t.due_label].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
                        <select
                          value={t.status}
                          onChange={e=>setTodoStatus(t, e.target.value)}
                          style={{fontSize:11,padding:'3px 6px',borderRadius:'99px',fontWeight:500,cursor:'pointer',width:'auto',
                            background: t.status==='todo'?'#F1EFE8':t.status==='inprogress'?'#FAEEDA':t.status==='done'?'#EAF3DE':'#FCEBEB',
                            color: t.status==='todo'?'#5F5E5A':t.status==='inprogress'?'#854F0B':t.status==='done'?'#3B6D11':'#A32D2D',
                            border: 'none'}}
                        >
                          {statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <button onClick={()=>deleteTodo(t)} style={{background:'none',border:'none',cursor:'pointer',padding:2,color:'var(--color-text-secondary)',fontSize:14,opacity:0.4}}>
                          <i className="ti ti-x" aria-hidden="true"></i>
                        </button>
                      </div>
                    </div>
                  ))}

                  {Object.keys(archivedByWeek).length > 0 && (
                    <div style={{marginTop:16}}>
                      <div style={{fontSize:11,fontWeight:500,color:'var(--color-text-secondary)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:8}}>Archive</div>
                      {Object.entries(archivedByWeek).sort((a,b)=>b[0].localeCompare(a[0])).map(([key,week]) => (
                        <div key={key} style={{marginBottom:12}}>
                          <div style={{fontSize:12,fontWeight:500,color:'var(--color-text-secondary)',marginBottom:6}}>{week.label}</div>
                          {week.items.map(t => (
                            <div key={t.id} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 0',borderBottom:'0.5px solid var(--color-border-tertiary)',opacity:0.5}}>
                              <div style={{flex:1}}>
                                <div style={{fontSize:14,textDecoration:'line-through',color:'var(--color-text-secondary)'}}>{t.text}</div>
                                <div className="todo-meta">{[t.assigned_to, t.due_label].filter(Boolean).join(' · ')}</div>
                              </div>
                              <button onClick={()=>deleteTodo(t)} style={{background:'none',border:'none',cursor:'pointer',padding:2,color:'var(--color-text-secondary)',fontSize:14,opacity:0.4}}>
                                <i className="ti ti-x" aria-hidden="true"></i>
                              </button>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* ── SHOPPING LISTS ── */}
      {tab === 'shopping' && (
        <div className="section">
          <div className="store-tabs" style={{marginBottom:'1rem'}}>
            {[['grocery','ti-building-store','Grocery'],['costco','ti-box','Costco']].map(([l,icon,label]) => (
              <button key={l} className={`store-tab ${activeShoppingList===l?'active':''}`} onClick={()=>setActiveShoppingList(l)} style={{flex:1}}>
                <i className={`ti ${icon}`} aria-hidden="true"></i>{label}
              </button>
            ))}
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title" style={{marginBottom:0,textTransform:'capitalize'}}>{activeShoppingList} list</span>
              <div style={{display:'flex',gap:8}}>
                {shoppingList.some(i=>i.list===activeShoppingList&&i.checked) && (
                  <button className="edit-btn" onClick={clearChecked} style={{color:'#D85A30',borderColor:'#D85A30'}}>
                    <i className="ti ti-trash" aria-hidden="true"></i> Clear checked
                  </button>
                )}
              </div>
            </div>

            {/* Add item */}
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              <input
                type="text"
                placeholder={`Add to ${activeShoppingList} list…`}
                value={editVals.new_shop_item||''}
                onChange={ev('new_shop_item')}
                onKeyDown={e=>e.key==='Enter'&&addShoppingItem()}
                style={{flex:1}}
              />
              <button className="save-btn" onClick={addShoppingItem} style={{width:'auto',padding:'6px 14px'}}>Add</button>
            </div>

            {/* List items */}
            {shoppingList.filter(i=>i.list===activeShoppingList).length === 0
              ? <div className="empty-state">Nothing on your {activeShoppingList} list yet</div>
              : <>
                  {/* Unchecked items */}
                  {shoppingList.filter(i=>i.list===activeShoppingList&&!i.checked).map(item => (
                    <div key={item.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
                      <button onClick={()=>toggleShoppingItem(item)} style={{background:'none',border:'none',cursor:'pointer',padding:0,flexShrink:0,color:'var(--color-text-secondary)',fontSize:22}}>
                        <i className="ti ti-circle" aria-hidden="true"></i>
                      </button>
                      <span style={{flex:1,fontSize:14,color:'var(--color-text-primary)'}}>{item.item}</span>
                      <button onClick={()=>deleteShoppingItem(item)} style={{background:'none',border:'none',cursor:'pointer',padding:0,color:'var(--color-text-secondary)',fontSize:16,opacity:0.5}}>
                        <i className="ti ti-x" aria-hidden="true"></i>
                      </button>
                    </div>
                  ))}
                  {/* Checked items */}
                  {shoppingList.filter(i=>i.list===activeShoppingList&&i.checked).length > 0 && (
                    <div style={{marginTop:8}}>
                      <div style={{fontSize:11,fontWeight:500,color:'var(--color-text-secondary)',textTransform:'uppercase',letterSpacing:'0.5px',padding:'8px 0 4px'}}>In cart</div>
                      {shoppingList.filter(i=>i.list===activeShoppingList&&i.checked).map(item => (
                        <div key={item.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderBottom:'0.5px solid var(--color-border-tertiary)',opacity:0.5}}>
                          <button onClick={()=>toggleShoppingItem(item)} style={{background:'none',border:'none',cursor:'pointer',padding:0,flexShrink:0,color:'#1D9E75',fontSize:22}}>
                            <i className="ti ti-circle-check" aria-hidden="true"></i>
                          </button>
                          <span style={{flex:1,fontSize:14,color:'var(--color-text-secondary)',textDecoration:'line-through'}}>{item.item}</span>
                          <button onClick={()=>deleteShoppingItem(item)} style={{background:'none',border:'none',cursor:'pointer',padding:0,color:'var(--color-text-secondary)',fontSize:16,opacity:0.5}}>
                            <i className="ti ti-x" aria-hidden="true"></i>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
            }
          </div>
        </div>
      )}

      {/* ── CALENDAR ── */}
      {tab === 'calendar' && (
        <div className="section">

          {/* Google Calendar connection */}
          {!calConnected ? (
            <div className="card" style={{textAlign:'center',padding:'1.5rem'}}>
              <i className="ti ti-brand-google" style={{fontSize:32,color:'var(--color-text-secondary)',marginBottom:12,display:'block'}} aria-hidden="true"></i>
              <div style={{fontSize:15,fontWeight:500,color:'var(--color-text-primary)',marginBottom:6}}>Connect Google Calendar</div>
              <div style={{fontSize:13,color:'var(--color-text-secondary)',marginBottom:16,lineHeight:1.5}}>
                See your upcoming events here automatically. Both of you can connect your own calendar.
              </div>
              {calError && <div style={{fontSize:13,color:'#D85A30',background:'#FCEBEB',padding:'8px 12px',borderRadius:'var(--border-radius-md)',marginBottom:12}}>{calError}</div>}
              {calLoading
                ? <div style={{display:'flex',justifyContent:'center'}}><div className="spinner"></div></div>
                : <a href={getAuthUrl()} className="save-btn" style={{display:'inline-block',textDecoration:'none',padding:'10px 24px',width:'auto'}}>
                    Connect Google Calendar
                  </a>
              }
            </div>
          ) : (
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'1rem'}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:11,background:'#EAF3DE',color:'#3B6D11',borderRadius:99,padding:'2px 10px',fontWeight:500}}>
                    ✓ Google Calendar connected
                  </span>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button className="edit-btn" onClick={()=>loadCalEvents(JSON.parse(localStorage.getItem('gcal_tokens')||'{}').access_token)}>
                    <i className="ti ti-refresh" aria-hidden="true"></i> Refresh
                  </button>
                  <button className="edit-btn" onClick={disconnectCalendar} style={{color:'#D85A30'}}>
                    Disconnect
                  </button>
                </div>
              </div>

              {calLoading && <div style={{display:'flex',justifyContent:'center',padding:'2rem'}}><div className="spinner"></div></div>}

              {!calLoading && calEvents.length === 0 && (
                <div className="card"><div className="empty-state">No upcoming events in the next 30 days</div></div>
              )}

              {!calLoading && calEvents.length > 0 && (() => {
                // Group events by date
                const byDate = calEvents.reduce((groups, ev) => {
                  const dateKey = ev.start.split('T')[0]
                  if (!groups[dateKey]) groups[dateKey] = []
                  groups[dateKey].push(ev)
                  return groups
                }, {})

                return (
                  <div className="card">
                    <div className="card-title">Upcoming events</div>
                    {Object.entries(byDate).map(([dateKey, events]) => {
                      const d = new Date(dateKey + 'T00:00:00')
                      const isToday = dateKey === today.toISOString().split('T')[0]
                      const isTomorrow = dateKey === new Date(today.getTime() + 86400000).toISOString().split('T')[0]
                      return (
                        <div key={dateKey} className="cal-day">
                          <div className="cal-date">
                            <div className="cal-month">{d.toLocaleDateString('en-US',{month:'short'})}</div>
                            <div className="cal-num" style={{color: isToday?'#1D9E75':'var(--color-text-primary)'}}>{d.getDate()}</div>
                            {isToday && <div style={{fontSize:9,color:'#1D9E75',fontWeight:600}}>TODAY</div>}
                            {isTomorrow && <div style={{fontSize:9,color:'var(--color-text-secondary)',fontWeight:600}}>TMW</div>}
                          </div>
                          <div className="cal-events">
                            {events.map(ev => {
                              const timeStr = ev.allDay ? 'All day' : new Date(ev.start).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})
                              // Pick a color class based on calendar color
                              const colorMap = {'#4285f4':'ev-blue','#0b8043':'ev-teal','#8e24aa':'ev-purple','#e67c73':'ev-amber','#f6c026':'ev-amber'}
                              const cls = colorMap[ev.color] || 'ev-blue'
                              return (
                                <div key={ev.id} className={`cal-event ${cls}`} style={{borderLeft:`3px solid ${ev.color}`}}>
                                  <div className="cal-event-title">{ev.title}</div>
                                  <div className="cal-event-time">
                                    <i className="ti ti-clock" style={{fontSize:12,verticalAlign:-1}} aria-hidden="true"></i> {timeStr}
                                    {ev.calendar && <span style={{opacity:0.7}}> · {ev.calendar}</span>}
                                  </div>
                                  {ev.location && <div style={{fontSize:11,marginTop:2,opacity:0.8}}>📍 {ev.location}</div>}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}

              <p style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:'0.5rem',textAlign:'center'}}>
                Your husband can connect his calendar from his phone too — events from both will appear here.
              </p>
            </div>
          )}

          {/* Birthdays */}
          <div className="section-label" style={{marginTop:'1.5rem'}}>Birthdays</div>
          <div className="card">
            <div className="card-header">
              <span className="card-title" style={{marginBottom:0}}>Upcoming birthdays</span>
              <button className="add-btn" onClick={()=>toggleEdit('add_birthday')}>
                <i className="ti ti-plus" aria-hidden="true"></i> Add
              </button>
            </div>

            {openEdit==='add_birthday' && (
              <div className="add-form open">
                <div className="form-row">
                  <input type="text" placeholder="Name" value={editVals.bd_name||''} onChange={ev('bd_name')} />
                </div>
                <div className="form-row">
                  <select value={editVals.bd_month||''} onChange={ev('bd_month')} style={{flex:1}}>
                    <option value="">Month</option>
                    {['January','February','March','April','May','June','July','August','September','October','November','December'].map((m,i) => (
                      <option key={i+1} value={String(i+1).padStart(2,'0')}>{m}</option>
                    ))}
                  </select>
                  <select value={editVals.bd_day||''} onChange={ev('bd_day')} style={{flex:1}}>
                    <option value="">Day</option>
                    {Array.from({length:31},(_,i)=>i+1).map(d => (
                      <option key={d} value={String(d).padStart(2,'0')}>{d}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <input type="number" placeholder="Year (optional — for age)" value={editVals.bd_year||''} onChange={ev('bd_year')} min="1900" max="2025" />
                </div>
                <button className="save-btn" onClick={addBirthday}>Add birthday</button>
              </div>
            )}

            {(() => {
              if (!birthdays.length) return <div className="empty-state">No birthdays added yet</div>

              // Calculate next occurrence of each birthday and sort
              const withNext = birthdays.map(bd => {
                const birth = new Date(bd.birth_date + 'T00:00:00')
                const thisYear = new Date(today.getFullYear(), birth.getMonth(), birth.getDate())
                // Only push to next year if birthday has strictly passed (not today)
                const nextBday = thisYear < today
                  ? new Date(today.getFullYear()+1, birth.getMonth(), birth.getDate())
                  : thisYear
                const daysAway = daysUntil(nextBday)
                const turningAge = nextBday.getFullYear() - birth.getFullYear()
                const upcoming = daysAway <= 30
                return { ...bd, nextBday, daysAway, turningAge, upcoming, birth }
              }).sort((a,b) => a.daysAway - b.daysAway)

              return withNext.map((bd,i) => (
                <div key={bd.id} style={{
                  display:'flex',alignItems:'flex-start',gap:12,padding:'12px 0',
                  borderBottom: i<withNext.length-1?'0.5px solid var(--color-border-tertiary)':'none'
                }}>
                  {/* Date badge */}
                  <div style={{textAlign:'center',minWidth:40,flexShrink:0}}>
                    <div style={{fontSize:10,color:'var(--color-text-secondary)',textTransform:'uppercase',letterSpacing:'0.5px'}}>
                      {bd.nextBday.toLocaleDateString('en-US',{month:'short'})}
                    </div>
                    <div style={{fontSize:20,fontWeight:500,lineHeight:1.1,color:'var(--color-text-primary)'}}>
                      {bd.nextBday.getDate()}
                    </div>
                  </div>

                  {/* Info */}
                  <div style={{flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
                      <span style={{fontSize:14,fontWeight:500,color:'var(--color-text-primary)'}}>{bd.name}</span>
                      {bd.upcoming && (
                        <span style={{fontSize:11,background:'#EEEDFE',color:'#3C3489',borderRadius:99,padding:'1px 8px',fontWeight:500}}>
                          {bd.daysAway === 0 ? '🎂 Today!' : `In ${bd.daysAway}d`}
                        </span>
                      )}
                    </div>
                    <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:3}}>
                      Turning {bd.turningAge} · {bd.nextBday.toLocaleDateString('en-US',{month:'long',day:'numeric'})}
                    </div>
                      {/* Card sent toggle */}
                    <button
                      onClick={()=>toggleCardSent(bd)}
                      style={{marginTop:6,background:'none',border:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:5,fontSize:12,padding:0,
                        color: bd.card_sent?'#1D9E75':'var(--color-text-secondary)',fontFamily:'inherit'}}
                    >
                      <i className={`ti ${bd.card_sent?'ti-circle-check':'ti-circle'}`} style={{fontSize:15}} aria-hidden="true"></i>
                      {bd.card_sent ? 'Card sent ✓' : 'Mark card sent'}
                    </button>
                    {bd.upcoming && !bd.card_sent && (
                      <div style={{marginTop:4,fontSize:12,color:'var(--color-text-secondary)',display:'flex',alignItems:'center',gap:4}}>
                        <i className="ti ti-checkbox" style={{fontSize:12}} aria-hidden="true"></i>
                        Card reminder added to To-do automatically
                      </div>
                    )}
                  </div>

                  {/* Delete */}
                  <button onClick={()=>deleteBirthday(bd)} style={{background:'none',border:'none',cursor:'pointer',padding:2,color:'var(--color-text-secondary)',fontSize:14,opacity:0.4,flexShrink:0}}>
                    <i className="ti ti-x" aria-hidden="true"></i>
                  </button>
                </div>
              ))
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
