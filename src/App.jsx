import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import './App.css'

const today = new Date(); today.setHours(0,0,0,0)
const yr = today.getFullYear(), mo = today.getMonth(), todayDay = today.getDate()
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
  if (!hist.length) return { projected: card.balance, dailyRate: 0, expectedNow: 0, paceOver: false, remainingSpend: 0, avg: 0, daysElapsed: 0, daysToTarget: 0, cycleLength: 30, paceRatio: 1 }
  const avg = hist.reduce((s,v) => s+v, 0) / hist.length

  // Use real statement close day if set, otherwise assume 1st of month
  const closeDay = card.statement_close_day || 1

  // Find the most recent statement close date (the cycle start)
  let cycleStart = new Date(yr, mo, closeDay)
  if (cycleStart > today) cycleStart = new Date(yr, mo-1, closeDay)

  // Next statement close = one month after cycleStart
  const cycleEnd = new Date(cycleStart.getFullYear(), cycleStart.getMonth()+1, closeDay)
  const cycleLength = Math.round((cycleEnd - cycleStart) / 86400000)

  const daysElapsed = Math.max(1, Math.round((today - cycleStart) / 86400000))
  const dailyRate = avg / cycleLength
  const expectedNow = dailyRate * daysElapsed

  const dueDate = nextOccurrence(card.due_day)
  const daysToTarget = Math.max(0, daysUntil(dueDate))
  const remainingSpend = dailyRate * daysToTarget
  const projected = card.balance + remainingSpend
  const paceOver = expectedNow > 0 && card.balance > expectedNow * (1 + PACE_WARN)
  const paceRatio = expectedNow > 0 ? card.balance / expectedNow : 1
  return { projected, dailyRate, expectedNow, paceOver, paceRatio, remainingSpend, avg, daysElapsed, daysToTarget, cycleLength, cycleStart, cycleEnd }
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
  const [tab, setTab] = useState('finances')
  const [loading, setLoading] = useState(true)
  const [joint, setJoint] = useState(0)
  const [deposits, setDeposits] = useState([])
  const [cards, setCards] = useState([])
  const [fixed, setFixed] = useState([])
  const [variable, setVariable] = useState([])
  const [todos, setTodos] = useState([])
  const [store, setStore] = useState('grocery')
  const [customSpend, setCustomSpend] = useState('')
  const [openEdit, setOpenEdit] = useState(null)
  const [editVals, setEditVals] = useState({})

  // ── Load all data ─────────────────────────────────────────
  const loadAll = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    const [ja, dep, cc, fx, vx, td] = await Promise.all([
      supabase.from('joint_account').select('*').limit(1),
      supabase.from('deposits').select('*').order('deposit_number'),
      supabase.from('credit_cards').select('*').order('sort_order'),
      supabase.from('fixed_expenses').select('*').order('sort_order'),
      supabase.from('variable_expenses').select('*').order('sort_order'),
      supabase.from('todos').select('*').order('created_at'),
    ])
    if (ja.data && ja.data.length > 0) { setJoint(parseFloat(ja.data[0].balance)) }
    if (dep.data) setDeposits(dep.data.map(d => ({...d, amount: parseFloat(d.amount)})))
    if (cc.data) setCards(cc.data.map(c => ({...c, balance: parseFloat(c.balance), statement_balance: c.statement_balance != null ? parseFloat(c.statement_balance) : parseFloat(c.balance), statement_close_day: c.statement_close_day ? parseInt(c.statement_close_day) : null, history_1mo: c.history_1mo != null ? parseFloat(c.history_1mo) : null, history_2mo: c.history_2mo != null ? parseFloat(c.history_2mo) : null, history_3mo: c.history_3mo != null ? parseFloat(c.history_3mo) : null})))
    if (fx.data) setFixed(fx.data.map(f => ({...f, amount: parseFloat(f.amount), extra_payment: parseFloat(f.extra_payment||0), paid_this_month: f.paid_this_month || false})))
    if (vx.data) setVariable(vx.data.map(v => ({...v, current_bill: v.current_bill != null ? parseFloat(v.current_bill) : null, history: typeof v.history === 'string' ? JSON.parse(v.history) : v.history})))
    if (td.data) setTodos(td.data)
    setLoading(false)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // ── Realtime sync ─────────────────────────────────────────
  useEffect(() => {
    const channel = supabase.channel('db-changes')
      .on('postgres_changes', {event:'*', schema:'public'}, () => loadAll())
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [loadAll])

  // ── Computed values ───────────────────────────────────────
  const totalProjectedCards = cards.reduce((s,c) => s + (c.statement_balance ?? c.balance), 0)
  const totalRunRateCards = cards.reduce((s,c) => s + cardRunRate(c).projected, 0)
  const totalFixedAndVar = fixed.reduce((s,f) => s + f.amount + (f.extra_payment||0), 0) +
    variable.reduce((s,v) => { const e = seasonalEstimate(v); return s + (v.current_bill != null ? v.current_bill : (e||0)) }, 0)
  const totalAllBills = totalProjectedCards + totalFixedAndVar
  const totalRunRateBills = totalRunRateCards + totalFixedAndVar
  const totalAllDeposits = deposits.reduce((s,d) => s+d.amount, 0)
  const safeToSpendSimple = joint + totalAllDeposits - totalAllBills
  const leftover = safeToSpendSimple
  const leftoverRunRate = joint + totalAllDeposits - totalRunRateBills

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

  async function cycleTodoStatus(todo) {
    const order = ['todo','inprogress','done']
    const next = order[(order.indexOf(todo.status)+1)%3]
    await supabase.from('todos').update({ status: next, updated_at: new Date() }).eq('id', todo.id)
    await loadAll(false)
  }

  function ev(key) {
    return (e) => setEditVals(v => ({...v, [key]: e.target.value}))
  }

  function toggleEdit(key) {
    setOpenEdit(p => p === key ? null : key)
  }

  if (loading) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',flexDirection:'column',gap:12}}>
      <div className="spinner"></div>
      <p style={{color:'var(--color-text-secondary)',fontSize:14}}>Loading your dashboard…</p>
    </div>
  )

  const statusLabels = {todo:'To do',inprogress:'In progress',done:'Done'}
  const statusClass = {todo:'badge-todo',inprogress:'badge-inprogress',done:'badge-done'}

  return (
    <div className="app">
      {/* NAV */}
      <nav className="nav">
        {[['finances','ti-credit-card','Finances'],['todos','ti-checkbox','To-do'],['calendar','ti-calendar','Calendar']].map(([t,icon,label]) => (
          <button key={t} className={`nav-btn ${tab===t?'active':''}`} onClick={() => setTab(t)}>
            <i className={`ti ${icon}`} aria-hidden="true"></i>{label}
          </button>
        ))}
      </nav>

      {/* ── FINANCES ── */}
      {tab === 'finances' && (
        <div className="section">

          {/* Safe to spend */}
          <div className="spend-card">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div>
                <div className="spend-label">Safe to spend this month</div>
                <div className="spend-amount" style={{color:safeToSpendSimple>=200?'#1D9E75':safeToSpendSimple>=0?'#BA7517':'#D85A30'}}>
                  {safeToSpendSimple<0?'-':''}{fmt(safeToSpendSimple)}
                </div>
                <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:2}}>after all bills &amp; card statements this month</div>
              </div>
              <i className="ti ti-shopping-cart" style={{fontSize:28,color:'var(--color-text-secondary)',marginTop:4}} aria-hidden="true"></i>
            </div>

            <div className="store-tabs" style={{marginTop:14}}>
              {[['grocery','ti-building-store','Grocery'],['costco','ti-box','Costco'],['custom','ti-pencil','Custom']].map(([s,icon,label]) => (
                <button key={s} className={`store-tab ${store===s?'active':''}`} onClick={() => setStore(s)}>
                  <i className={`ti ${icon}`} aria-hidden="true"></i>{label}
                </button>
              ))}
            </div>
            {store === 'custom' && (
              <div style={{marginBottom:8,display:'flex',gap:8,alignItems:'center'}}>
                <label style={{fontSize:13,color:'var(--color-text-secondary)',whiteSpace:'nowrap'}}>Custom ($)</label>
                <input type="number" min="0" placeholder="e.g. 200" value={customSpend} onChange={e=>setCustomSpend(e.target.value)} style={{flex:1,fontSize:15,fontWeight:500}} />
              </div>
            )}
            {(plannedSpend > 0 || store !== 'custom') && (
              <div className={`coverage-row ${safeToSpendSimple - plannedSpend >= 0 ? 'cov-good' : 'cov-bad'}`} style={{marginBottom:10}}>
                {safeToSpendSimple - plannedSpend >= 0
                  ? `✓ Go for it — ${fmt(safeToSpendSimple - plannedSpend)} left after this trip`
                  : `✗ Over by ${fmt(Math.abs(safeToSpendSimple - plannedSpend))} — keep it under ${fmt(safeToSpendSimple)}`}
              </div>
            )}
            <div className="spend-breakdown">
              <div className="spend-line"><span>Joint account now</span><span className="val-pos">{fmt(joint)}</span></div>
              <div className="spend-line"><span>All deposits this month</span><span className="val-pos">+{fmt(deposits.reduce((s,d)=>s+d.amount,0))}</span></div>
              <div className="spend-line"><span>Card statement balances</span><span className="val-neg">-{fmt(totalProjectedCards)}</span></div>
              <div className="spend-line"><span>Fixed &amp; variable bills</span><span className="val-neg">-{fmt(totalFixedAndVar)}</span></div>
              <div className="spend-line total"><span>Safe to spend</span><span style={{color:safeToSpendSimple>=200?'#1D9E75':safeToSpendSimple>=0?'#BA7517':'#D85A30'}}>{safeToSpendSimple<0?'-':''}{fmt(safeToSpendSimple)}</span></div>
            </div>
          </div>

          {/* Banner */}
          <div className={`banner ${totalShortfall===0&&leftover>=0?'banner-good':totalShortfall>0?'banner-bad':'banner-warn'}`}>
            <i className={`ti ${totalShortfall===0&&leftover>=0?'ti-circle-check':totalShortfall>0?'ti-alert-circle':'ti-alert-triangle'}`} style={{fontSize:20,flexShrink:0,marginTop:1}} aria-hidden="true"></i>
            <span>
              {totalShortfall===0&&leftover>=0
                ? `All expenses covered.${leftover>=500?' '+fmt(leftover)+' left — extra mortgage payment possible.':''}`
                : totalShortfall>0
                ? `Some expenses may not be covered. Add ${fmt(totalShortfall)} to the joint account.`
                : `Tight month — ${fmt(leftover)} left after all bills.`}
            </span>
          </div>

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
              <div className="metric-sub" style={{color:leftoverRunRate>=0?'var(--color-text-secondary)':'#D85A30'}}>
                {leftoverRunRate<0?'-':''}{fmt(leftoverRunRate)} w/ run-rate
              </div>
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
            const pctElapsed = Math.min(100, Math.round((rr.daysElapsed/30)*100))
            const pctBalance = rr.avg>0 ? Math.min(130, Math.round((card.balance/rr.avg)*100)) : 0
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
                <div className="detail-row"><span className="detail-label">Statement balance (amount due)</span><span className="detail-value" style={{fontSize:15}}>{fmt(stmtBal)}</span></div>
                <div className="detail-row"><span className="detail-label">Current balance (incl. new charges)</span><span className="detail-value">{fmt(card.balance)}</span></div>
                <div className="detail-row"><span className="detail-label">Remaining projected spend ({rr.daysToTarget}d × {fmtR(rr.dailyRate)}/d)</span><span className="detail-value" style={{color:'#BA7517'}}>+{fmt(rr.remainingSpend)}</span></div>
                <div className="detail-row"><span className="detail-label">Projected balance at due date</span><span className="detail-value" style={{fontSize:15,fontWeight:500}}>{fmt(rr.projected)}</span></div>

                {rr.avg > 0 && (
                  <div className="pace-bar-wrap">
                    <div className="pace-bar-label">
                      <span>Pace — day {rr.daysElapsed} of {rr.cycleLength}</span>
                      <span style={{color:rr.paceOver?'#D85A30':'var(--color-text-secondary)'}}>{Math.round(rr.paceRatio*100)}% of expected</span>
                    </div>
                    <div className="pace-bar-bg">
                      <div className="pace-bar-fill" style={{width:`${Math.min(100,pctBalance)}%`,background:rr.paceOver?'#D85A30':'#1D9E75'}}></div>
                      <div className="pace-bar-marker" style={{left:`${pctElapsed}%`}}></div>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--color-text-secondary)',marginTop:3}}>
                      <span>Current: {fmt(card.balance)}</span><span>Expected today: {fmt(rr.expectedNow)}</span>
                    </div>
                    {rr.paceOver && <div className="warn-note"><i className="ti ti-alert-triangle" style={{fontSize:12,flexShrink:0}} aria-hidden="true"></i> Spending {Math.round((rr.paceRatio-1)*100)}% faster than usual</div>}
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
            {todos.length === 0 && <div className="empty-state">No tasks yet — add your first one above</div>}
            {todos.map(t => (
              <div key={t.id} className="todo-item">
                <span className={`status-badge ${statusClass[t.status]}`}>{statusLabels[t.status]}</span>
                <div style={{flex:1}}>
                  <div className={`todo-text ${t.status==='done'?'done-text':''}`}>{t.text}</div>
                  <div className="todo-meta">{[t.assigned_to, t.due_label].filter(Boolean).join(' · ')}</div>
                </div>
                <button className="status-cycle" onClick={()=>cycleTodoStatus(t)} aria-label="Cycle status"><i className="ti ti-refresh" aria-hidden="true"></i></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── CALENDAR ── */}
      {tab === 'calendar' && (
        <div className="section">
          <p style={{fontSize:13,color:'var(--color-text-secondary)',marginBottom:'1rem',lineHeight:1.5}}>
            Connect Google Calendar to see your real events here automatically.
          </p>
          <div className="card">
            <div className="card-title">Upcoming events</div>
            {[
              {mo:'Jun',d:2,events:[{title:'Dentist — Jamie',time:'10:00 AM',cls:'ev-blue'}]},
              {mo:'Jun',d:5,events:[{title:'Car insurance renewal',time:'All day',cls:'ev-purple'},{title:'Dinner with the Garcias',time:'7:00 PM',cls:'ev-teal'}]},
              {mo:'Jun',d:20,events:[{title:'Date night',time:'7:00 PM',cls:'ev-blue'}]},
            ].map(({mo:m,d,events}) => (
              <div key={d} className="cal-day">
                <div className="cal-date"><div className="cal-month">{m}</div><div className="cal-num">{d}</div></div>
                <div className="cal-events">
                  {events.map(ev => (
                    <div key={ev.title} className={`cal-event ${ev.cls}`}>
                      <div className="cal-event-title">{ev.title}</div>
                      <div className="cal-event-time"><i className="ti ti-clock" style={{fontSize:12,verticalAlign:-1}} aria-hidden="true"></i> {ev.time}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button className="add-btn" style={{width:'100%',justifyContent:'center',padding:10}}>
            <i className="ti ti-brand-google" aria-hidden="true"></i> Connect Google Calendar (Phase 3)
          </button>
        </div>
      )}
    </div>
  )
}
