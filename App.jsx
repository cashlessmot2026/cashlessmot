import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Html5Qrcode } from 'html5-qrcode'
import QRCode from 'qrcode'

/* =====================================================================
   CONFIGURACIÓN SUPABASE (anon key pública; las contraseñas viven en la BD)
   ===================================================================== */
const SUPABASE_URL = 'https://fgzxxzkeumpshegibzek.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnenh4emtldW1wc2hlZ2liemVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4MTMxNDMsImV4cCI6MjEwNjM4OTE0M30.yAHjORgL03vDgO3dxSoLanwO_E3FGmz9ToCsvan8sDM'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const BUCKET = 'motel'

/* =====================================================================
   UTILIDADES
   ===================================================================== */
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })
const money = v => COP.format(Number(v || 0))
const pad = n => String(n).padStart(2, '0')
const dur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` }
const mins = m => (m == null || isNaN(m) ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`)
const hhmm = d => (d ? new Date(d).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : '—')
const dt = d => (d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—')
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}` }
const today = () => dayKey(new Date())
const dayBounds = s => { const a = new Date(s + 'T00:00:00'); const b = new Date(a); b.setDate(b.getDate() + 1); return [a.toISOString(), b.toISOString()] }
const sum = (arr, f) => arr.reduce((s, x) => s + Number(f(x) || 0), 0)
const groupBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] ||= []).push(x); return m }, {})
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} } }

const STATUS = {
  disponible: { label: 'Disponible', color: '#22c55e' },
  ocupado: { label: 'Ocupado', color: '#ef4444' },
  limpieza: { label: 'Limpieza', color: '#f59e0b' },
  no_disponible: { label: 'No disponible', color: '#64748b' }
}
const VEHICLES = { placa: '🚗 Carro (placa)', moto: '🏍️ Moto', a_pie: '🚶 A pie' }
const METHODS = { efectivo: '💵 Efectivo', transferencia: '📲 Transferencia' }
const REASONS = ['daño', 'pérdida', 'vencida', 'auditoría', 'compra', 'corrección']
const PCATS = { bebida: 'Bebida', licor: 'Licor', snack: 'Snack', otro: 'Otro' }

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message)
  return data
}
async function q(promise) {
  const { data, error } = await promise
  if (error) throw new Error(error.message)
  return data
}

let pushToast = () => {}
const toast = (msg, type = 'ok') => pushToast(msg, type)
const fail = e => toast(e?.message || String(e), 'err')

function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now())
  useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i) }, [ms])
  return n
}

/* --- Cuentas --- */
const itemsTotal = items => sum(items, i => i.qty * i.unit_price)
function extraCharge(o, now = Date.now()) {
  if (!o?.start_at) return 0
  const end = o.end_at ? new Date(o.end_at).getTime() : now
  const over = (end - new Date(o.start_at).getTime()) / 3600000 - Number(o.hours_included || 0)
  return over > 0 ? Math.ceil(over) * Number(o.extra_hour_price || 0) : 0
}
function account(o, items, pays, now) {
  const it = itemsTotal(items), extra = extraCharge(o, now)
  const total = Number(o.room_price) + extra + it
  const paid = sum(pays, p => p.amount)
  return { it, extra, total, paid, balance: total - paid }
}

/* --- Imágenes --- */
async function compress(file, max = 1280) {
  try {
    const img = await createImageBitmap(file)
    const s = Math.min(1, max / Math.max(img.width, img.height))
    const c = document.createElement('canvas')
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s)
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.8))
  } catch { return file }
}
async function uploadImage(file, folder) {
  const blob = await compress(file)
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' })
  if (error) throw new Error(error.message)
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/* --- Carrito --- */
const cartList = cart => Object.entries(cart).filter(([, n]) => n > 0).map(([product_id, qty]) => ({ product_id, qty }))
const cartTotal = (cart, products) => sum(cartList(cart), i => i.qty * (products.find(p => p.id === i.product_id)?.price || 0))

const norm = s => String(s || '').trim().toUpperCase()
const pickCode = (room, cands) => { const keys = [room.qr_code, room.nfc_tag].filter(Boolean).map(norm); return cands.find(c => keys.includes(norm(c))) || cands[0] }
const codeMatches = (room, code) => [room.qr_code, room.nfc_tag].filter(Boolean).map(norm).includes(norm(code))

/* =====================================================================
   DATOS EN TIEMPO REAL
   ===================================================================== */
const EMPTY = { rooms: [], products: [], occ: [], items: [], payments: [], waitlist: [], cleanings: [], biz: [], messages: [], audits: [], settings: {}, version: 0, loaded: false }

function useLive(enabled) {
  const [d, setD] = useState(EMPTY)
  const load = useCallback(async () => {
    try {
      const [rooms, products, occ, waitlist, cleanings, biz, messages, audits, settings] = await Promise.all([
        q(supabase.from('rooms').select('*')),
        q(supabase.from('products').select('*').order('name')),
        q(supabase.from('occupancies').select('*').eq('status', 'activa')),
        q(supabase.from('waitlist').select('*').eq('status', 'esperando').order('created_at')),
        q(supabase.from('cleanings').select('*').eq('status', 'en_curso')),
        q(supabase.from('business_inventory').select('*').order('name')),
        q(supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(200)),
        q(supabase.from('audit_requests').select('*').order('created_at', { ascending: false }).limit(100)),
        q(supabase.from('settings').select('*'))
      ])
      const ids = occ.map(o => o.id)
      let items = [], payments = []
      if (ids.length) {
        ;[items, payments] = await Promise.all([
          q(supabase.from('occupancy_items').select('*').in('occupancy_id', ids).order('created_at')),
          q(supabase.from('payments').select('*').in('occupancy_id', ids).order('created_at'))
        ])
      }
      rooms.sort((a, b) => a.number.localeCompare(b.number, 'es', { numeric: true }))
      setD(p => ({ rooms, products, occ, items, payments, waitlist, cleanings, biz, messages, audits,
        settings: Object.fromEntries(settings.map(s => [s.key, s.value])), version: p.version + 1, loaded: true }))
    } catch (e) { fail(e) }
  }, [])

  useEffect(() => {
    if (!enabled) return
    load()
    let t
    const ch = supabase.channel('motel-live')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => { clearTimeout(t); t = setTimeout(load, 250) })
      .subscribe()
    const poll = setInterval(load, 30000)
    const vis = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', vis)
    return () => { supabase.removeChannel(ch); clearInterval(poll); clearTimeout(t); document.removeEventListener('visibilitychange', vis) }
  }, [enabled, load])
  return [d, load]
}

/* =====================================================================
   APP
   ===================================================================== */
export default function App() {
  const [user, setUser] = useState(() => store.get('motel_session', null))
  const login = u => { store.set('motel_session', u); setUser(u) }
  const logout = () => { store.set('motel_session', null); setUser(null) }
  return (
    <>
      <style>{CSS}</style>
      <Toasts />
      {user ? <Shell user={user} onLogout={logout} /> : <Login onLogin={login} />}
    </>
  )
}

function Toasts() {
  const [list, setList] = useState([])
  useEffect(() => {
    pushToast = (msg, type) => {
      const id = Math.random()
      setList(l => [...l, { id, msg, type }])
      setTimeout(() => setList(l => l.filter(t => t.id !== id)), type === 'err' ? 5000 : 3500)
    }
  }, [])
  return <div className="toasts">{list.map(t => <div key={t.id} className={'toast ' + t.type}>{t.msg}</div>)}</div>
}

/* ---------------- LOGIN ---------------- */
function Login({ onLogin }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async e => {
    e.preventDefault(); setBusy(true)
    try {
      const data = await rpc('login', { p_username: username, p_password: password })
      if (!data?.length) throw new Error('Usuario o contraseña incorrectos')
      onLogin(data[0]); toast(`Bienvenido, ${data[0].username}`)
    } catch (err) { fail(err) } finally { setBusy(false) }
  }
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="logo big">🏨</div>
        <h1>Motel Control</h1>
        <p className="muted">Ocupación por horas · Limpieza · Inventario</p>
        <div className="seg">
          {[['admin', '👤 Administrador'], ['superadmin', '👑 Super Admin']].map(([k, l]) =>
            <button type="button" key={k} className={username === k ? 'on' : ''} onClick={() => setUsername(k)}>{l}</button>)}
        </div>
        <label>Contraseña<input type="password" inputMode="numeric" autoFocus value={password} onChange={e => setPassword(e.target.value)} placeholder="••••" /></label>
        <button className="btn primary block" disabled={busy || !password}>{busy ? 'Verificando…' : 'Ingresar'}</button>
      </form>
    </div>
  )
}

/* ---------------- SHELL ---------------- */
const TABS_ADMIN = [['recepcion', '🛎️ Recepción'], ['habitaciones', '🛏️ Habitaciones'], ['inventario', '🍺 Inventario venta'], ['negocio', '🧴 Inventario negocio'], ['facturas', '🧾 Facturas'], ['chat', '💬 Chat']]
const TABS_SUPER = [['stats', '📊 Estadísticas'], ['historial', '📅 Historial'], ...TABS_ADMIN, ['pagos', '💳 Pagos'], ['limpiezas', '🧹 Limpiezas'], ['ajustes', '⚙️ Ajustes']]

function Shell({ user, onLogout }) {
  const isSuper = user.role === 'superadmin'
  const tabs = isSuper ? TABS_SUPER : TABS_ADMIN
  const [tab, setTab] = useState(() => store.get('motel_tab_' + user.role, tabs[0][0]))
  const [d, reload] = useLive(true)
  const seenKey = 'motel_seen_' + user.role
  const [seen, setSeen] = useState(() => store.get(seenKey, ''))
  useEffect(() => store.set('motel_tab_' + user.role, tab), [tab, user.role])
  useEffect(() => {
    if (tab === 'chat' && d.messages[0]) { setSeen(d.messages[0].created_at); store.set(seenKey, d.messages[0].created_at) }
  }, [tab, d.messages, seenKey])
  const unread = d.messages.filter(m => m.sender_role !== user.role && m.created_at > seen).length
  const pendingAudits = d.audits.filter(a => (isSuper ? a.status === 'respondida' : a.status === 'pendiente')).length
  const lowStock = d.products.filter(p => p.active && p.stock <= p.min_stock).length
  const counts = Object.fromEntries(Object.keys(STATUS).map(s => [s, d.rooms.filter(r => r.status === s).length]))

  const props = { d, user, reload, isSuper }
  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><span className="logo">🏨</span><div><b>Motel Control</b><div className="muted small">{isSuper ? '👑 Super Admin' : '👤 Administrador'}</div></div></div>
        <div className="chips hide-sm">
          {Object.entries(STATUS).map(([k, s]) => <span key={k} className="chip" style={{ '--c': s.color }}><i />{s.label}: <b>{counts[k]}</b></span>)}
        </div>
        <div className="row gap"><Clock /><button className="btn ghost sm" onClick={onLogout}>Salir</button></div>
      </header>
      <nav className="tabs">
        {tabs.map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
            {k === 'chat' && unread + pendingAudits > 0 && <span className="badge">{unread + pendingAudits}</span>}
            {k === 'inventario' && lowStock > 0 && <span className="badge warn">{lowStock}</span>}
          </button>
        ))}
      </nav>
      <main className="main">
        {!d.loaded ? <div className="loading">Cargando…</div> : <>
          {tab === 'recepcion' && <Reception {...props} />}
          {tab === 'habitaciones' && <RoomsTab {...props} />}
          {tab === 'inventario' && <ProductsTab {...props} />}
          {tab === 'negocio' && <BizTab {...props} />}
          {tab === 'facturas' && <InvoicesTab {...props} />}
          {tab === 'chat' && <ChatTab {...props} />}
          {tab === 'stats' && isSuper && <StatsTab {...props} />}
          {tab === 'historial' && isSuper && <HistoryTab {...props} />}
          {tab === 'pagos' && isSuper && <PaymentsTab {...props} />}
          {tab === 'limpiezas' && isSuper && <CleaningsTab {...props} />}
          {tab === 'ajustes' && isSuper && <SettingsTab {...props} />}
        </>}
      </main>
    </div>
  )
}

function Clock() {
  const now = useNow()
  return <span className="clock">{new Date(now).toLocaleTimeString('es-CO')}</span>
}

/* ---------------- UI BÁSICA ---------------- */
function Modal({ title, onClose, children, wide }) {
  useEffect(() => { const k = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={'modal' + (wide ? ' wide' : '')} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3><button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
const StatusBadge = ({ s }) => <span className="status" style={{ '--c': STATUS[s]?.color }}>{STATUS[s]?.label || s}</span>

function PhotoInput({ file, setFile, label = '📷 Tomar / adjuntar foto' }) {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => url && URL.revokeObjectURL(url), [url])
  return (
    <div className="photo-input">
      <label className="btn ghost">{label}
        <input type="file" accept="image/*" capture="environment" hidden onChange={e => setFile(e.target.files?.[0] || null)} />
      </label>
      {url && <img src={url} alt="foto" />}
    </div>
  )
}

function Bars({ data, fmt = v => v }) {
  const max = Math.max(1, ...data.map(x => x.value))
  if (!data.length) return <p className="muted">Sin datos</p>
  return (
    <div className="bars">
      {data.map(x => (
        <div key={x.label} className="bar-row">
          <span className="bar-label">{x.label}</span>
          <div className="bar"><div style={{ width: `${(x.value / max) * 100}%` }} /></div>
          <span className="bar-val">{fmt(x.value)}{x.extra ? <small className="muted"> · {x.extra}</small> : null}</span>
        </div>
      ))}
    </div>
  )
}
const Kpi = ({ label, value, sub }) => <div className="kpi"><span className="muted small">{label}</span><b>{value}</b>{sub && <span className="muted small">{sub}</span>}</div>

/* =====================================================================
   ESCÁNER QR / NFC
   ===================================================================== */
function Scanner({ title, onResult, onClose }) {
  const [err, setErr] = useState('')
  const [nfcMsg, setNfcMsg] = useState('')
  const [manual, setManual] = useState('')
  const done = useRef(false)
  const nfcCtrl = useRef(null)
  const finish = (cands, method) => { if (done.current) return; done.current = true; onResult(cands.filter(Boolean), method) }

  useEffect(() => {
    const qr = new Html5Qrcode('qr-reader')
    qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } }, text => finish([text], 'qr'), () => {})
      .catch(e => setErr('No se pudo abrir la cámara. ' + (e?.message || e)))
    return () => { nfcCtrl.current?.abort(); try { if (qr.isScanning) qr.stop().then(() => qr.clear()).catch(() => {}) } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const readNfc = async () => {
    if (!('NDEFReader' in window)) return setNfcMsg('NFC web no disponible en este dispositivo. Usa el QR o escribe el código.')
    try {
      const reader = new window.NDEFReader()
      const ctrl = new AbortController(); nfcCtrl.current = ctrl
      await reader.scan({ signal: ctrl.signal })
      setNfcMsg('📶 Acerca el tag NFC al teléfono…')
      reader.onreading = e => {
        const cands = [e.serialNumber]
        for (const rec of e.message.records) {
          if (rec.recordType === 'text') { try { cands.push(new TextDecoder(rec.encoding || 'utf-8').decode(rec.data)) } catch {} }
          if (rec.recordType === 'url') { try { cands.push(new TextDecoder().decode(rec.data)) } catch {} }
        }
        ctrl.abort(); finish(cands, 'nfc')
      }
    } catch (e) { setNfcMsg('Error NFC: ' + e.message) }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div id="qr-reader" className="qr-reader" />
      {err && <p className="err-text">{err}</p>}
      <div className="row gap wrap mt">
        <button className="btn" onClick={readNfc}>📶 Leer tag NFC</button>
        {nfcMsg && <span className="muted small">{nfcMsg}</span>}
      </div>
      <form className="row gap mt" onSubmit={e => { e.preventDefault(); manual.trim() && finish([manual.trim()], 'manual') }}>
        <input placeholder="o escribe el código (HAB-XXXX)" value={manual} onChange={e => setManual(e.target.value)} />
        <button className="btn">OK</button>
      </form>
    </Modal>
  )
}

/* =====================================================================
   BURBUJAS DE HABITACIONES
   ===================================================================== */
function RoomBubble({ r, d, selected, onClick }) {
  const now = useNow()
  const o = d.occ.find(x => x.room_id === r.id)
  const c = d.cleanings.find(x => x.room_id === r.id)
  const waits = d.waitlist.filter(w => w.room_id === r.id).length
  let timer = null, sub = null, alert = false
  if (r.status === 'ocupado' && o) {
    const st = new Date(o.start_at).getTime()
    if (now < st) timer = `⏳ inicia en ${dur(st - now).slice(3)}`
    else { timer = dur(now - st); alert = (now - st) / 3600000 > Number(o.hours_included) }
    const acc = account(o, d.items.filter(i => i.occupancy_id === o.id), d.payments.filter(p => p.occupancy_id === o.id), now)
    sub = acc.balance > 0 ? <span className="pend">Pendiente {money(acc.balance)}</span> : <span className="okt">Pagado ✓ cuenta abierta</span>
  }
  if (r.status === 'limpieza') timer = c ? `🧹 ${dur(now - new Date(c.started_at).getTime())}` : 'Esperando limpieza'
  if (r.status === 'no_disponible' && r.status_note) sub = <span className="muted">{r.status_note}</span>
  return (
    <button type="button" className={`bubble s-${r.status}${selected ? ' sel' : ''}${alert ? ' alert' : ''}`} style={{ '--c': STATUS[r.status].color }} onClick={() => onClick(r)}>
      <div className="b-top"><b className="b-num">{r.number}</b><span className="b-st">{STATUS[r.status].label}</span></div>
      {timer && <div className="b-timer">{timer}</div>}
      {o && <div className="b-meta">{VEHICLES[o.vehicle_type].split(' ')[0]} {o.plate || ''}</div>}
      {sub && <div className="b-sub">{sub}</div>}
      {waits > 0 && <div className="b-wait">🔔 {waits} en espera</div>}
    </button>
  )
}
const RoomGrid = ({ d, selected, onPick }) => (
  <div className="grid">
    {d.rooms.map(r => <RoomBubble key={r.id} r={r} d={d} selected={selected === r.id} onClick={onPick} />)}
    {!d.rooms.length && <p className="muted">No hay habitaciones. Agrégalas en la pestaña Habitaciones.</p>}
  </div>
)

/* =====================================================================
   RECEPCIÓN · REGISTRO DE INGRESO
   ===================================================================== */
function Reception({ d, user, reload }) {
  const [vehicle, setVehicle] = useState('placa')
  const [plate, setPlate] = useState('')
  const [roomId, setRoomId] = useState(null)
  const [cart, setCart] = useState({})
  const [mode, setMode] = useState('final')
  const [method, setMethod] = useState('efectivo')
  const [waitId, setWaitId] = useState(null)
  const [ask, setAsk] = useState(null)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const room = d.rooms.find(r => r.id === roomId)

  useEffect(() => { if (room && room.status !== 'disponible') setRoomId(null) }, [room])
  const prodTotal = cartTotal(cart, d.products)
  const total = (room ? Number(room.price) : 0) + prodTotal

  const reset = () => { setPlate(''); setRoomId(null); setCart({}); setMode('final'); setMethod('efectivo'); setWaitId(null) }
  const plateOk = () => { if (vehicle !== 'a_pie' && !plate.trim()) { toast('Ingresa la placa', 'err'); return false } return true }

  const submit = async e => {
    e.preventDefault()
    if (!room) return toast('Selecciona una habitación disponible', 'err')
    if (!plateOk()) return
    setBusy(true)
    try {
      await rpc('register_occupancy', {
        p_room_id: room.id, p_vehicle_type: vehicle, p_plate: vehicle === 'a_pie' ? null : plate,
        p_payment_mode: mode, p_payment_method: mode === 'inmediato' ? method : null,
        p_items: cartList(cart), p_user: user.username
      })
      if (waitId) await supabase.from('waitlist').update({ status: 'atendido', resolved_at: new Date().toISOString() }).eq('id', waitId)
      toast(`✅ Habitación ${room.number} registrada. El contador inicia en 2 minutos`)
      reset(); reload()
    } catch (err) { fail(err) } finally { setBusy(false) }
  }
  const pick = r => (r.status === 'disponible' ? setRoomId(r.id === roomId ? null : r.id) : setAsk(r))
  const addWait = async r => {
    if (!plateOk()) return
    try {
      await q(supabase.from('waitlist').insert({ room_id: r.id, vehicle_type: vehicle, plate: vehicle === 'a_pie' ? null : plate.trim().toUpperCase(), created_by: user.username }))
      toast(`🔔 Agregado a la lista de espera de la habitación ${r.number}`)
      setAsk(null); reset(); reload()
    } catch (err) { fail(err) }
  }
  const attend = w => {
    setVehicle(w.vehicle_type); setPlate(w.plate || ''); setWaitId(w.id)
    const r = d.rooms.find(x => x.id === w.room_id)
    if (r?.status === 'disponible') { setRoomId(r.id); toast(`Habitación ${r.number} seleccionada para ${w.plate || 'cliente a pie'}`) }
    else toast('La habitación aún no está disponible', 'err')
  }
  const cancelWait = async w => { await supabase.from('waitlist').update({ status: 'cancelado', resolved_at: new Date().toISOString() }).eq('id', w.id); reload() }

  return (
    <div className="recep">
      <form className="card form" onSubmit={submit}>
        <h2>Registro de ingreso {waitId && <span className="tag">desde lista de espera</span>}</h2>
        <div className="cols3">
          <label>Tipo de ingreso
            <select value={vehicle} onChange={e => setVehicle(e.target.value)}>
              {Object.entries(VEHICLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {vehicle !== 'a_pie'
            ? <label>Placa<input value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} placeholder={vehicle === 'moto' ? 'ABC12D' : 'ABC123'} maxLength={8} /></label>
            : <label>Placa<input disabled value="— Ingreso a pie —" /></label>}
          <label>Hora de inicio<StartTime /></label>
        </div>

        <h3 className="sec">1 · Selecciona la habitación <span className="muted small">(solo disponibles; las demás permiten lista de espera)</span></h3>
        <div className="frame"><RoomGrid d={d} selected={roomId} onPick={pick} /></div>

        {room && <>
          <h3 className="sec">2 · Productos <span className="muted small">(opcional; también se pueden agregar después)</span></h3>
          <ProductPicker products={d.products} cart={cart} setCart={setCart} />

          <h3 className="sec">3 · Pago</h3>
          <div className="seg">
            <button type="button" className={mode === 'inmediato' ? 'on' : ''} onClick={() => setMode('inmediato')}>⚡ Pago inmediato</button>
            <button type="button" className={mode === 'final' ? 'on' : ''} onClick={() => setMode('final')}>🕒 Pagar al final (cuenta pendiente)</button>
          </div>
          {mode === 'inmediato' && <div className="seg mt">
            {Object.entries(METHODS).map(([k, l]) => <button type="button" key={k} className={method === k ? 'on' : ''} onClick={() => setMethod(k)}>{l}</button>)}
          </div>}
          <p className="muted small">La cuenta queda abierta hasta liquidar la habitación (para consumos adicionales).</p>

          <div className="summary">
            <div><span>Habitación {room.number} ({room.hours_included} h)</span><b>{money(room.price)}</b></div>
            {prodTotal > 0 && <div><span>Productos</span><b>{money(prodTotal)}</b></div>}
            <div className="tot"><span>Total {mode === 'inmediato' ? 'a cobrar ahora' : 'pendiente'}</span><b>{money(total)}</b></div>
          </div>
        </>}
        <button className="btn primary block lg" disabled={busy || !room}>{busy ? 'Registrando…' : room ? `Registrar ingreso · Hab. ${room.number}` : 'Selecciona una habitación'}</button>
      </form>

      <aside className="card side">
        <h3>🔔 Lista de espera</h3>
        {!d.waitlist.length && <p className="muted">Nadie en espera</p>}
        {d.waitlist.map(w => {
          const r = d.rooms.find(x => x.id === w.room_id)
          return (
            <div key={w.id} className="wait-row">
              <div><b>Hab. {r?.number}</b> <StatusBadge s={r?.status} /><div className="muted small">{VEHICLES[w.vehicle_type]} {w.plate} · desde {hhmm(w.created_at)}</div></div>
              <div className="row gap">
                <button className="btn sm primary" disabled={r?.status !== 'disponible'} onClick={() => attend(w)}>Atender</button>
                <button className="btn sm ghost" onClick={() => cancelWait(w)}>✕</button>
              </div>
            </div>
          )
        })}
      </aside>

      {ask && (
        <Modal title={`Habitación ${ask.number}`} onClose={() => setAsk(null)}>
          <p>La habitación está <StatusBadge s={ask.status} />. ¿El cliente desea esperarla?</p>
          <div className="row gap wrap">
            <button className="btn primary" onClick={() => addWait(ask)}>🔔 Agregar a lista de espera ({vehicle === 'a_pie' ? 'a pie' : plate || 'sin placa'})</button>
            <button className="btn" onClick={() => { setOpen(ask); setAsk(null) }}>Gestionar habitación</button>
          </div>
        </Modal>
      )}
      {open && <RoomModal room={open} d={d} user={user} reload={reload} onClose={() => setOpen(null)} />}
    </div>
  )
}

function StartTime() {
  const now = useNow()
  return <div className="readonly">{new Date(now).toLocaleTimeString('es-CO')} <span className="muted small">· contador inicia {hhmm(now + 120000)}</span></div>
}

function ProductPicker({ products, cart, setCart }) {
  const set = (p, n) => setCart(c => ({ ...c, [p.id]: Math.max(0, Math.min(p.stock, n)) }))
  return (
    <div className="prod-grid">
      {products.filter(p => p.active).map(p => {
        const n = cart[p.id] || 0, out = p.stock <= 0
        return (
          <div key={p.id} className={'prod' + (n ? ' on' : '') + (out ? ' out' : '')}>
            <div className="prod-name">{p.name}</div>
            <div className="muted small">{money(p.price)} · {out ? 'Agotado' : `${p.stock} disp.`}</div>
            <div className="stepper">
              <button type="button" onClick={() => set(p, n - 1)} disabled={!n}>−</button>
              <span>{n}</span>
              <button type="button" onClick={() => set(p, n + 1)} disabled={out || n >= p.stock}>+</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* =====================================================================
   MODAL DE HABITACIÓN
   ===================================================================== */
function RoomModal({ room: r0, d, user, reload, onClose }) {
  const room = d.rooms.find(r => r.id === r0.id) || r0
  const o = d.occ.find(x => x.room_id === room.id)
  const waits = d.waitlist.filter(w => w.room_id === room.id)
  const cleaning = d.cleanings.find(c => c.room_id === room.id)
  const [note, setNote] = useState(room.status_note || '')
  const setStatus = async s => {
    try { await rpc('set_room_status', { p_room_id: room.id, p_status: s, p_note: note }); toast('Estado actualizado'); reload() } catch (e) { fail(e) }
  }
  const options = { disponible: ['no_disponible'], no_disponible: ['disponible', 'limpieza'], limpieza: cleaning ? [] : ['no_disponible'], ocupado: o ? [] : ['limpieza'] }[room.status] || []
  return (
    <Modal title={`Habitación ${room.number}`} onClose={onClose} wide>
      <div className="row gap wrap"><StatusBadge s={room.status} /><span className="muted">{room.type} · {money(room.price)} · {room.hours_included} h incluidas · hora extra {money(room.extra_hour_price)}</span></div>
      {room.status === 'ocupado' && o && <OccupancyPanel o={o} d={d} user={user} reload={reload} onClose={onClose} />}
      {room.status === 'limpieza' && <CleaningPanel room={room} cleaning={cleaning} user={user} reload={reload} onClose={onClose} />}
      {options.length > 0 && (
        <div className="card inner">
          <h4>Cambiar estado</h4>
          {options.includes('no_disponible') && <label>Motivo (daño / reparación)<input value={note} onChange={e => setNote(e.target.value)} placeholder="Ej: daño en aire acondicionado" /></label>}
          <div className="row gap wrap">
            {options.map(s => <button key={s} className="btn" style={{ borderColor: STATUS[s].color }} onClick={() => setStatus(s)}>→ {STATUS[s].label}</button>)}
          </div>
        </div>
      )}
      {waits.length > 0 && (
        <div className="card inner">
          <h4>🔔 En espera de esta habitación</h4>
          {waits.map(w => <div key={w.id} className="muted">{VEHICLES[w.vehicle_type]} {w.plate} · desde {hhmm(w.created_at)}</div>)}
        </div>
      )}
    </Modal>
  )
}

function OccupancyPanel({ o, d, user, reload, onClose }) {
  const now = useNow()
  const items = d.items.filter(i => i.occupancy_id === o.id)
  const pays = d.payments.filter(p => p.occupancy_id === o.id)
  const acc = account(o, items, pays, now)
  const [cart, setCart] = useState({})
  const [adding, setAdding] = useState(false)
  const [method, setMethod] = useState('efectivo')
  const [abono, setAbono] = useState('')
  const [confirmLiq, setConfirmLiq] = useState(false)
  const [busy, setBusy] = useState(false)
  const st = new Date(o.start_at).getTime()
  const run = async (fn, ok) => { setBusy(true); try { await fn(); ok && toast(ok); await reload() } catch (e) { fail(e) } finally { setBusy(false) } }

  const addItems = () => run(async () => { await rpc('add_items', { p_occupancy_id: o.id, p_items: cartList(cart), p_user: user.username }); setCart({}); setAdding(false) }, 'Productos agregados')
  const pay = () => run(async () => { await rpc('add_payment', { p_occupancy_id: o.id, p_amount: Number(abono || acc.balance), p_method: method, p_concept: 'Abono' }); setAbono('') }, 'Pago registrado')
  const liquidate = () => run(async () => {
    const total = await rpc('liquidate_occupancy', { p_occupancy_id: o.id, p_method: method, p_user: user.username })
    toast(`Habitación liquidada · Total ${money(total)} · pasa a limpieza`); onClose()
  })

  return (
    <div className="occ">
      <div className="occ-head">
        <div className="big-timer">{now < st ? <>⏳ inicia en {dur(st - now).slice(3)}</> : dur(now - st)}</div>
        <div className="muted small">
          {VEHICLES[o.vehicle_type]} {o.plate} · registro {hhmm(o.registered_at)} · inicio {hhmm(o.start_at)} · {o.payment_mode === 'inmediato' ? 'Pago inmediato' : 'Pago al final'}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Concepto</th><th>Hora</th><th>Cant.</th><th className="r">Valor</th></tr></thead>
          <tbody>
            <tr><td>Habitación ({o.hours_included} h)</td><td>{hhmm(o.start_at)}</td><td>1</td><td className="r">{money(o.room_price)}</td></tr>
            {acc.extra > 0 && <tr className="warn-row"><td>Horas extra</td><td>—</td><td>{acc.extra / Number(o.extra_hour_price || 1)}</td><td className="r">{money(acc.extra)}</td></tr>}
            {items.map(i => <tr key={i.id}><td>{i.product_name}</td><td>{hhmm(i.created_at)}</td><td>{i.qty}</td><td className="r">{money(i.qty * i.unit_price)}</td></tr>)}
          </tbody>
          <tfoot>
            <tr><td colSpan={3}>Total</td><td className="r">{money(acc.total)}</td></tr>
            <tr><td colSpan={3}>Pagado ({pays.map(p => METHODS[p.method].split(' ')[1]).join(', ') || '—'})</td><td className="r">{money(acc.paid)}</td></tr>
            <tr className={acc.balance > 0 ? 'pend-row' : ''}><td colSpan={3}><b>Saldo pendiente</b></td><td className="r"><b>{money(acc.balance)}</b></td></tr>
          </tfoot>
        </table>
      </div>

      {adding
        ? <div className="card inner"><ProductPicker products={d.products} cart={cart} setCart={setCart} />
          <div className="row gap mt"><button className="btn primary" disabled={busy || !cartList(cart).length} onClick={addItems}>Agregar {money(cartTotal(cart, d.products))}</button><button className="btn ghost" onClick={() => setAdding(false)}>Cancelar</button></div></div>
        : <button className="btn" onClick={() => setAdding(true)}>➕ Agregar productos</button>}

      <div className="card inner">
        <h4>Pagos</h4>
        <div className="seg">{Object.entries(METHODS).map(([k, l]) => <button key={k} type="button" className={method === k ? 'on' : ''} onClick={() => setMethod(k)}>{l}</button>)}</div>
        <div className="row gap mt wrap">
          <input type="number" min="0" placeholder={`Abono (saldo ${money(Math.max(0, acc.balance))})`} value={abono} onChange={e => setAbono(e.target.value)} />
          <button className="btn" disabled={busy || acc.balance <= 0} onClick={pay}>Registrar abono</button>
        </div>
        {!confirmLiq
          ? <button className="btn danger block mt" onClick={() => setConfirmLiq(true)}>🧾 Liquidar habitación</button>
          : <div className="confirm mt">
            <p>¿Liquidar? Se cobrará el saldo de <b>{money(Math.max(0, acc.balance))}</b> en <b>{METHODS[method]}</b>, se cerrará la cuenta y la habitación pasará a <b>limpieza</b>.</p>
            <div className="row gap"><button className="btn danger" disabled={busy} onClick={liquidate}>Sí, liquidar</button><button className="btn ghost" onClick={() => setConfirmLiq(false)}>No</button></div>
          </div>}
      </div>
    </div>
  )
}

function CleaningPanel({ room, cleaning, user, reload, onClose }) {
  const now = useNow()
  const [scan, setScan] = useState(false)
  const [photo, setPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const onScan = async (cands, method) => {
    setScan(false)
    const code = pickCode(room, cands)
    if (!codeMatches(room, code)) return toast(`El código no corresponde a la habitación ${room.number}`, 'err')
    setBusy(true)
    try {
      if (!cleaning) {
        await rpc('start_cleaning', { p_room_id: room.id, p_code: code, p_method: method, p_user: user.username })
        toast('🧹 Limpieza iniciada')
      } else {
        const url = await uploadImage(photo, 'limpiezas')
        await rpc('finish_cleaning', { p_cleaning_id: cleaning.id, p_code: code, p_photo_url: url, p_method: method })
        toast(`✨ Limpieza terminada · Habitación ${room.number} disponible`); onClose()
      }
      await reload()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  return (
    <div className="card inner clean">
      {!cleaning
        ? <>
          <h4>🧹 Pendiente de limpieza</h4>
          <p className="muted">Escanea el QR o tag NFC de la habitación para iniciar el contador de limpieza.</p>
          <button className="btn primary lg block" disabled={busy} onClick={() => setScan(true)}>📷 Escanear para iniciar</button>
        </>
        : <>
          <h4>🧹 Limpieza en curso</h4>
          <div className="big-timer">{dur(now - new Date(cleaning.started_at).getTime())}</div>
          <p className="muted small">Inició {hhmm(cleaning.started_at)} · Para terminar adjunta 1 foto y escanea de nuevo.</p>
          <PhotoInput file={photo} setFile={setPhoto} label="📷 Foto de la limpieza (obligatoria)" />
          <button className="btn primary lg block mt" disabled={busy || !photo} onClick={() => setScan(true)}>{busy ? 'Guardando…' : '✅ Escanear para terminar'}</button>
        </>}
      {scan && <Scanner title={`Escanear habitación ${room.number}`} onResult={onScan} onClose={() => setScan(false)} />}
    </div>
  )
}

/* =====================================================================
   HABITACIONES
   ===================================================================== */
function RoomsTab({ d, user, reload, isSuper }) {
  const [open, setOpen] = useState(null)
  const [edit, setEdit] = useState(null)
  const [qr, setQr] = useState(null)
  const [assign, setAssign] = useState(null)
  const [form, setForm] = useState({ number: '', type: 'Estándar', price: '', hours_included: '', extra_hour_price: '' })
  const add = async e => {
    e.preventDefault()
    if (!form.number.trim()) return toast('Número requerido', 'err')
    const row = { number: form.number.trim(), type: form.type.trim() || 'Estándar' }
    if (isSuper) for (const k of ['price', 'hours_included', 'extra_hour_price']) if (form[k] !== '') row[k] = Number(form[k])
    try { await q(supabase.from('rooms').insert(row)); toast(`Habitación ${row.number} agregada`); setForm(f => ({ ...f, number: '' })); reload() } catch (err) { fail(err) }
  }
  const onAssign = async (cands, method) => {
    const room = assign; setAssign(null)
    const patch = method === 'nfc' ? { nfc_tag: cands[0] } : { qr_code: cands[0] }
    try { await q(supabase.from('rooms').update(patch).eq('id', room.id)); toast(`${method === 'nfc' ? 'Tag NFC' : 'Código QR'} asignado a la habitación ${room.number}`); reload() } catch (e) { fail(e) }
  }
  return (
    <div className="stack">
      <div className="card">
        <h2>Tablero de habitaciones</h2>
        <RoomGrid d={d} onPick={setOpen} />
      </div>
      <form className="card form" onSubmit={add}>
        <h3>➕ Agregar habitación</h3>
        <div className="cols5">
          <label>Número<input value={form.number} onChange={e => setForm({ ...form, number: e.target.value })} placeholder="101" /></label>
          <label>Tipo<input value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} /></label>
          {isSuper && <>
            <label>Valor<input type="number" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} placeholder={`defecto ${money(d.settings.precio_habitacion)}`} /></label>
            <label>Horas incluidas<input type="number" step="0.5" value={form.hours_included} onChange={e => setForm({ ...form, hours_included: e.target.value })} placeholder={d.settings.horas_incluidas} /></label>
            <label>Hora extra<input type="number" value={form.extra_hour_price} onChange={e => setForm({ ...form, extra_hour_price: e.target.value })} placeholder={d.settings.valor_hora_extra} /></label>
          </>}
        </div>
        {!isSuper && <p className="muted small">El valor es fijo por defecto ({money(d.settings.precio_habitacion)}); solo el superadmin lo modifica.</p>}
        <button className="btn primary">Agregar</button>
      </form>
      <div className="card">
        <h3>Configuración</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Hab.</th><th>Tipo</th><th>Estado</th><th className="r">Valor</th><th>Horas</th><th className="r">Hora extra</th><th>QR / NFC</th><th></th></tr></thead>
          <tbody>{d.rooms.map(r => (
            <tr key={r.id}>
              <td><b>{r.number}</b></td><td>{r.type}</td><td><StatusBadge s={r.status} /></td>
              <td className="r">{money(r.price)}</td><td>{r.hours_included}</td><td className="r">{money(r.extra_hour_price)}</td>
              <td className="small">{r.qr_code}<br /><span className="muted">{r.nfc_tag ? 'NFC ' + r.nfc_tag : 'sin NFC'}</span></td>
              <td className="row gap nowrap">
                <button className="btn sm" onClick={() => setQr(r)}>QR</button>
                <button className="btn sm" onClick={() => setAssign(r)}>Asignar</button>
                {isSuper && <button className="btn sm" onClick={() => setEdit(r)}>Editar</button>}
              </td>
            </tr>))}
          </tbody>
        </table></div>
      </div>
      {open && <RoomModal room={open} d={d} user={user} reload={reload} onClose={() => setOpen(null)} />}
      {edit && <RoomEdit room={edit} reload={reload} onClose={() => setEdit(null)} />}
      {qr && <QrModal room={qr} onClose={() => setQr(null)} />}
      {assign && <Scanner title={`Asignar QR / NFC a la habitación ${assign.number}`} onResult={onAssign} onClose={() => setAssign(null)} />}
    </div>
  )
}

function RoomEdit({ room, reload, onClose }) {
  const [f, setF] = useState({ number: room.number, type: room.type, price: room.price, hours_included: room.hours_included, extra_hour_price: room.extra_hour_price, nfc_tag: room.nfc_tag || '' })
  const [del, setDel] = useState(false)
  const save = async () => {
    try {
      await q(supabase.from('rooms').update({ ...f, price: Number(f.price), hours_included: Number(f.hours_included), extra_hour_price: Number(f.extra_hour_price), nfc_tag: f.nfc_tag || null }).eq('id', room.id))
      toast('Habitación actualizada'); reload(); onClose()
    } catch (e) { fail(e) }
  }
  const remove = async () => { try { await q(supabase.from('rooms').delete().eq('id', room.id)); toast('Habitación eliminada'); reload(); onClose() } catch (e) { fail(e) } }
  return (
    <Modal title={`Editar habitación ${room.number}`} onClose={onClose}>
      <div className="form cols2">
        {[['number', 'Número'], ['type', 'Tipo'], ['price', 'Valor', 'number'], ['hours_included', 'Horas incluidas', 'number'], ['extra_hour_price', 'Valor hora extra', 'number'], ['nfc_tag', 'Tag NFC']].map(([k, l, t]) =>
          <label key={k}>{l}<input type={t || 'text'} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>)}
      </div>
      <div className="row gap mt">
        <button className="btn primary" onClick={save}>Guardar</button>
        {!del ? <button className="btn danger ghost" onClick={() => setDel(true)}>Eliminar</button> : <button className="btn danger" onClick={remove}>Confirmar eliminación</button>}
      </div>
    </Modal>
  )
}

function QrModal({ room, onClose }) {
  const [url, setUrl] = useState('')
  useEffect(() => { QRCode.toDataURL(room.qr_code, { width: 360, margin: 2 }).then(setUrl) }, [room.qr_code])
  return (
    <Modal title={`QR habitación ${room.number}`} onClose={onClose}>
      <div className="center">
        {url && <img src={url} alt="QR" className="qr-img" />}
        <p><b>{room.qr_code}</b></p>
        <p className="muted small">Imprime y pega este código dentro de la habitación. Se escanea para iniciar y terminar la limpieza.</p>
        {url && <a className="btn primary" href={url} download={`QR-hab-${room.number}.png`}>⬇️ Descargar</a>}
      </div>
    </Modal>
  )
}

/* =====================================================================
   INVENTARIO DE VENTA
   ===================================================================== */
const stockState = p => (p.stock <= 0 ? ['Agotado', 'bad'] : p.stock <= p.min_stock ? ['Por agotarse', 'warn'] : ['OK', 'ok'])

function ProductsTab({ d, user, reload, isSuper }) {
  const [edit, setEdit] = useState(null)
  const [adj, setAdj] = useState(null)
  const [f, setF] = useState({ name: '', category: 'bebida', price: '', stock: '', min_stock: '5' })
  const add = async e => {
    e.preventDefault()
    try {
      await q(supabase.from('products').insert({ name: f.name.trim(), category: f.category, price: Number(f.price || 0), stock: Number(f.stock || 0), min_stock: Number(f.min_stock || 0) }))
      toast('Producto agregado'); setF({ ...f, name: '', price: '', stock: '' }); reload()
    } catch (err) { fail(err) }
  }
  return (
    <div className="stack">
      <div className="card">
        <h2>🍺 Inventario de productos para venta <span className="live">● en vivo</span></h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Producto</th><th>Categoría</th><th className="r">Precio</th><th className="r">Stock</th><th className="r">Mínimo</th><th>Estado</th>{isSuper && <th></th>}</tr></thead>
          <tbody>{d.products.map(p => {
            const [l, c] = stockState(p)
            return (
              <tr key={p.id} className={p.active ? '' : 'dim'}>
                <td><b>{p.name}</b>{!p.active && <span className="muted small"> (inactivo)</span>}</td><td>{PCATS[p.category]}</td>
                <td className="r">{money(p.price)}</td><td className="r"><b>{p.stock}</b></td><td className="r">{p.min_stock}</td>
                <td><span className={'pill ' + c}>{l}</span></td>
                {isSuper && <td className="row gap nowrap"><button className="btn sm" onClick={() => setAdj(p)}>Ajustar stock</button><button className="btn sm ghost" onClick={() => setEdit(p)}>Editar</button></td>}
              </tr>
            )
          })}</tbody>
        </table></div>
        {!isSuper && <p className="muted small">Solo el superadmin puede modificar este inventario. Las ventas lo descuentan automáticamente.</p>}
      </div>
      {isSuper && (
        <form className="card form" onSubmit={add}>
          <h3>➕ Nuevo producto</h3>
          <div className="cols5">
            <label>Nombre<input required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
            <label>Categoría<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{Object.entries(PCATS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label>Precio<input type="number" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} /></label>
            <label>Stock inicial<input type="number" value={f.stock} onChange={e => setF({ ...f, stock: e.target.value })} /></label>
            <label>Stock mínimo<input type="number" value={f.min_stock} onChange={e => setF({ ...f, min_stock: e.target.value })} /></label>
          </div>
          <button className="btn primary">Agregar</button>
        </form>
      )}
      {edit && <ProductEdit p={edit} reload={reload} onClose={() => setEdit(null)} />}
      {adj && <AdjustModal kind="producto" item={adj} current={adj.stock} user={user} reload={reload} onClose={() => setAdj(null)} />}
    </div>
  )
}

function ProductEdit({ p, reload, onClose }) {
  const [f, setF] = useState({ name: p.name, category: p.category, price: p.price, min_stock: p.min_stock, active: p.active })
  const save = async () => {
    try { await q(supabase.from('products').update({ ...f, price: Number(f.price), min_stock: Number(f.min_stock) }).eq('id', p.id)); toast('Producto actualizado'); reload(); onClose() } catch (e) { fail(e) }
  }
  return (
    <Modal title={`Editar ${p.name}`} onClose={onClose}>
      <div className="form cols2">
        <label>Nombre<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
        <label>Categoría<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{Object.entries(PCATS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Precio de venta<input type="number" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} /></label>
        <label>Stock mínimo<input type="number" value={f.min_stock} onChange={e => setF({ ...f, min_stock: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Activo para la venta</label>
      </div>
      <p className="muted small">Para cambiar el stock usa “Ajustar stock” (queda registrado con motivo).</p>
      <button className="btn primary mt" onClick={save}>Guardar</button>
    </Modal>
  )
}

function AdjustModal({ kind, item, current, user, reload, onClose, defaultQty, defaultReason = 'corrección', auditId = null }) {
  const [qty, setQty] = useState(defaultQty ?? current)
  const [reason, setReason] = useState(defaultReason)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await rpc('adjust_inventory', { p_kind: kind, p_item_id: item.id || item.product_id, p_new_qty: Number(qty), p_reason: reason, p_notes: notes || null, p_audit_id: auditId, p_user: user.username })
      toast('Inventario ajustado'); reload(); onClose()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const delta = Number(qty) - Number(current)
  return (
    <Modal title={`Ajustar ${item.name}`} onClose={onClose}>
      <div className="form cols2">
        <label>Cantidad actual<input disabled value={current} /></label>
        <label>Nueva cantidad<input type="number" min="0" value={qty} onChange={e => setQty(e.target.value)} /></label>
        <label>Motivo<select value={reason} onChange={e => setReason(e.target.value)}>{REASONS.map(r => <option key={r}>{r}</option>)}</select></label>
        <label>Detalle<input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe el motivo del ajuste" /></label>
      </div>
      <p>Diferencia: <b className={delta < 0 ? 'bad-t' : 'ok-t'}>{delta > 0 ? '+' : ''}{delta}</b></p>
      <button className="btn primary" disabled={busy || qty === ''} onClick={save}>Guardar ajuste</button>
    </Modal>
  )
}

/* =====================================================================
   INVENTARIO DEL NEGOCIO (activos / aseo)
   ===================================================================== */
function BizTab({ d, user, reload, isSuper }) {
  const [f, setF] = useState({ name: '', category: 'aseo', quantity: '', unit: 'und', notes: '' })
  const [adj, setAdj] = useState(null)
  const [edit, setEdit] = useState(null)
  const [filter, setFilter] = useState('todos')
  const add = async e => {
    e.preventDefault()
    try { await q(supabase.from('business_inventory').insert({ ...f, name: f.name.trim(), quantity: Number(f.quantity || 0), created_by: user.username })); toast('Elemento agregado'); setF({ ...f, name: '', quantity: '', notes: '' }); reload() } catch (err) { fail(err) }
  }
  const list = d.biz.filter(b => filter === 'todos' || b.category === filter)
  return (
    <div className="stack">
      <form className="card form" onSubmit={add}>
        <h2>🧴 Inventario del negocio</h2>
        <div className="cols5">
          <label>Nombre<input required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Ej: Toallas, Jabón, TV" /></label>
          <label>Tipo<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="aseo">🧽 Elemento de aseo</option><option value="activo">🖥️ Activo</option></select></label>
          <label>Cantidad<input type="number" step="any" value={f.quantity} onChange={e => setF({ ...f, quantity: e.target.value })} /></label>
          <label>Unidad<input value={f.unit} onChange={e => setF({ ...f, unit: e.target.value })} /></label>
          <label>Notas<input value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
        </div>
        <button className="btn primary">Agregar</button>
      </form>
      <div className="card">
        <div className="seg">{[['todos', 'Todos'], ['aseo', 'Aseo'], ['activo', 'Activos']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <div className="table-wrap mt"><table>
          <thead><tr><th>Elemento</th><th>Tipo</th><th className="r">Cantidad</th><th>Notas</th><th>Agregado</th>{isSuper && <th></th>}</tr></thead>
          <tbody>{list.map(b => (
            <tr key={b.id}><td><b>{b.name}</b></td><td>{b.category === 'aseo' ? 'Aseo' : 'Activo'}</td><td className="r">{Number(b.quantity)} {b.unit}</td><td className="small">{b.notes}</td><td className="small muted">{dt(b.created_at)} · {b.created_by}</td>
              {isSuper && <td className="row gap nowrap"><button className="btn sm" onClick={() => setAdj(b)}>Ajustar</button><button className="btn sm ghost" onClick={() => setEdit(b)}>Editar</button></td>}</tr>))}
          </tbody>
        </table></div>
        {!isSuper && <p className="muted small">El administrador solo puede agregar elementos. Las modificaciones las hace el superadmin.</p>}
      </div>
      {adj && <AdjustModal kind="negocio" item={adj} current={Number(adj.quantity)} user={user} reload={reload} onClose={() => setAdj(null)} />}
      {edit && <BizEdit b={edit} reload={reload} onClose={() => setEdit(null)} />}
    </div>
  )
}

function BizEdit({ b, reload, onClose }) {
  const [f, setF] = useState({ name: b.name, category: b.category, unit: b.unit, notes: b.notes || '' })
  const [del, setDel] = useState(false)
  const save = async () => { try { await q(supabase.from('business_inventory').update({ ...f, updated_at: new Date().toISOString() }).eq('id', b.id)); toast('Actualizado'); reload(); onClose() } catch (e) { fail(e) } }
  const remove = async () => { try { await q(supabase.from('business_inventory').delete().eq('id', b.id)); toast('Eliminado'); reload(); onClose() } catch (e) { fail(e) } }
  return (
    <Modal title={`Editar ${b.name}`} onClose={onClose}>
      <div className="form cols2">
        <label>Nombre<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
        <label>Tipo<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="aseo">Aseo</option><option value="activo">Activo</option></select></label>
        <label>Unidad<input value={f.unit} onChange={e => setF({ ...f, unit: e.target.value })} /></label>
        <label>Notas<input value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
      </div>
      <div className="row gap mt"><button className="btn primary" onClick={save}>Guardar</button>
        {!del ? <button className="btn danger ghost" onClick={() => setDel(true)}>Eliminar</button> : <button className="btn danger" onClick={remove}>Confirmar</button>}</div>
    </Modal>
  )
}

/* =====================================================================
   FACTURAS
   ===================================================================== */
function InvoicesTab({ d, user, isSuper }) {
  const [list, setList] = useState([])
  const [photo, setPhoto] = useState(null)
  const [f, setF] = useState({ supplier: '', amount: '', invoice_date: today(), notes: '' })
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState(null)
  const load = useCallback(async () => { try { setList(await q(supabase.from('invoices').select('*').order('invoice_date', { ascending: false }).order('created_at', { ascending: false }).limit(300))) } catch (e) { fail(e) } }, [])
  useEffect(() => { load() }, [load, d.version])
  const add = async e => {
    e.preventDefault()
    if (!photo) return toast('Adjunta la imagen de la factura', 'err')
    setBusy(true)
    try {
      const url = await uploadImage(photo, 'facturas')
      await q(supabase.from('invoices').insert({ image_url: url, supplier: f.supplier || null, amount: f.amount ? Number(f.amount) : null, invoice_date: f.invoice_date, notes: f.notes || null, uploaded_by: user.username }))
      toast('Factura guardada'); setPhoto(null); setF({ ...f, supplier: '', amount: '', notes: '' }); load()
    } catch (err) { fail(err) } finally { setBusy(false) }
  }
  const remove = async inv => { try { await q(supabase.from('invoices').delete().eq('id', inv.id)); setView(null); load() } catch (e) { fail(e) } }
  const byMonth = sum(list.filter(i => i.invoice_date?.slice(0, 7) === today().slice(0, 7)), i => i.amount)
  return (
    <div className="stack">
      <form className="card form" onSubmit={add}>
        <h2>🧾 Facturas de compras</h2>
        <div className="cols4">
          <label>Proveedor<input value={f.supplier} onChange={e => setF({ ...f, supplier: e.target.value })} /></label>
          <label>Valor<input type="number" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
          <label>Fecha<input type="date" value={f.invoice_date} onChange={e => setF({ ...f, invoice_date: e.target.value })} /></label>
          <label>Notas<input value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
        </div>
        <PhotoInput file={photo} setFile={setPhoto} label="📷 Imagen de la factura" />
        <button className="btn primary mt" disabled={busy}>{busy ? 'Subiendo…' : 'Guardar factura'}</button>
      </form>
      <div className="card">
        <h3>Facturas · total del mes {money(byMonth)}</h3>
        <div className="gallery">
          {list.map(i => (
            <button key={i.id} className="g-item" onClick={() => setView(i)}>
              <img src={i.image_url} alt="factura" loading="lazy" />
              <span><b>{i.supplier || 'Sin proveedor'}</b><br />{i.invoice_date} · {i.amount ? money(i.amount) : '—'}</span>
            </button>
          ))}
          {!list.length && <p className="muted">Sin facturas</p>}
        </div>
      </div>
      {view && <Modal title={`Factura ${view.supplier || ''}`} onClose={() => setView(null)} wide>
        <img src={view.image_url} alt="factura" className="full-img" />
        <p>{view.invoice_date} · {money(view.amount)} · {view.notes} <span className="muted">(subida por {view.uploaded_by})</span></p>
        {isSuper && <button className="btn danger ghost" onClick={() => remove(view)}>Eliminar factura</button>}
      </Modal>}
    </div>
  )
}

/* =====================================================================
   CHAT INTERNO Y AUDITORÍAS
   ===================================================================== */
function ChatTab({ d, user, reload, isSuper }) {
  const msgs = useMemo(() => [...d.messages].reverse(), [d.messages])
  const [text, setText] = useState('')
  const [photo, setPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const [newAudit, setNewAudit] = useState(false)
  const [respond, setRespond] = useState(null)
  const [adj, setAdj] = useState(null)
  const end = useRef(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs.length])
  const send = async e => {
    e.preventDefault()
    if (!text.trim() && !photo) return
    setBusy(true)
    try {
      const url = photo ? await uploadImage(photo, 'chat') : null
      await q(supabase.from('messages').insert({ sender_role: user.role, sender_name: user.username, body: text.trim() || null, photo_url: url }))
      setText(''); setPhoto(null); reload()
    } catch (err) { fail(err) } finally { setBusy(false) }
  }
  const closeAudit = async a => { try { await q(supabase.from('audit_requests').update({ status: 'cerrada' }).eq('id', a.id)); toast('Auditoría cerrada'); reload() } catch (e) { fail(e) } }
  return (
    <div className="chat card">
      <div className="row between"><h2>💬 Chat interno</h2>{isSuper && <button className="btn primary" onClick={() => setNewAudit(true)}>📋 Nueva auditoría</button>}</div>
      <div className="msgs">
        {msgs.map(m => {
          const a = m.audit_id && d.audits.find(x => x.id === m.audit_id)
          return (
            <div key={m.id} className={'msg ' + (m.sender_role === user.role ? 'me' : 'them')}>
              <div className="msg-meta">{m.sender_role === 'superadmin' ? '👑' : '👤'} {m.sender_name} · {dt(m.created_at)}</div>
              {m.body && <div className="msg-body">{m.body}</div>}
              {m.photo_url && <a href={m.photo_url} target="_blank" rel="noreferrer"><img className="msg-img" src={m.photo_url} alt="foto" /></a>}
              {m.kind === 'auditoria' && a && <AuditCard a={a} d={d} isSuper={isSuper} onRespond={() => setRespond(a)} onAdjust={(r) => setAdj({ a, r })} onClose={() => closeAudit(a)} />}
            </div>
          )
        })}
        {!msgs.length && <p className="muted center">Sin mensajes</p>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={send}>
        <label className="btn ghost icon" title="Adjuntar foto">📷<input type="file" accept="image/*" hidden onChange={e => setPhoto(e.target.files?.[0] || null)} /></label>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={photo ? `📎 ${photo.name}` : 'Escribe un mensaje…'} />
        <button className="btn primary" disabled={busy}>Enviar</button>
      </form>
      {newAudit && <AuditRequestModal d={d} user={user} reload={reload} onClose={() => setNewAudit(false)} />}
      {respond && <AuditResponseModal a={respond} d={d} user={user} reload={reload} onClose={() => setRespond(null)} />}
      {adj && <AdjustModal kind="producto" item={{ id: adj.r.product_id, name: adj.r.name }} current={d.products.find(p => p.id === adj.r.product_id)?.stock ?? adj.r.system}
        defaultQty={adj.r.counted} defaultReason="auditoría" auditId={adj.a.id} user={user} reload={reload} onClose={() => setAdj(null)} />}
    </div>
  )
}

function AuditCard({ a, d, isSuper, onRespond, onAdjust, onClose }) {
  const st = { pendiente: 'warn', respondida: 'ok', cerrada: '' }[a.status]
  return (
    <div className="audit">
      <div className="row between"><b>📋 Auditoría</b><span className={'pill ' + st}>{a.status}</span></div>
      {a.note && <p className="small">{a.note}</p>}
      {!a.response
        ? <><ul className="small">{a.items.map(i => <li key={i.product_id}>{i.name}</li>)}</ul>
          {!isSuper && a.status === 'pendiente' && <button className="btn primary sm" onClick={onRespond}>Responder con foto y cantidades</button>}</>
        : <>
          <table className="small"><thead><tr><th>Producto</th><th className="r">Sistema</th><th className="r">Contado</th><th className="r">Dif.</th>{isSuper && a.status !== 'cerrada' && <th></th>}</tr></thead>
            <tbody>{a.response.map(r => {
              const diff = r.counted - r.system
              const now = d.products.find(p => p.id === r.product_id)?.stock
              return <tr key={r.product_id}><td>{r.name}</td><td className="r">{r.system}</td><td className="r">{r.counted}</td><td className={'r ' + (diff ? 'bad-t' : 'ok-t')}>{diff > 0 ? '+' : ''}{diff}</td>
                {isSuper && a.status !== 'cerrada' && <td>{now !== r.counted && <button className="btn sm" onClick={() => onAdjust(r)}>Ajustar</button>}</td>}</tr>
            })}</tbody></table>
          {a.response_photo_url && <a href={a.response_photo_url} target="_blank" rel="noreferrer"><img className="msg-img" src={a.response_photo_url} alt="auditoría" /></a>}
          {isSuper && a.status === 'respondida' && <button className="btn sm mt" onClick={onClose}>Cerrar auditoría</button>}
        </>}
    </div>
  )
}

function AuditRequestModal({ d, user, reload, onClose }) {
  const [sel, setSel] = useState({})
  const [note, setNote] = useState('')
  const items = d.products.filter(p => sel[p.id]).map(p => ({ product_id: p.id, name: p.name }))
  const send = async () => {
    try {
      const [a] = await q(supabase.from('audit_requests').insert({ items, note: note || null }).select())
      await q(supabase.from('messages').insert({ sender_role: user.role, sender_name: user.username, kind: 'auditoria', audit_id: a.id, body: `Solicitud de auditoría: enviar foto y cantidad de ${items.map(i => i.name).join(', ')}` }))
      toast('Solicitud enviada al administrador'); reload(); onClose()
    } catch (e) { fail(e) }
  }
  return (
    <Modal title="Nueva auditoría de productos" onClose={onClose}>
      <div className="row gap mb"><button className="btn sm" onClick={() => setSel(Object.fromEntries(d.products.map(p => [p.id, true])))}>Todos</button><button className="btn sm ghost" onClick={() => setSel({})}>Ninguno</button></div>
      <div className="checks">{d.products.map(p => <label key={p.id} className="check"><input type="checkbox" checked={!!sel[p.id]} onChange={e => setSel({ ...sel, [p.id]: e.target.checked })} /> {p.name} <span className="muted small">({p.stock})</span></label>)}</div>
      <label>Nota<input value={note} onChange={e => setNote(e.target.value)} placeholder="Instrucciones para el administrador" /></label>
      <button className="btn primary mt" disabled={!items.length} onClick={send}>Enviar solicitud ({items.length})</button>
    </Modal>
  )
}

function AuditResponseModal({ a, d, user, reload, onClose }) {
  const [counts, setCounts] = useState({})
  const [photo, setPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const ready = photo && a.items.every(i => counts[i.product_id] !== undefined && counts[i.product_id] !== '')
  const send = async () => {
    setBusy(true)
    try {
      const url = await uploadImage(photo, 'auditorias')
      const response = a.items.map(i => ({ product_id: i.product_id, name: i.name, counted: Number(counts[i.product_id]), system: d.products.find(p => p.id === i.product_id)?.stock ?? 0 }))
      await q(supabase.from('audit_requests').update({ response, response_photo_url: url, responded_at: new Date().toISOString(), status: 'respondida' }).eq('id', a.id))
      await q(supabase.from('messages').insert({ sender_role: user.role, sender_name: user.username, kind: 'respuesta', audit_id: a.id, photo_url: url, body: 'Respuesta de auditoría: ' + response.map(r => `${r.name}: ${r.counted}`).join(', ') }))
      toast('Respuesta enviada'); reload(); onClose()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  return (
    <Modal title="Responder auditoría" onClose={onClose}>
      {a.items.map(i => <label key={i.product_id} className="inline-label">{i.name}<input type="number" min="0" value={counts[i.product_id] ?? ''} onChange={e => setCounts({ ...counts, [i.product_id]: e.target.value })} placeholder="Cantidad contada" /></label>)}
      <PhotoInput file={photo} setFile={setPhoto} label="📷 Foto de los productos (obligatoria)" />
      <button className="btn primary mt" disabled={!ready || busy} onClick={send}>{busy ? 'Enviando…' : 'Enviar respuesta'}</button>
    </Modal>
  )
}

/* =====================================================================
   SUPERADMIN · ESTADÍSTICAS
   ===================================================================== */
async function fetchRange(table, col, from, to) {
  return q(supabase.from(table).select('*').gte(col, from).lt(col, to).order(col, { ascending: false }).limit(10000))
}
async function byOccIds(table, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 100) out.push(...await q(supabase.from(table).select('*').in('occupancy_id', ids.slice(i, i + 100)).order('created_at')))
  return out
}
const occMinutes = o => (o.end_at ? (new Date(o.end_at) - new Date(o.start_at)) / 60000 : null)

function StatsTab({ d }) {
  const [days, setDays] = useState(1)
  const [raw, setRaw] = useState(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const to = new Date(); to.setHours(24, 0, 0, 0)
        const from = new Date(to); from.setDate(from.getDate() - Math.max(days, 7))
        const sel = new Date(to); sel.setDate(sel.getDate() - days)
        const [F, T] = [from.toISOString(), to.toISOString()]
        const [occ, items, pays, cls] = await Promise.all([fetchRange('occupancies', 'registered_at', F, T), fetchRange('occupancy_items', 'created_at', F, T), fetchRange('payments', 'created_at', F, T), fetchRange('cleanings', 'started_at', F, T)])
        alive && setRaw({ occ, items, pays, cls, sel: sel.toISOString() })
      } catch (e) { fail(e) }
    })()
    return () => { alive = false }
  }, [days, d.version])

  const s = useMemo(() => {
    if (!raw) return null
    const inSel = (x, col) => x[col] >= raw.sel
    const occ = raw.occ.filter(o => inSel(o, 'registered_at') && o.status !== 'anulada')
    const items = raw.items.filter(i => inSel(i, 'created_at'))
    const pays = raw.pays.filter(p => inSel(p, 'created_at'))
    const cls = raw.cls.filter(c => inSel(c, 'started_at') && c.status === 'terminada')
    const done = occ.filter(o => o.end_at)
    const byRoom = Object.entries(groupBy(occ, o => o.room_number || '?')).map(([k, v]) => {
      const ms = v.map(occMinutes).filter(x => x != null)
      return { label: 'Hab. ' + k, value: v.length, extra: ms.length ? 'prom ' + mins(sum(ms, x => x) / ms.length) : '' }
    }).sort((a, b) => b.value - a.value)
    const byProd = Object.entries(groupBy(items, i => i.product_name)).map(([k, v]) => ({ label: k, value: sum(v, i => i.qty * i.unit_price), extra: sum(v, i => i.qty) + ' und' })).sort((a, b) => b.value - a.value)
    const byDay = Object.entries(groupBy(items, i => dayKey(i.created_at))).map(([k, v]) => ({ label: k, value: sum(v, i => i.qty * i.unit_price) })).sort((a, b) => b.label.localeCompare(a.label))
    const clByRoom = Object.entries(groupBy(cls, c => c.room_number || '?')).map(([k, v]) => ({ label: 'Hab. ' + k, value: sum(v, c => c.duration_seconds) / v.length / 60, extra: v.length + ' limpiezas' })).sort((a, b) => b.value - a.value)
    // Sugerencias de compra: ventas de los últimos 7 días
    const weekFrom = new Date(); weekFrom.setDate(weekFrom.getDate() - 7)
    const week = groupBy(raw.items.filter(i => new Date(i.created_at) >= weekFrom), i => i.product_id)
    const suggest = d.products.filter(p => p.active).map(p => {
      const sold7 = sum(week[p.id] || [], i => i.qty)
      const daily = sold7 / 7
      const daysLeft = daily ? p.stock / daily : Infinity
      const buy = Math.max(Math.ceil(daily * 7 + p.min_stock - p.stock), p.stock <= p.min_stock ? p.min_stock * 2 - p.stock : 0)
      return { p, sold7, daysLeft, buy }
    }).filter(x => x.buy > 0 && (x.p.stock <= x.p.min_stock || x.daysLeft < 4)).sort((a, b) => a.daysLeft - b.daysLeft)
    return {
      occ, done, income: sum(pays, p => p.amount), cash: sum(pays.filter(p => p.method === 'efectivo'), p => p.amount), transfer: sum(pays.filter(p => p.method === 'transferencia'), p => p.amount),
      prodSales: sum(items, i => i.qty * i.unit_price), avgUse: done.length ? sum(done, occMinutes) / done.length : null,
      avgClean: cls.length ? sum(cls, c => c.duration_seconds) / cls.length / 60 : null, cls, byRoom, byProd, byDay, clByRoom, suggest
    }
  }, [raw, d.products])

  const out = d.products.filter(p => p.active && p.stock <= 0)
  const low = d.products.filter(p => p.active && p.stock > 0 && p.stock <= p.min_stock)
  return (
    <div className="stack">
      <div className="row between wrap gap">
        <h2>📊 Estadísticas <span className="live">● en vivo</span></h2>
        <div className="seg">{[[1, 'Hoy'], [7, '7 días'], [30, '30 días'], [90, '90 días']].map(([k, l]) => <button key={k} className={days === k ? 'on' : ''} onClick={() => setDays(k)}>{l}</button>)}</div>
      </div>
      {!s ? <div className="loading">Calculando…</div> : <>
        <div className="kpis">
          <Kpi label="Ingresos" value={money(s.income)} sub={`💵 ${money(s.cash)} · 📲 ${money(s.transfer)}`} />
          <Kpi label="Ocupaciones" value={s.occ.length} sub={`${d.occ.length} activas ahora`} />
          <Kpi label="Venta de productos" value={money(s.prodSales)} />
          <Kpi label="Tiempo promedio de uso" value={mins(s.avgUse)} />
          <Kpi label="Tiempo promedio limpieza" value={mins(s.avgClean)} sub={`${s.cls.length} limpiezas`} />
          <Kpi label="Habitación más usada" value={s.byRoom[0]?.label || '—'} sub={s.byRoom[0] ? `${s.byRoom[0].value} usos` : ''} />
        </div>
        <div className="cols2 gap">
          <div className="card"><h3>🛏️ Uso por habitación</h3><Bars data={s.byRoom} fmt={v => v + ' usos'} /></div>
          <div className="card"><h3>🧹 Tiempo de limpieza por habitación</h3><Bars data={s.clByRoom} fmt={mins} /></div>
          <div className="card"><h3>🍺 Productos más vendidos</h3><Bars data={s.byProd} fmt={money} /></div>
          <div className="card"><h3>📅 Ventas de productos por día</h3><Bars data={s.byDay} fmt={money} /></div>
        </div>
      </>}
      <div className="cols2 gap">
        <div className="card">
          <h3>📦 Inventario en tiempo real</h3>
          {out.length > 0 && <p><span className="pill bad">Agotados</span> {out.map(p => p.name).join(', ')}</p>}
          {low.length > 0 && <p><span className="pill warn">Por agotarse</span> {low.map(p => `${p.name} (${p.stock})`).join(', ')}</p>}
          {!out.length && !low.length && <p className="ok-t">Todo el inventario está sobre el mínimo ✓</p>}
          <div className="stock-list">{d.products.filter(p => p.active).map(p => {
            const [, c] = stockState(p)
            return <div key={p.id} className="stock-row"><span>{p.name}</span><div className="bar"><div className={c} style={{ width: `${Math.min(100, (p.stock / Math.max(1, p.min_stock * 3)) * 100)}%` }} /></div><b>{p.stock}</b></div>
          })}</div>
        </div>
        <div className="card">
          <h3>🛒 Sugerencias de compra</h3>
          {!s?.suggest.length && <p className="muted">No hay compras sugeridas por ahora.</p>}
          {s?.suggest.map(x => (
            <div key={x.p.id} className="sug"><b>{x.p.name}</b><span className="muted small">stock {x.p.stock} · vendidos 7d: {x.sold7} · {isFinite(x.daysLeft) ? `alcanza ~${x.daysLeft.toFixed(1)} días` : 'sin ventas recientes'}</span><span className="pill warn">Comprar {x.buy}</span></div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* =====================================================================
   SUPERADMIN · HISTORIAL POR DÍAS
   ===================================================================== */
function HistoryTab({ d }) {
  const [day, setDay] = useState(today())
  const [data, setData] = useState(null)
  const [detail, setDetail] = useState(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [F, T] = dayBounds(day)
        const occ = await fetchRange('occupancies', 'registered_at', F, T)
        const ids = occ.map(o => o.id)
        const [items, pays, cls] = await Promise.all([byOccIds('occupancy_items', ids), byOccIds('payments', ids), fetchRange('cleanings', 'started_at', F, T)])
        alive && setData({ occ, items, pays, cls })
      } catch (e) { fail(e) }
    })()
    return () => { alive = false }
  }, [day, d.version])
  const shift = n => { const x = new Date(day + 'T12:00:00'); x.setDate(x.getDate() + n); setDay(dayKey(x)) }
  const prodSummary = data ? Object.entries(groupBy(data.items, i => i.product_name)).map(([k, v]) => ({ name: k, qty: sum(v, i => i.qty), total: sum(v, i => i.qty * i.unit_price) })).sort((a, b) => b.total - a.total) : []
  return (
    <div className="stack">
      <div className="card row between wrap gap">
        <h2>📅 Historial por día</h2>
        <div className="row gap"><button className="btn sm" onClick={() => shift(-1)}>◀</button><input type="date" value={day} onChange={e => setDay(e.target.value)} /><button className="btn sm" onClick={() => shift(1)}>▶</button></div>
      </div>
      {!data ? <div className="loading">Cargando…</div> : <>
        <div className="kpis">
          <Kpi label="Ocupaciones" value={data.occ.length} />
          <Kpi label="Cobrado" value={money(sum(data.pays, p => p.amount))} />
          <Kpi label="Productos vendidos" value={money(sum(data.items, i => i.qty * i.unit_price))} sub={sum(data.items, i => i.qty) + ' und'} />
          <Kpi label="Limpiezas" value={data.cls.length} sub={'prom ' + mins(sum(data.cls.filter(c => c.duration_seconds), c => c.duration_seconds) / Math.max(1, data.cls.filter(c => c.duration_seconds).length) / 60)} />
        </div>
        <div className="card">
          <h3>Ocupaciones <span className="muted small">(clic para ver el detalle)</span></h3>
          <div className="table-wrap"><table className="click">
            <thead><tr><th>Hab.</th><th>Ingreso</th><th>Inicio</th><th>Salida</th><th>Tiempo</th><th>Vehículo</th><th className="r">Productos</th><th className="r">Total</th><th>Estado</th></tr></thead>
            <tbody>{data.occ.map(o => {
              const it = data.items.filter(i => i.occupancy_id === o.id)
              return <tr key={o.id} onClick={() => setDetail(o)}><td><b>{o.room_number}</b></td><td>{hhmm(o.registered_at)}</td><td>{hhmm(o.start_at)}</td><td>{hhmm(o.end_at)}</td><td>{mins(occMinutes(o))}</td><td>{VEHICLES[o.vehicle_type]} {o.plate}</td><td className="r">{sum(it, i => i.qty)}</td><td className="r">{money(o.status === 'activa' ? account(o, it, [], Date.now()).total : o.total)}</td><td>{o.status}</td></tr>
            })}</tbody>
          </table></div>
          {!data.occ.length && <p className="muted">Sin ocupaciones este día</p>}
        </div>
        <div className="cols2 gap">
          <div className="card"><h3>Productos vendidos</h3>
            <table><tbody>{prodSummary.map(p => <tr key={p.name}><td>{p.name}</td><td className="r">{p.qty}</td><td className="r">{money(p.total)}</td></tr>)}</tbody></table>
            {!prodSummary.length && <p className="muted">Sin ventas</p>}</div>
          <div className="card"><h3>Limpiezas</h3>
            <table><tbody>{data.cls.map(c => <tr key={c.id}><td>Hab. {c.room_number}</td><td>{hhmm(c.started_at)}–{hhmm(c.ended_at)}</td><td>{c.duration_seconds ? mins(c.duration_seconds / 60) : 'en curso'}</td><td>{c.photo_url && <a href={c.photo_url} target="_blank" rel="noreferrer">📷</a>}</td></tr>)}</tbody></table>
            {!data.cls.length && <p className="muted">Sin limpiezas</p>}</div>
        </div>
      </>}
      {detail && <OccupancyDetail o={detail} items={data.items.filter(i => i.occupancy_id === detail.id)} pays={data.pays.filter(p => p.occupancy_id === detail.id)} onClose={() => setDetail(null)} />}
    </div>
  )
}

function OccupancyDetail({ o, items, pays, onClose }) {
  const [clean, setClean] = useState(null)
  const [wait, setWait] = useState([])
  useEffect(() => {
    if (o.end_at && o.room_id) supabase.from('cleanings').select('*').eq('room_id', o.room_id).gte('started_at', o.end_at).order('started_at').limit(1).then(r => setClean(r.data?.[0] || null))
  }, [o])
  useEffect(() => { o.room_id && supabase.from('waitlist').select('*').eq('room_id', o.room_id).gte('created_at', o.registered_at).lte('created_at', o.end_at || new Date().toISOString()).then(r => setWait(r.data || [])) }, [o])
  const acc = account(o, items, pays, Date.now())
  return (
    <Modal title={`Detalle · Habitación ${o.room_number}`} onClose={onClose} wide>
      <div className="kpis">
        <Kpi label="Ingreso / registro" value={hhmm(o.registered_at)} sub={dt(o.registered_at)} />
        <Kpi label="Inicio contador" value={hhmm(o.start_at)} />
        <Kpi label="Salida" value={hhmm(o.end_at)} />
        <Kpi label="Tiempo de uso" value={mins(occMinutes(o) ?? (Date.now() - new Date(o.start_at)) / 60000)} sub={`${o.hours_included} h incluidas`} />
      </div>
      <p>{VEHICLES[o.vehicle_type]} {o.plate} · {o.payment_mode === 'inmediato' ? 'Pago inmediato' : 'Pago al final'} · registró {o.created_by} · liquidó {o.closed_by || '—'}</p>
      <h4>Consumos</h4>
      <table><thead><tr><th>Hora</th><th>Producto</th><th className="r">Cant.</th><th className="r">Unit.</th><th className="r">Total</th></tr></thead>
        <tbody>
          <tr><td>{hhmm(o.start_at)}</td><td>Habitación</td><td className="r">1</td><td className="r">{money(o.room_price)}</td><td className="r">{money(o.room_price)}</td></tr>
          {acc.extra > 0 && <tr><td>—</td><td>Horas extra</td><td></td><td></td><td className="r">{money(acc.extra)}</td></tr>}
          {items.map(i => <tr key={i.id}><td>{hhmm(i.created_at)}</td><td>{i.product_name}</td><td className="r">{i.qty}</td><td className="r">{money(i.unit_price)}</td><td className="r">{money(i.qty * i.unit_price)}</td></tr>)}
        </tbody>
        <tfoot><tr><td colSpan={4}>Total</td><td className="r">{money(acc.total)}</td></tr></tfoot>
      </table>
      <h4>Pagos</h4>
      <table><tbody>{pays.map(p => <tr key={p.id}><td>{dt(p.created_at)}</td><td>{p.concept}</td><td>{METHODS[p.method]}</td><td className="r">{money(p.amount)}</td><td className="small muted">{p.edit_note ? '✏️ ' + p.edit_note : ''}</td></tr>)}</tbody></table>
      {!pays.length && <p className="muted">Sin pagos</p>}
      {clean && <><h4>Limpieza posterior</h4><p>{hhmm(clean.started_at)} – {hhmm(clean.ended_at)} · {clean.duration_seconds ? mins(clean.duration_seconds / 60) : 'en curso'} {clean.photo_url && <a href={clean.photo_url} target="_blank" rel="noreferrer">📷 ver foto</a>}</p></>}
      {wait.length > 0 && <p className="muted small">🔔 {wait.length} cliente(s) esperaron esta habitación durante el uso.</p>}
    </Modal>
  )
}

/* =====================================================================
   SUPERADMIN · PAGOS
   ===================================================================== */
function PaymentsTab({ d }) {
  const [day, setDay] = useState(today())
  const [list, setList] = useState([])
  const [occ, setOcc] = useState({})
  const [edit, setEdit] = useState(null)
  const load = useCallback(async () => {
    try {
      const [F, T] = dayBounds(day)
      const pays = await fetchRange('payments', 'created_at', F, T)
      const ids = [...new Set(pays.map(p => p.occupancy_id))]
      const o = ids.length ? await q(supabase.from('occupancies').select('id,room_number,plate,status').in('id', ids)) : []
      setList(pays); setOcc(Object.fromEntries(o.map(x => [x.id, x])))
    } catch (e) { fail(e) }
  }, [day])
  useEffect(() => { load() }, [load, d.version])
  return (
    <div className="stack">
      <div className="card row between wrap gap"><h2>💳 Pagos</h2><input type="date" value={day} onChange={e => setDay(e.target.value)} /></div>
      <div className="kpis">
        <Kpi label="Total" value={money(sum(list, p => p.amount))} sub={list.length + ' pagos'} />
        <Kpi label="Efectivo" value={money(sum(list.filter(p => p.method === 'efectivo'), p => p.amount))} />
        <Kpi label="Transferencia" value={money(sum(list.filter(p => p.method === 'transferencia'), p => p.amount))} />
      </div>
      <div className="card"><div className="table-wrap"><table>
        <thead><tr><th>Hora</th><th>Hab.</th><th>Placa</th><th>Concepto</th><th>Método</th><th className="r">Valor</th><th>Edición</th><th></th></tr></thead>
        <tbody>{list.map(p => <tr key={p.id}><td>{hhmm(p.created_at)}</td><td>{occ[p.occupancy_id]?.room_number}</td><td>{occ[p.occupancy_id]?.plate}</td><td>{p.concept}</td><td>{METHODS[p.method]}</td><td className="r">{money(p.amount)}</td><td className="small muted">{p.edited_at ? `${dt(p.edited_at)} · ${p.edit_note || ''}` : ''}</td><td><button className="btn sm" onClick={() => setEdit(p)}>Editar</button></td></tr>)}</tbody>
      </table></div>{!list.length && <p className="muted">Sin pagos este día</p>}</div>
      {edit && <PaymentEdit p={edit} onClose={() => setEdit(null)} reload={load} />}
    </div>
  )
}

function PaymentEdit({ p, onClose, reload }) {
  const [f, setF] = useState({ amount: p.amount, method: p.method, edit_note: '' })
  const save = async () => {
    if (!f.edit_note.trim()) return toast('Escribe el motivo de la edición', 'err')
    try { await q(supabase.from('payments').update({ amount: Number(f.amount), method: f.method, edit_note: f.edit_note, edited_at: new Date().toISOString() }).eq('id', p.id)); toast('Pago actualizado'); reload(); onClose() } catch (e) { fail(e) }
  }
  return (
    <Modal title="Editar pago" onClose={onClose}>
      <div className="form cols2">
        <label>Valor<input type="number" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
        <label>Método<select value={f.method} onChange={e => setF({ ...f, method: e.target.value })}>{Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </div>
      <label>Motivo de la edición<input value={f.edit_note} onChange={e => setF({ ...f, edit_note: e.target.value })} /></label>
      <button className="btn primary mt" onClick={save}>Guardar</button>
    </Modal>
  )
}

/* =====================================================================
   SUPERADMIN · HISTORIAL DE LIMPIEZAS
   ===================================================================== */
function CleaningsTab({ d }) {
  const [from, setFrom] = useState(() => { const x = new Date(); x.setDate(x.getDate() - 6); return dayKey(x) })
  const [to, setTo] = useState(today())
  const [list, setList] = useState([])
  const [view, setView] = useState(null)
  useEffect(() => {
    fetchRange('cleanings', 'started_at', dayBounds(from)[0], dayBounds(to)[1]).then(setList).catch(fail)
  }, [from, to, d.version])
  const done = list.filter(c => c.status === 'terminada')
  const byRoom = Object.entries(groupBy(done, c => c.room_number)).map(([k, v]) => ({ label: 'Hab. ' + k, value: sum(v, c => c.duration_seconds) / v.length / 60, extra: v.length + ' limpiezas' })).sort((a, b) => b.value - a.value)
  return (
    <div className="stack">
      <div className="card row between wrap gap"><h2>🧹 Historial de limpiezas</h2>
        <div className="row gap"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /><span>→</span><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div></div>
      <div className="kpis">
        <Kpi label="Limpiezas" value={done.length} sub={`${list.length - done.length} en curso`} />
        <Kpi label="Promedio" value={mins(done.length ? sum(done, c => c.duration_seconds) / done.length / 60 : null)} />
        <Kpi label="Más rápida" value={mins(done.length ? Math.min(...done.map(c => c.duration_seconds)) / 60 : null)} />
        <Kpi label="Más lenta" value={mins(done.length ? Math.max(...done.map(c => c.duration_seconds)) / 60 : null)} />
      </div>
      <div className="card"><h3>Promedio por habitación</h3><Bars data={byRoom} fmt={mins} /></div>
      <div className="card"><div className="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Hab.</th><th>Inicio</th><th>Fin</th><th>Duración</th><th>Método</th><th>Por</th><th>Foto</th></tr></thead>
        <tbody>{list.map(c => <tr key={c.id}><td>{new Date(c.started_at).toLocaleDateString('es-CO')}</td><td><b>{c.room_number}</b></td><td>{hhmm(c.started_at)}</td><td>{hhmm(c.ended_at)}</td><td>{c.duration_seconds ? mins(c.duration_seconds / 60) : 'en curso'}</td><td>{c.start_method}/{c.end_method || '—'}</td><td>{c.cleaned_by}</td>
          <td>{c.photo_url && <img className="thumb" src={c.photo_url} alt="" onClick={() => setView(c.photo_url)} />}</td></tr>)}</tbody>
      </table></div></div>
      {view && <Modal title="Foto de limpieza" onClose={() => setView(null)} wide><img src={view} alt="" className="full-img" /></Modal>}
    </div>
  )
}

/* =====================================================================
   SUPERADMIN · AJUSTES
   ===================================================================== */
function SettingsTab({ d, reload }) {
  const [s, setS] = useState(d.settings)
  const [pw, setPw] = useState({ super: '', target: 'admin', next: '' })
  const [log, setLog] = useState([])
  useEffect(() => { q(supabase.from('inventory_adjustments').select('*').order('created_at', { ascending: false }).limit(300)).then(setLog).catch(fail) }, [d.version])
  const saveSettings = async () => {
    try { await q(supabase.from('settings').upsert(['precio_habitacion', 'horas_incluidas', 'valor_hora_extra'].map(key => ({ key, value: String(s[key] ?? '') })))); toast('Valores por defecto guardados'); reload() } catch (e) { fail(e) }
  }
  const changePw = async e => {
    e.preventDefault()
    try { await rpc('change_password', { p_super_password: pw.super, p_target: pw.target, p_new_password: pw.next }); toast(`Contraseña de ${pw.target} actualizada`); setPw({ ...pw, super: '', next: '' }) } catch (err) { fail(err) }
  }
  return (
    <div className="stack">
      <div className="cols2 gap">
        <div className="card form">
          <h3>💲 Valores por defecto de habitaciones</h3>
          <label>Valor habitación<input type="number" value={s.precio_habitacion || ''} onChange={e => setS({ ...s, precio_habitacion: e.target.value })} /></label>
          <label>Horas incluidas<input type="number" step="0.5" value={s.horas_incluidas || ''} onChange={e => setS({ ...s, horas_incluidas: e.target.value })} /></label>
          <label>Valor hora extra<input type="number" value={s.valor_hora_extra || ''} onChange={e => setS({ ...s, valor_hora_extra: e.target.value })} /></label>
          <p className="muted small">Se aplican a las habitaciones nuevas. Cada habitación se puede editar en la pestaña Habitaciones.</p>
          <button className="btn primary" onClick={saveSettings}>Guardar</button>
        </div>
        <form className="card form" onSubmit={changePw}>
          <h3>🔑 Cambiar contraseñas</h3>
          <label>Usuario<select value={pw.target} onChange={e => setPw({ ...pw, target: e.target.value })}><option value="admin">admin</option><option value="superadmin">superadmin</option></select></label>
          <label>Nueva contraseña<input type="password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} /></label>
          <label>Tu contraseña de superadmin<input type="password" value={pw.super} onChange={e => setPw({ ...pw, super: e.target.value })} /></label>
          <button className="btn primary" disabled={!pw.super || !pw.next}>Cambiar</button>
        </form>
      </div>
      <div className="card">
        <h3>📝 Registro de ajustes de inventario</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Elemento</th><th className="r">Antes</th><th className="r">Después</th><th className="r">Dif.</th><th>Motivo</th><th>Detalle</th></tr></thead>
          <tbody>{log.map(a => <tr key={a.id}><td>{dt(a.created_at)}</td><td>{a.item_kind}</td><td>{a.item_name}</td><td className="r">{Number(a.previous_qty)}</td><td className="r">{Number(a.new_qty)}</td><td className={'r ' + (a.delta < 0 ? 'bad-t' : 'ok-t')}>{Number(a.delta)}</td><td><span className="pill">{a.reason}</span></td><td className="small">{a.notes}</td></tr>)}</tbody>
        </table></div>
        {!log.length && <p className="muted">Sin ajustes</p>}
      </div>
    </div>
  )
}

/* =====================================================================
   ESTILOS
   ===================================================================== */
const CSS = `
:root{--bg:#0b1020;--panel:#121a2f;--panel2:#18223d;--line:#26324f;--text:#e8edf8;--muted:#8d99b8;--brand:#7c5cff;--brand2:#22d3ee;--ok:#22c55e;--bad:#ef4444;--warn:#f59e0b;--r:14px}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;-webkit-tap-highlight-color:transparent}
body{background:radial-gradient(1000px 500px at 0% -10%,#251a5a55,transparent 60%),radial-gradient(800px 500px at 100% 0%,#0e4a5a44,transparent 60%),var(--bg);min-height:100vh}
h1,h2,h3,h4{margin:0 0 12px} h2{font-size:1.25rem} h3{font-size:1.05rem} h4{font-size:.95rem}
p{margin:6px 0}
input,select{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;font:inherit;outline:none;transition:border .15s}
input:focus,select:focus{border-color:var(--brand)}
input:disabled{opacity:.6}
label{display:flex;flex-direction:column;gap:6px;font-size:.85rem;color:var(--muted)}
label.check{flex-direction:row;align-items:center;gap:8px;color:var(--text)} label.check input{width:auto}
.inline-label{flex-direction:row;align-items:center;justify-content:space-between;gap:12px;color:var(--text);margin:6px 0} .inline-label input{max-width:160px}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
tfoot td{font-weight:600}
.r{text-align:right}.center{text-align:center}.small{font-size:.8rem}.muted{color:var(--muted)}.nowrap{white-space:nowrap}
.table-wrap{overflow-x:auto}
table.click tbody tr{cursor:pointer} table.click tbody tr:hover{background:var(--panel2)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;transition:transform .08s,background .15s,opacity .15s;text-decoration:none}
.btn:hover{background:#202c4d}.btn:active{transform:scale(.97)}.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.primary{background:linear-gradient(135deg,var(--brand),#5b8cff);border-color:transparent;color:#fff}
.btn.danger{background:var(--bad);border-color:transparent;color:#fff}
.btn.danger.ghost{background:transparent;color:var(--bad);border-color:var(--bad)}
.btn.ghost{background:transparent}
.btn.sm{padding:6px 10px;font-size:.82rem;border-radius:8px}
.btn.lg{padding:14px 18px;font-size:1.02rem}
.btn.block{width:100%}.btn.icon{padding:10px 12px}
.row{display:flex;align-items:center}.gap{gap:10px}.wrap{flex-wrap:wrap}.between{justify-content:space-between}
.mt{margin-top:12px}.mb{margin-bottom:12px}
.stack{display:flex;flex-direction:column;gap:16px}
.card{background:linear-gradient(180deg,#141d35,#111830);border:1px solid var(--line);border-radius:var(--r);padding:18px;box-shadow:0 10px 30px #0004}
.card.inner{background:var(--panel2);box-shadow:none;margin-top:14px;padding:14px}
.form{display:flex;flex-direction:column;gap:12px}
.cols2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.cols3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.cols4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.cols5{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.cols2.gap{gap:16px}
.seg{display:flex;flex-wrap:wrap;gap:6px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:4px}
.seg button{flex:1;min-width:max-content;background:transparent;border:0;color:var(--muted);padding:9px 12px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer}
.seg button.on{background:var(--brand);color:#fff}
.login-wrap{min-height:100vh;display:grid;place-items:center;padding:20px}
.login{width:min(400px,100%);display:flex;flex-direction:column;gap:14px;text-align:center}
.logo{font-size:1.6rem}.logo.big{font-size:3rem}
.shell{min-height:100vh;display:flex;flex-direction:column}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;padding-top:max(10px,env(safe-area-inset-top));background:#0b1020e6;backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;background:var(--panel2);border:1px solid var(--line);padding:5px 10px;border-radius:99px}
.chip i{width:8px;height:8px;border-radius:50%;background:var(--c)}
.clock{font-variant-numeric:tabular-nums;font-weight:700;color:var(--brand2)}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:10px 18px;border-bottom:1px solid var(--line);scrollbar-width:none;position:sticky;top:57px;z-index:19;background:#0b1020e6;backdrop-filter:blur(12px)}
.tabs::-webkit-scrollbar{display:none}
.tabs button{position:relative;white-space:nowrap;background:transparent;border:1px solid transparent;color:var(--muted);padding:8px 14px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer}
.tabs button.on{background:var(--panel2);border-color:var(--line);color:var(--text)}
.badge{position:absolute;top:-2px;right:-2px;background:var(--bad);color:#fff;font-size:.7rem;border-radius:99px;padding:1px 6px}
.badge.warn{background:var(--warn);color:#000}
.main{padding:18px;max-width:1500px;width:100%;margin:0 auto}
.loading{padding:40px;text-align:center;color:var(--muted)}
.recep{display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start}
.side{position:sticky;top:120px}
.sec{margin-top:8px;padding-top:12px;border-top:1px dashed var(--line)}
.frame{background:#0a0f1e;border:1px solid var(--line);border-radius:12px;padding:12px;max-height:420px;overflow:auto}
.readonly{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--text);font-variant-numeric:tabular-nums}
.tag{font-size:.75rem;background:var(--brand);color:#fff;padding:3px 8px;border-radius:99px;vertical-align:middle}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.bubble{position:relative;text-align:left;display:flex;flex-direction:column;gap:4px;padding:12px;border-radius:16px;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:linear-gradient(160deg,color-mix(in srgb,var(--c) 22%,#121a2f),#101729);color:var(--text);cursor:pointer;font:inherit;transition:transform .12s,box-shadow .2s;min-height:96px}
.bubble:hover{transform:translateY(-2px);box-shadow:0 8px 24px color-mix(in srgb,var(--c) 30%,transparent)}
.bubble.sel{outline:3px solid var(--brand2);outline-offset:2px}
.bubble.alert{animation:pulse 1.5s infinite}
@keyframes pulse{50%{box-shadow:0 0 0 4px #ef444466}}
.b-top{display:flex;justify-content:space-between;align-items:center;gap:6px}
.b-num{font-size:1.35rem}
.b-st{font-size:.7rem;font-weight:700;color:var(--c);text-transform:uppercase;letter-spacing:.04em}
.b-timer{font-variant-numeric:tabular-nums;font-weight:700;font-size:1.05rem}
.b-meta,.b-sub{font-size:.78rem}
.b-wait{font-size:.75rem;color:var(--warn);font-weight:700}
.pend{color:#fca5a5;font-weight:700}.okt{color:#86efac}
.status{display:inline-block;font-size:.75rem;font-weight:700;padding:3px 9px;border-radius:99px;color:var(--c);background:color-mix(in srgb,var(--c) 18%,transparent);border:1px solid color-mix(in srgb,var(--c) 40%,transparent)}
.pill{display:inline-block;font-size:.75rem;font-weight:700;padding:3px 9px;border-radius:99px;background:var(--panel2);border:1px solid var(--line)}
.pill.ok{color:#86efac;border-color:#22c55e55}.pill.warn{color:#fcd34d;border-color:#f59e0b66}.pill.bad{color:#fca5a5;border-color:#ef444466}
.ok-t{color:#86efac}.bad-t{color:#fca5a5}.err-text{color:#fca5a5}
.live{font-size:.75rem;color:var(--ok);font-weight:600;margin-left:8px}
.dim{opacity:.5}
.prod-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.prod{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:6px}
.prod.on{border-color:var(--brand);background:#221e4a}.prod.out{opacity:.45}
.prod-name{font-weight:700;font-size:.9rem}
.stepper{display:flex;align-items:center;justify-content:space-between}
.stepper button{width:32px;height:32px;border-radius:9px;border:1px solid var(--line);background:#0f1628;color:var(--text);font-size:1.1rem;cursor:pointer}
.stepper button:disabled{opacity:.35}
.stepper span{font-weight:800;font-variant-numeric:tabular-nums}
.summary{background:#0a0f1e;border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px}
.summary div{display:flex;justify-content:space-between}
.summary .tot{border-top:1px solid var(--line);padding-top:8px;font-size:1.1rem}
.wait-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--line)}
.overlay{position:fixed;inset:0;background:#000a;backdrop-filter:blur(4px);display:grid;place-items:center;z-index:50;padding:14px;animation:fade .15s}
@keyframes fade{from{opacity:0}}
.modal{width:min(520px,100%);max-height:92vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:0 20px 60px #000a;animation:pop .18s}
.modal.wide{width:min(860px,100%)}
@keyframes pop{from{transform:scale(.96);opacity:0}}
.modal-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel);z-index:2}
.modal-head h3{margin:0}
.modal-body{padding:18px;display:flex;flex-direction:column;gap:10px}
.x{background:transparent;border:0;color:var(--muted);font-size:1.2rem;cursor:pointer}
.occ-head{text-align:center;margin:8px 0}
.big-timer{font-size:2.4rem;font-weight:800;font-variant-numeric:tabular-nums;background:linear-gradient(90deg,var(--brand2),var(--brand));-webkit-background-clip:text;background-clip:text;color:transparent}
.clean{text-align:center}
.pend-row td{color:#fca5a5}.warn-row td{color:#fcd34d}
.confirm{background:#2a1220;border:1px solid #ef444466;border-radius:12px;padding:12px}
.qr-reader{width:100%;min-height:240px;border-radius:12px;overflow:hidden;background:#000}
.qr-img{width:min(300px,100%);border-radius:12px;background:#fff}
.photo-input{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.photo-input img{height:90px;border-radius:10px;border:1px solid var(--line)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.g-item{background:var(--panel2);border:1px solid var(--line);border-radius:12px;overflow:hidden;padding:0;cursor:pointer;color:var(--text);text-align:left;font:inherit;font-size:.82rem}
.g-item img{width:100%;height:150px;object-fit:cover;display:block}
.g-item span{display:block;padding:8px}
.full-img{width:100%;border-radius:12px}
.thumb{width:48px;height:48px;object-fit:cover;border-radius:8px;cursor:pointer}
.chat{display:flex;flex-direction:column;height:calc(100vh - 160px);min-height:420px}
.msgs{flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:6px 2px}
.msg{max-width:min(560px,85%);padding:10px 12px;border-radius:14px;background:var(--panel2);border:1px solid var(--line)}
.msg.me{align-self:flex-end;background:#251f55;border-color:#7c5cff55}
.msg-meta{font-size:.72rem;color:var(--muted);margin-bottom:4px}
.msg-img{max-width:240px;width:100%;border-radius:10px;margin-top:6px;display:block}
.chat-input{display:flex;gap:8px;margin-top:10px}
.audit{margin-top:8px;background:#0a0f1e;border:1px solid var(--line);border-radius:12px;padding:10px}
.audit ul{margin:6px 0;padding-left:18px}
.checks{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.kpi{background:linear-gradient(160deg,#1a2347,#121a2f);border:1px solid var(--line);border-radius:var(--r);padding:14px;display:flex;flex-direction:column;gap:4px}
.kpi b{font-size:1.35rem}
.bars{display:flex;flex-direction:column;gap:8px}
.bar-row{display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;font-size:.85rem}
.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{height:10px;background:var(--panel2);border-radius:99px;overflow:hidden}
.bar div{height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2));border-radius:99px;transition:width .4s}
.bar div.bad{background:var(--bad)}.bar div.warn{background:var(--warn)}.bar div.ok{background:var(--ok)}
.bar-val{font-variant-numeric:tabular-nums;white-space:nowrap}
.stock-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.stock-row{display:grid;grid-template-columns:140px 1fr 40px;gap:10px;align-items:center;font-size:.85rem}
.sug{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
.toasts{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:100;width:min(440px,92vw)}
.toast{padding:12px 16px;border-radius:12px;background:#14532d;border:1px solid #22c55e88;box-shadow:0 10px 30px #0008;animation:pop .2s;font-weight:600}
.toast.err{background:#4c1414;border-color:#ef444488}
@media (max-width:1100px){.recep{grid-template-columns:1fr}.side{position:static}.cols5{grid-template-columns:repeat(3,1fr)}}
@media (max-width:760px){
  .main{padding:12px}.card{padding:14px}
  .cols2,.cols3,.cols4,.cols5{grid-template-columns:1fr 1fr}
  .hide-sm{display:none}.tabs{top:55px;padding:8px 12px}
  .grid{grid-template-columns:repeat(auto-fill,minmax(128px,1fr))}
  .bar-row{grid-template-columns:90px 1fr auto}.checks{grid-template-columns:1fr}
}
@media (max-width:480px){.cols2,.cols3,.cols4,.cols5{grid-template-columns:1fr}}
`
