import { useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowRight, ArrowUpRight, Bell, Bot, Check, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Command, FileText, Filter, LayoutDashboard,
  LifeBuoy, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Plus, Search, Settings2,
  ShieldCheck, Sparkles, Workflow, X, Zap,
} from 'lucide-react'

type AgentStatus = 'Running' | 'Idle' | 'Paused' | 'Needs review'
type TaskStatus = 'In progress' | 'Queued' | 'Completed' | 'Failed'
type Agent = { id: string; name: string; role: string; initials: string; color: string; status: AgentStatus; tasks: number; model: string }
type Task = { id: string; title: string; agent: string; status: TaskStatus; updated: string; priority: 'High' | 'Medium' | 'Low'; input?: string; output?: string }

const seedAgents: Agent[] = []
const seedTasks: Task[] = []

const statusClass: Record<string, string> = {
  Running: 'status-running', Idle: 'status-idle', Paused: 'status-idle', 'Needs review': 'status-review',
  'In progress': 'status-progress', Queued: 'status-queued', Completed: 'status-completed', Failed: 'status-failed',
}

function mapApiTask(task: { id: string; title: string; status: string; input?: string; output?: string; agentName?: string | null; createdAt?: string; updatedAt?: string }): Task {
  const statusMap: Record<string, TaskStatus> = { queued: 'Queued', running: 'In progress', completed: 'Completed', failed: 'Failed' }
  return { id: task.id, title: task.title, agent: task.agentName || 'Gemini AI Agent', status: statusMap[task.status] || 'Queued', updated: task.updatedAt ? new Date(task.updatedAt).toLocaleString() : 'Just now', priority: 'Medium', input: task.input, output: task.output }
}

export default function App() {
  const [authToken, setAuthToken] = useState(() => {
    // Migrate legacy persistent tokens once, then keep the token tab-scoped.
    const legacyToken = window.localStorage.getItem('agentgrid_token')
    if (legacyToken) {
      window.sessionStorage.setItem('agentgrid_token', legacyToken)
      window.localStorage.removeItem('agentgrid_token')
      return legacyToken
    }
    return window.sessionStorage.getItem('agentgrid_token') || ''
  })
  const [authUser, setAuthUser] = useState<{ email: string; workspaceName: string; role: string } | null>(null)
  const [authReady, setAuthReady] = useState(false)
  useEffect(() => {
    if (!authToken) { setAuthReady(true); return }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${authToken}` } })
      .then(async response => { if (!response.ok) throw new Error('Session expired'); return response.json() })
      .then(data => setAuthUser(data.user))
      .catch(() => { window.sessionStorage.removeItem('agentgrid_token'); setAuthToken(''); setAuthUser(null) })
      .finally(() => setAuthReady(true))
  }, [authToken])
  const [activeNav, setActiveNav] = useState('Overview')
  const [agents, setAgents] = useState<Agent[]>(seedAgents)
  const [usage, setUsage] = useState<{ requests: number; inputTokens: number; outputTokens: number; dailyRequestLimit: number; remainingRequests: number; model: string } | null>(null)
  const [activityItems, setActivityItems] = useState<Array<{ id: string; type: string; detail: string; createdAt: string }>>([])
  const [tasks, setTasks] = useState<Task[]>(seedTasks)
  const [tasksLoading, setTasksLoading] = useState(false)
  const [runningTaskIds, setRunningTaskIds] = useState<string[]>([])
  const [taskFilter, setTaskFilter] = useState('All tasks')
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newTask, setNewTask] = useState('')
  const [newTaskAgentId, setNewTaskAgentId] = useState('')
  const [notice, setNotice] = useState('')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [selectedOutput, setSelectedOutput] = useState<{ title: string; output: string } | null>(null)

  useEffect(() => {
    if (!authToken || !authUser) return
    let cancelled = false
    setTasksLoading(true)
    fetch('/api/tasks', { headers: { Authorization: `Bearer ${authToken}` } })
      .then(async response => {
        const data = await response.json() as { tasks?: Array<{ id: string; title: string; status: string; input?: string; output?: string; agentName?: string | null; createdAt?: string; updatedAt?: string }>; error?: string }
        if (!response.ok) throw new Error(data.error || 'Task жагсаалт ачаалсангүй.')
        if (!cancelled) setTasks((data.tasks || []).map(mapApiTask))
      })
      .catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : 'Task ачаалсангүй') })
      .finally(() => { if (!cancelled) setTasksLoading(false) })
    return () => { cancelled = true }
  }, [authToken, authUser?.email])

  useEffect(() => {
    if (!authToken || !authUser) return
    const headers = { Authorization: `Bearer ${authToken}` }
    Promise.all([
      fetch('/api/agents', { headers }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Agent жагсаалт ачаалсангүй'); return d.agents as Array<{ id: string; name: string; role: string; instructions?: string; model: string; status: string }> }),
      fetch('/api/usage', { headers }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Usage ачаалсангүй'); return d.usage }),
      fetch('/api/activity', { headers }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Activity ачаалсангүй'); return d.events as Array<{ id: string; type: string; detail: string; createdAt: string }> }),
    ]).then(([agentData, usageData, eventData]) => {
      setAgents(agentData.map(a => ({ id: a.id, name: a.name, role: a.role, initials: a.name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(), color: 'violet', status: a.status === 'running' ? 'Running' : a.status === 'paused' ? 'Paused' : 'Idle', tasks: 0, model: a.model })))
      setUsage(usageData); setActivityItems(eventData)
    }).catch(error => notify(error instanceof Error ? error.message : 'Workspace өгөгдөл ачаалсангүй'))
  }, [authToken, authUser?.email])

  const filteredTasks = useMemo(() => tasks.filter(task => {
    const matchesFilter = taskFilter === 'All tasks' || task.status === taskFilter
    const matchesSearch = (task.title + task.agent + task.id).toLowerCase().includes(search.toLowerCase())
    return matchesFilter && matchesSearch
  }), [tasks, taskFilter, search])

  function notify(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 3000)
  }
  async function addTask() {
    const title = newTask.trim()
    if (!title) return
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ title: title.slice(0, 200), input: title, agentId: newTaskAgentId || null }),
      })
      const data = await response.json() as { task?: { id: string; title: string; status: string; input?: string; output?: string; agentName?: string | null; createdAt?: string; updatedAt?: string }; error?: string }
      if (!response.ok || !data.task) throw new Error(data.error || 'Task үүсгэж чадсангүй.')
      setTasks(current => [mapApiTask(data.task!), ...current])
      setNewTask(''); setNewTaskAgentId(''); setShowCreate(false); setActiveNav('Tasks'); setTaskFilter('All tasks')
      notify('Task өгөгдлийн санд хадгалагдлаа')
    } catch (error) { notify(error instanceof Error ? error.message : 'Task үүсгэхэд алдаа гарлаа') }
  }
  async function runTask(id: string) {
    if (runningTaskIds.includes(id)) return
    setRunningTaskIds(current => [...current, id])
    setTasks(current => current.map(task => task.id === id ? { ...task, status: 'In progress' } : task))
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/run`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } })
      const data = await response.json() as { task?: { id: string; title: string; status: string; input?: string; output?: string; agentName?: string | null; createdAt?: string; updatedAt?: string }; error?: string }
      if (!response.ok || !data.task) throw new Error(data.error || 'Task ажиллуулж чадсангүй.')
      setTasks(current => current.map(task => task.id === id ? mapApiTask(data.task!) : task))
      notify('AI task амжилттай дууслаа')
    } catch (error) {
      // The API can reject a run before claiming the task (for example, when
      // GEMINI_API_KEY is missing). Re-read server state instead of falsely
      // showing the task as failed when it is still queued.
      try {
        const refresh = await fetch('/api/tasks', { headers: { Authorization: `Bearer ${authToken}` } })
        const refreshData = await refresh.json() as { tasks?: Array<{ id: string; title: string; status: string; input?: string; output?: string; agentName?: string | null; createdAt?: string; updatedAt?: string }> }
        if (refresh.ok && refreshData.tasks) setTasks(refreshData.tasks.map(mapApiTask))
      } catch { /* Keep the last known state if refresh is unavailable. */ }
      notify(error instanceof Error ? error.message : 'Task ажиллуулахад алдаа гарлаа')
    } finally { setRunningTaskIds(current => current.filter(taskId => taskId !== id)) }
  }
  async function toggleAgent(id: string) {
    const current = agents.find(agent => agent.id === id)
    if (!current) return
    const status = current.status === 'Running' ? 'paused' : 'running'
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, body: JSON.stringify({ status }) })
      const data = await response.json() as { agent?: { status: string }; error?: string }
      if (!response.ok || !data.agent) throw new Error(data.error || 'Agent status шинэчилж чадсангүй')
      setAgents(currentAgents => currentAgents.map(agent => agent.id === id ? { ...agent, status: data.agent!.status === 'running' ? 'Running' : 'Paused' } : agent))
      notify('Agent status хадгалагдлаа')
    } catch (error) { notify(error instanceof Error ? error.message : 'Agent шинэчлэхэд алдаа гарлаа') }
  }
  async function createAgent() {
    const name = window.prompt('Agent нэр:')?.trim() || ''
    if (!name) return
    const role = window.prompt('Agent үүрэг:')?.trim() || ''
    if (!role) return
    try {
      const response = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, body: JSON.stringify({ name, role }) })
      const data = await response.json() as { agent?: { id: string; name: string; role: string; model: string; status: string }; error?: string }
      if (!response.ok || !data.agent) throw new Error(data.error || 'Agent үүсгэж чадсангүй')
      const a = data.agent
      setAgents(current => [{ id: a.id, name: a.name, role: a.role, initials: a.name.split(/\s+/).map(x => x[0]).join('').slice(0,2).toUpperCase(), color: 'violet', status: 'Idle', tasks: 0, model: a.model }, ...current])
      notify('Agent хадгалагдлаа')
    } catch (error) { notify(error instanceof Error ? error.message : 'Agent үүсгэхэд алдаа гарлаа') }
  }

  const navGroups = [
    { label: 'WORKSPACE', items: [{ label: 'Overview', icon: LayoutDashboard }, { label: 'Agents', icon: Bot, count: String(agents.length) }, { label: 'Tasks', icon: Workflow, count: String(tasks.length) }, { label: 'Activity', icon: Activity }, { label: 'AI Playground', icon: MessageSquare }] },
    { label: 'MANAGE', items: [{ label: 'Knowledge base', icon: FileText }, { label: 'Integrations', icon: Command }] },
  ]

  if (!authReady) return <div className="auth-loading"><div className="brand-mark"><Workflow size={21} /></div><span>AgentGrid ачаалж байна…</span></div>
  if (!authUser || !authToken) return <AuthScreen onAuthenticated={(token, user) => { window.sessionStorage.setItem('agentgrid_token', token); setAuthToken(token); setAuthUser(user) }} />

  return <div className="app-shell">
    {sidebarOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-row"><div className="brand-mark"><Workflow size={21} /></div><span className="brand-name">agent<span>grid</span></span><button className="icon-button sidebar-collapse" aria-label="Sidebar options" onClick={() => notify('Sidebar preferences are local in this demo')}><PanelLeftClose size={17} /></button></div>
      <button className="workspace-switcher" onClick={() => notify('Workspace switching requires an account backend')}><div className="workspace-avatar">A</div><div className="workspace-copy"><strong>{authUser.workspaceName}</strong><span>{authUser.role} workspace</span></div><ChevronDown size={15} className="muted-icon" /></button>
      <nav className="nav-groups" aria-label="Main navigation">{navGroups.map(group => <div className="nav-group" key={group.label}><div className="nav-heading">{group.label}</div>{group.items.map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${activeNav === item.label ? 'nav-item-active' : ''}`} onClick={() => { setActiveNav(item.label); setSidebarOpen(false) }}><Icon size={17} /><span>{item.label}</span>{'count' in item && <span className="nav-count">{item.count}</span>}</button> })}</div>)}</nav>
      <div className="sidebar-spacer" />
      <div className="usage-card"><div className="usage-title"><span>Daily AI usage</span><span className="usage-percent">{usage ? Math.round((usage.requests / Math.max(1, usage.dailyRequestLimit)) * 100) : 0}%</span></div><div className="usage-bar"><span style={{ width: `${usage ? Math.min(100, (usage.requests / Math.max(1, usage.dailyRequestLimit)) * 100) : 0}%` }} /></div><p>{usage ? `${usage.requests} of ${usage.dailyRequestLimit} AI requests today` : 'Loading real usage…'}</p><button onClick={() => setActiveNav('Settings')}>Usage details <ArrowRight size={13} /></button></div>
      <button className="nav-item bottom-nav" onClick={() => setActiveNav('Settings')}><Settings2 size={17} /><span>Settings</span></button>
      <button className="nav-item bottom-nav" onClick={() => notify('Help center is not connected yet')}><LifeBuoy size={17} /><span>Help & support</span></button>
      <div className="profile-row"><div className="profile-avatar">AM</div><div className="profile-copy"><strong>{authUser.email}</strong><span>{authUser.role} · Signed in</span></div><button className="icon-button" title="Log out" aria-label="Log out" onClick={() => { window.sessionStorage.removeItem('agentgrid_token'); setAuthToken(''); setAuthUser(null); setAgents([]); setTasks([]); setActivityItems([]); setUsage(null); setAuthReady(true) }}><MoreHorizontal size={18} /></button></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><span>Workspace</span><ChevronRight size={14} /><strong>{activeNav}</strong></div><div className="topbar-actions"><label className="search-box"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks..." aria-label="Search workspace" /><kbd>⌘ K</kbd></label><div className="notification-wrap"><button className="icon-button notification-button" aria-label="Notifications" onClick={() => setNotificationsOpen(!notificationsOpen)}><Bell size={18} /><i /></button>{notificationsOpen && <div className="notification-popover"><strong>Recent activity</strong>{activityItems.slice(0, 3).map(item => <p key={item.id}><span className="dot dot-green" /> {item.detail}</p>)}{activityItems.length === 0 && <p>Одоогоор мэдэгдэл алга.</p>}<button onClick={() => { setNotificationsOpen(false); setActiveNav('Activity') }}>View activity <ArrowRight size={13} /></button></div>}</div><button className="help-button" onClick={() => notify('Help center is coming soon')}><CircleHelp size={17} /><span>Help</span></button></div></header>
      <div className="page-content">
        {activeNav === 'Overview' && <Overview agents={agents} tasks={tasks} usage={usage} activityItems={activityItems} setActiveNav={setActiveNav} onCreate={() => setShowCreate(true)} onToggleAgent={toggleAgent} onCreateAgent={createAgent} />}
        {activeNav === 'Agents' && <AgentsPage agents={agents} onToggle={toggleAgent} onCreate={createAgent} />}
        {activeNav === 'Tasks' && <TasksPage tasks={filteredTasks} filter={taskFilter} setFilter={setTaskFilter} onCreate={() => setShowCreate(true)} onRun={runTask} onViewOutput={setSelectedOutput} runningTaskIds={runningTaskIds} loading={tasksLoading} />}
        {activeNav === 'Activity' && <ActivityPage items={activityItems} />}
        {activeNav === 'AI Playground' && <AIPlayground notify={notify} />}
        {activeNav === 'Knowledge base' && <KnowledgeBasePage token={authToken} notify={notify} />}
        {activeNav === 'Integrations' && <PlaceholderPage icon={<Command size={23} />} title="Integrations" description="Connect the tools your team already uses and bring work into one place." action="Browse integrations" onAction={() => notify('Integration catalog is coming soon')} />}
        {activeNav === 'Settings' && <SettingsPage usage={usage} model={usage?.model || 'gemini-3.5-flash-lite'} />}
      </div>
    </main>

    {showCreate && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowCreate(false) }}><section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="modal-heading"><div><span className="eyebrow">NEW WORKFLOW</span><h2 id="create-title">Create a task</h2><p>Describe the outcome you want your agent to deliver.</p></div><button className="icon-button" onClick={() => setShowCreate(false)} aria-label="Close"><X size={19} /></button></div><form onSubmit={e => { e.preventDefault(); addTask() }}><label className="field-label" htmlFor="task-title">Task description</label><textarea id="task-title" value={newTask} onChange={e => setNewTask(e.target.value)} placeholder="e.g. Research the top 5 competitors and summarize their positioning..." rows={4} required /><label className="field-label" htmlFor="task-agent">Гүйцэтгэх agent (сонголтоор)</label><select id="task-agent" value={newTaskAgentId} onChange={e => setNewTaskAgentId(e.target.value)}><option value="">Ерөнхий Gemini task</option>{agents.filter(agent => agent.status !== 'Paused').map(agent => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}</select><div className="modal-note"><Bot size={16} /><span>Гүйцэтгэгч: тохируулсан Gemini AI загвар</span></div><div className="modal-note"><Sparkles size={16} /><span>Task серверийн өгөгдлийн санд хадгалагдана. Tasks хэсгээс Gemini AI ажиллуулна.</span></div><div className="modal-footer"><button type="button" className="button-secondary" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className="button-primary"><Plus size={16} /> Add to queue</button></div></form></section></div>}
    {selectedOutput && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setSelectedOutput(null) }}><section className="create-modal output-modal" role="dialog" aria-modal="true" aria-labelledby="output-title"><div className="modal-heading"><div><span className="eyebrow">COMPLETED TASK</span><h2 id="output-title">AI result</h2><p>{selectedOutput.title}</p></div><button className="icon-button" onClick={() => setSelectedOutput(null)} aria-label="Close output"><X size={19} /></button></div><div className="ai-answer-text">{selectedOutput.output}</div><div className="modal-footer"><button className="button-secondary" onClick={() => { void navigator.clipboard?.writeText(selectedOutput.output); notify('AI хариуг хууллаа') }}>Copy result</button><button className="button-primary" onClick={() => setSelectedOutput(null)}>Done</button></div></section></div>}
    {notice && <div className="toast" role="status"><Check size={16} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button></div>}
  </div>
}


function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: { email: string; workspaceName: string; role: string }) => void }) {
  const [mode, setMode] = useState<'register' | 'login'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [workspaceName, setWorkspaceName] = useState('My workspace')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, workspaceName }),
      })
      const data = await response.json() as { token?: string; user?: { email: string; workspaceName: string; role: string }; error?: string }
      if (!response.ok || !data.token || !data.user) throw new Error(data.error || 'Нэвтрэх хүсэлт амжилтгүй боллоо.')
      onAuthenticated(data.token, data.user)
    } catch (err) { setError(err instanceof Error ? err.message : 'Сүлжээний алдаа гарлаа.') }
    finally { setLoading(false) }
  }
  return <main className="auth-screen"><section className="auth-card"><div className="auth-brand"><div className="brand-mark"><Workflow size={21} /></div><span className="brand-name">agent<span>grid</span></span></div><div className="eyebrow">YOUR AI WORKSPACE</div><h1>{mode === 'register' ? 'Өөрийн workspace үүсгэ' : 'Тавтай морил'}</h1><p className="auth-description">AI ажлуудаа нэг аюулгүй ажлын орчноос удирдаарай.</p><div className="auth-tabs"><button className={mode === 'register' ? 'auth-tab active' : 'auth-tab'} onClick={() => { setMode('register'); setError('') }}>Бүртгүүлэх</button><button className={mode === 'login' ? 'auth-tab active' : 'auth-tab'} onClick={() => { setMode('login'); setError('') }}>Нэвтрэх</button></div><form onSubmit={submit} className="auth-form">{mode === 'register' && <label>Workspace нэр<input value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} minLength={2} maxLength={80} required /></label>}<label>Имэйл хаяг<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} required /></label><label>Нууц үг<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} minLength={mode === 'register' ? 12 : 1} maxLength={128} required />{mode === 'register' && <small>12-оос доошгүй тэмдэгт</small>}</label>{error && <div className="ai-error" role="alert">{error}</div>}<button className="button-primary auth-submit" type="submit" disabled={loading}>{loading ? 'Түр хүлээнэ үү…' : mode === 'register' ? 'Workspace үүсгэх' : 'Нэвтрэх'} <ArrowRight size={15} /></button></form><div className="auth-security"><ShieldCheck size={16} /><span>Нууц үгийг сервер дээр хэшлэж хадгална. API түлхүүрээ браузерт оруулах шаардлагагүй.</span></div></section><p className="auth-footer">AgentGrid · Early access</p></main>
}


function AIPlayground({ notify }: { notify: (message: string) => void }) {
  const [prompt, setPrompt] = useState('AgentGrid-ийн гол давуу талыг 3 цэгээр тайлбарла.')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function submitPrompt(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt || loading) return
    setLoading(true); setError(''); setAnswer('')
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.sessionStorage.getItem('agentgrid_token') || ''}` },
        body: JSON.stringify({ prompt: cleanPrompt }),
      })
      const data = await response.json() as { text?: string; error?: string }
      if (!response.ok) throw new Error(data.error || 'AI хүсэлт амжилтгүй боллоо.')
      setAnswer(data.text || 'Хариу хоосон ирлээ.')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Сүлжээний алдаа гарлаа.'
      setError(message)
      notify('AI хүсэлтийг гүйцэтгэж чадсангүй')
    } finally { setLoading(false) }
  }
  return <>
    <PageHeader eyebrow="MODEL WORKSPACE" title="AI Playground" description="Gemini API-г backend-ээр дамжуулан аюулгүй туршиж үзээрэй." />
    <section className="panel ai-playground-panel">
      <div className="ai-playground-intro"><div className="placeholder-icon"><Sparkles size={22} /></div><div><h2>Prompt-оо ажиллуулах</h2><p>Зардал багатай Gemini Flash-Lite загварын туршилтын талбар.</p></div></div>
      <form onSubmit={submitPrompt}>
        <label className="field-label" htmlFor="ai-prompt">Таны хүсэлт</label>
        <textarea id="ai-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={5} maxLength={12000} required placeholder="AI-д юу хийлгэхээ бичнэ үү…" />
        <div className="ai-form-footer"><span>{prompt.length.toLocaleString()} / 12,000 тэмдэгт</span><button className="button-primary" type="submit" disabled={loading || !prompt.trim()}><Sparkles size={15} /> {loading ? 'Боловсруулж байна…' : 'Run prompt'}</button></div>
      </form>
      {error && <div className="ai-error" role="alert"><strong>Хүсэлт амжилтгүй</strong><p>{error}</p><span>Backend ажиллаж байгаа эсэх, мөн server/.env дотор GEMINI_API_KEY тохируулсан эсэхийг шалгана уу.</span></div>}
      {answer && <div className="ai-answer"><div className="ai-answer-heading"><strong><Sparkles size={15} /> Model response</strong><button className="subtle-button" type="button" onClick={() => { void navigator.clipboard?.writeText(answer); notify('Хариуг clipboard-д хууллаа') }}>Copy answer</button></div><div className="ai-answer-text">{answer}</div></div>}
      <div className="info-callout"><ShieldCheck size={18} /><div><strong>API key браузерт очихгүй</strong><p>Хүсэлт backend рүү явна. API key-г зөвхөн server/.env-д хадгална. Хэрэглээний төлбөр болон квот нь таны Google AI Studio төслөөс хамаарна.</p></div></div>
    </section>
  </>
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>
}
function Overview({ agents, tasks, usage, activityItems, setActiveNav, onCreate, onToggleAgent, onCreateAgent }: { agents: Agent[]; tasks: Task[]; usage: { requests: number; inputTokens: number; outputTokens: number; dailyRequestLimit: number; remainingRequests: number; model: string } | null; activityItems: Array<{ id: string; type: string; detail: string; createdAt: string }>; setActiveNav: (value: string) => void; onCreate: () => void; onToggleAgent: (id: string) => void; onCreateAgent: () => void }) {
  const completed = tasks.filter(task => task.status === 'Completed').length
  return <>
    <PageHeader eyebrow="YOUR AI WORKSPACE" title="AgentGrid overview" description="AI ажлууд, агентууд болон хэрэглээний бодит төлөв." action={<button className="button-primary" onClick={onCreate}><Plus size={16} /> Create task</button>} />
    <div className="welcome-banner"><div className="banner-orb orb-one" /><div className="banner-content"><div className="banner-icon"><Sparkles size={19} /></div><div><div className="banner-kicker">YOUR AI WORKSPACE</div><h2>AI ажлуудаа нэг workspace-ээс удирдаарай.</h2><p>Task үүсгэж, Gemini-ээр ажиллуулж, хэрэглээний бодит мэдээллээ хяна.</p></div></div><button className="banner-link" onClick={() => setActiveNav('AI Playground')}>Try AI Playground <ArrowRight size={15} /></button></div>
    <div className="section-heading"><div><h2>Workspace overview</h2><p>Серверийн өгөгдлөөс тооцоолсон үзүүлэлт</p></div></div>
    <div className="metrics-grid"><MetricCard icon={<Bot size={18} />} tone="violet" label="Active agents" value={String(agents.filter(a => a.status === 'Running').length)} trend={`${agents.length} total`} note="saved agents" /><MetricCard icon={<Workflow size={18} />} tone="blue" label="Tasks completed" value={String(completed)} trend={`${tasks.length} total`} note="saved tasks" /><MetricCard icon={<Zap size={18} />} tone="amber" label="Tokens used today" value={usage ? String(usage.inputTokens + usage.outputTokens) : '—'} trend={usage ? `${usage.requests} requests` : '—'} note="reported by AI provider" /><MetricCard icon={<Clock3 size={18} />} tone="green" label="AI requests left" value={usage ? String(usage.remainingRequests) : '—'} trend={usage ? `${usage.dailyRequestLimit}/day limit` : '—'} note="usage quota" /></div>
    <div className="content-grid"><section className="panel"><div className="panel-heading"><div><h2>Your agents</h2><p>Saved workspace agents</p></div><button className="text-link" onClick={() => setActiveNav('Agents')}>View all <ArrowRight size={14} /></button></div><div>{agents.slice(0, 4).map(agent => <AgentRow key={agent.id} agent={agent} onToggle={() => onToggleAgent(agent.id)} />)}</div>{agents.length === 0 && <div className="empty-state"><Bot size={24} /><p>Agent байхгүй байна.</p></div>}<button className="panel-bottom-link" onClick={onCreateAgent}><Plus size={15} /> Create new agent</button></section>
    <section className="panel"><div className="panel-heading"><div><h2>Recent tasks</h2><p>Сүүлд шинэчлэгдсэн task-ууд</p></div><button className="text-link" onClick={() => setActiveNav('Tasks')}>View all <ArrowRight size={14} /></button></div>{tasks.slice(0, 4).map(task => <div className="recent-task" key={task.id}><div className={`task-icon ${task.status === 'Completed' ? 'task-icon-done' : task.status === 'Queued' ? 'task-icon-queued' : 'task-icon-active'}`}>{task.status === 'Completed' ? <Check size={15} /> : task.status === 'Queued' ? <Clock3 size={15} /> : <Activity size={15} />}</div><div className="recent-task-main"><strong>{task.title}</strong><span>{task.agent} · {task.updated}</span></div><span className={`status-pill ${statusClass[task.status]}`}>{task.status}</span></div>)}{tasks.length === 0 && <div className="empty-state"><Workflow size={24} /><p>Одоогоор task байхгүй байна.</p></div>}<button className="panel-bottom-link" onClick={() => setActiveNav('Tasks')}><Workflow size={15} /> Open task manager</button></section></div>
    <div className="content-grid lower-grid"><section className="panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Бодит activity event-үүд</p></div><button className="text-link" onClick={() => setActiveNav('Activity')}>View activity <ArrowRight size={14} /></button></div>{activityItems.slice(0, 4).map(item => <div className="activity-item" key={item.id}><div className="activity-icon activity-blue"><Activity size={15} /></div><div className="activity-copy"><strong>{item.type.replaceAll('.', ' ')}</strong><span>{item.detail}</span></div><time>{new Date(item.createdAt).toLocaleString()}</time></div>)}{activityItems.length === 0 && <div className="empty-state"><p>Одоогоор activity бүртгэгдээгүй.</p></div>}</section>
    <section className="panel performance-panel"><div className="panel-heading"><div><h2>AI usage</h2><p>Өнөөдрийн серверийн бүртгэл</p></div><button className="icon-button" aria-label="Usage details" onClick={() => setActiveNav('Settings')}><MoreHorizontal size={18} /></button></div><div className="performance-total"><strong>{usage ? usage.requests : '—'}</strong><span className="performance-caption">AI requests today</span></div><div className="usage-bar"><span style={{ width: `${usage ? Math.min(100, usage.requests / Math.max(1, usage.dailyRequestLimit) * 100) : 0}%` }} /></div><p>{usage ? `${usage.remainingRequests} хүсэлт үлдсэн · ${usage.dailyRequestLimit} хүсэлт/өдөр` : 'Usage ачаалж байна…'}</p><p className="metric-note">Billing холболт одоогоор идэвхгүй.</p></section></div>
  </>
}
function MetricCard({ icon, tone, label, value, trend, note, trendUp }: { icon: React.ReactNode; tone: string; label: string; value: string; trend: string; note: string; trendUp?: boolean }) {
  return <div className="metric-card"><div className="metric-top"><div className={`metric-icon metric-${tone}`}>{icon}</div><span className={trendUp ? 'metric-trend trend-positive' : 'metric-trend'}>{trendUp && <ArrowUpRight size={13} />}{trend}</span></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>
}
function AgentRow({ agent, onToggle }: { agent: Agent; onToggle: () => void }) {
  return <div className="agent-row"><div className={`agent-avatar avatar-${agent.color}`}>{agent.initials}</div><div className="agent-main"><strong>{agent.name}</strong><span>{agent.role}</span></div><div className="agent-row-meta"><span className={`status-dot ${statusClass[agent.status]}`} /><span>{agent.status}</span><span className="agent-task-count">{agent.tasks} tasks</span></div><button className="icon-button row-more" aria-label={`Toggle ${agent.name}`} title={agent.status === 'Running' ? 'Pause agent' : 'Start agent'} onClick={onToggle}><MoreHorizontal size={17} /></button></div>
}
function AgentsPage({ agents, onToggle, onCreate }: { agents: Agent[]; onToggle: (id: string) => void; onCreate: () => void }) {
  return <><PageHeader eyebrow="YOUR AI TEAM" title="Agents" description="Manage the specialized agents that help your team get work done." action={<button className="button-primary" onClick={onCreate}><Plus size={16} /> New agent</button>} /><div className="agent-page-grid">{agents.map(agent => <div className="agent-card" key={agent.id}><div className="agent-card-top"><div className={`agent-avatar agent-avatar-large avatar-${agent.color}`}>{agent.initials}</div><button className="icon-button" onClick={() => onToggle(agent.id)} aria-label="Toggle agent"><MoreHorizontal size={18} /></button></div><h3>{agent.name}</h3><p>{agent.role}</p><div className="agent-card-status"><span className={`status-dot ${statusClass[agent.status]}`} />{agent.status}</div><div className="agent-card-stats"><div><span>Tasks handled</span><strong>{agent.tasks}</strong></div><div><span>Model</span><strong>{agent.model}</strong></div></div><button className="button-secondary button-full" onClick={() => onToggle(agent.id)}>{agent.status === 'Running' ? 'Pause agent' : 'Start agent'}</button></div>)}</div><div className="info-callout"><ShieldCheck size={18} /><div><strong>Human oversight stays in control</strong><p>Agent status сервер дээр хадгалагдана. Одоогийн агентын execution нь зөвхөн task run үйлдлээр ажиллана; тусгай tool/action эрх өгөөгүй.</p></div></div></>
}
function TasksPage({ tasks, filter, setFilter, onCreate, onRun, onViewOutput, runningTaskIds, loading }: { tasks: Task[]; filter: string; setFilter: (value: string) => void; onCreate: () => void; onRun: (id: string) => void; onViewOutput: (value: { title: string; output: string } | null) => void; runningTaskIds: string[]; loading: boolean }) {
  const filters = ['All tasks', 'In progress', 'Queued', 'Completed', 'Failed']
  return <><PageHeader eyebrow="WORK MANAGEMENT" title="Tasks" description="Track every run, review progress, and keep work moving." action={<button className="button-primary" onClick={onCreate}><Plus size={16} /> Create task</button>} /><section className="panel task-table-panel"><div className="table-toolbar"><div className="filter-tabs">{filters.map(f => <button key={f} className={filter === f ? 'filter-tab filter-tab-active' : 'filter-tab'} onClick={() => setFilter(f)}>{f}</button>)}</div><button className="subtle-button" onClick={() => setFilter('All tasks')}><Filter size={14} /> Reset filters</button></div><div className="task-table-wrap"><table className="task-table"><thead><tr><th>Task</th><th>Assigned agent</th><th>Status</th><th>Priority</th><th>Updated</th><th /></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td><span className="task-id">{task.id}</span><strong>{task.title}</strong></td><td><span className="table-agent"><span className="table-agent-dot">{task.agent.split(' ').map(s => s[0]).join('').slice(0,2)}</span>{task.agent}</span></td><td><span className={`status-pill ${statusClass[task.status]}`}>{task.status}</span></td><td><span className={`priority priority-${task.priority.toLowerCase()}`}><span />{task.priority}</span></td><td className="table-time">{task.updated}</td><td>{(task.status === 'Queued' || task.status === 'Failed') ? <button className="subtle-button" disabled={runningTaskIds.includes(task.id)} onClick={() => onRun(task.id)}>{runningTaskIds.includes(task.id) ? 'Running…' : 'Run'}</button> : task.status === 'Completed' && task.output ? <button className="subtle-button" onClick={() => onViewOutput({ title: task.title, output: task.output || '' })}>View output</button> : <span className="table-time">—</span>}</td></tr>)}</tbody></table>{tasks.length === 0 && <div className="empty-state"><Workflow size={26} /><strong>{loading ? 'Loading tasks…' : 'No tasks yet'}</strong><p>{loading ? 'Your workspace tasks are loading.' : 'Create a task to save it to your workspace and run it with Gemini.'}</p></div>}</div><div className="table-footer"><span>Showing {tasks.length} tasks</span><span>Saved workspace tasks</span></div></section></>
}
function ActivityPage({ items }: { items: Array<{ id: string; type: string; detail: string; createdAt: string }> }) {
  return <><PageHeader eyebrow="WORKSPACE HISTORY" title="Activity" description="Таны workspace-д бодитоор бүртгэгдсэн үйл явдлууд." /><section className="panel full-activity-panel"><div className="panel-heading"><div><h2>Recent events</h2><p>Серверээс ачаалсан сүүлийн 100 үйл явдал</p></div></div>{items.length ? items.map(item => <div className="full-activity-row" key={item.id}><div className="activity-icon activity-blue"><Activity size={16} /></div><div className="activity-copy"><strong>{item.type.replaceAll('.', ' ')}</strong><span>{item.detail}</span></div><time>{new Date(item.createdAt).toLocaleString()}</time></div>) : <div className="empty-state"><Activity size={26} /><strong>Одоогоор үйл явдал алга</strong><p>Task болон agent ашиглах үед энд бүртгэгдэнэ.</p></div>}</section></>
}
function KnowledgeBasePage({ token, notify }: { token: string; notify: (message: string) => void }) {
  const [sources, setSources] = useState<Array<{ id: string; title: string; content: string; createdAt: string }>>([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  async function refresh() {
    try {
      const response = await fetch('/api/knowledge', { headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json() as { sources?: typeof sources; error?: string }
      if (!response.ok) throw new Error(data.error || 'Knowledge base ачаалсангүй')
      setSources(data.sources || [])
    } catch (error) { notify(error instanceof Error ? error.message : 'Knowledge base ачаалсангүй') }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [token])
  async function addSource(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (saving) return
    setSaving(true)
    try {
      const response = await fetch('/api/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ title, content }) })
      const data = await response.json() as { source?: typeof sources[number]; error?: string }
      if (!response.ok || !data.source) throw new Error(data.error || 'Эх сурвалж хадгалсангүй')
      setSources(current => [data.source!, ...current]); setTitle(''); setContent(''); notify('Knowledge source хадгалагдлаа')
    } catch (error) { notify(error instanceof Error ? error.message : 'Хадгалах үед алдаа гарлаа') }
    finally { setSaving(false) }
  }
  async function removeSource(id: string) {
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) { const data = await response.json() as { error?: string }; throw new Error(data.error || 'Устгаж чадсангүй') }
      setSources(current => current.filter(source => source.id !== id)); notify('Эх сурвалж устгагдлаа')
    } catch (error) { notify(error instanceof Error ? error.message : 'Устгахад алдаа гарлаа') }
  }
  return <><PageHeader eyebrow="WORKSPACE CONTEXT" title="Knowledge base" description="Текстэн баримт хадгалж, task ажиллах үед workspace-ийн AI context болгон ашигла." /><div className="content-grid"><section className="panel"><div className="panel-heading"><div><h2>Шинэ эх сурвалж</h2><p>Одоогоор файл upload биш, текстэн эх сурвалж дэмжинэ.</p></div></div><form className="auth-form" onSubmit={addSource}><label>Нэр<input value={title} onChange={e => setTitle(e.target.value)} minLength={2} maxLength={160} required /></label><label>Агуулга<textarea value={content} onChange={e => setContent(e.target.value)} rows={8} maxLength={20000} required placeholder="Танай бүтээгдэхүүн, дүрэм, процессын тухай мэдлэг…" /></label><div className="ai-form-footer"><span>{content.length.toLocaleString()} / 20,000</span><button className="button-primary" disabled={saving || !title.trim() || !content.trim()}>{saving ? 'Хадгалж байна…' : 'Save source'}</button></div></form></section><section className="panel"><div className="panel-heading"><div><h2>Хадгалсан эх сурвалж</h2><p>Сүүлийн 100 хүртэлх баримт</p></div></div>{loading ? <div className="empty-state">Ачаалж байна…</div> : sources.length ? sources.map(source => <div className="recent-task" key={source.id}><div className="task-icon task-icon-done"><FileText size={15} /></div><div className="recent-task-main"><strong>{source.title}</strong><span>{source.content.length.toLocaleString()} тэмдэгт · {new Date(source.createdAt).toLocaleDateString()}</span><p>{source.content.slice(0, 180)}{source.content.length > 180 ? '…' : ''}</p></div><button className="icon-button" onClick={() => void removeSource(source.id)} aria-label={`Delete ${source.title}`}><X size={16} /></button></div>) : <div className="empty-state"><FileText size={24} /><strong>Эх сурвалж алга</strong><p>Баримт нэмсний дараа agent task-д автоматаар контекст болж ашиглагдана.</p></div>}</section></div></>
}

function SettingsPage({ usage, model }: { usage: { requests: number; inputTokens: number; outputTokens: number; dailyRequestLimit: number; remainingRequests: number; model: string } | null; model: string }) {
  return <><PageHeader eyebrow="WORKSPACE CONFIGURATION" title="Settings" description="Одоогоор идэвхтэй тохиргоо болон хэрэглээний хязгаар." /><div className="content-grid"><section className="panel"><div className="panel-heading"><div><h2>AI provider</h2><p>Server environment-ээс уншигдана</p></div><ShieldCheck size={20} /></div><div className="settings-row"><span>Default model</span><strong>{model}</strong></div><div className="settings-row"><span>API key</span><strong>Server-side only</strong></div><div className="settings-row"><span>Daily AI request limit</span><strong>{usage?.dailyRequestLimit ?? '—'}</strong></div><p className="metric-note">Model болон API key-г server/.env дотор тохируулна. Энд нууц түлхүүрийг харуулахгүй.</p></section><section className="panel"><div className="panel-heading"><div><h2>Usage</h2><p>UTC өдрийн эхлэлээс хойшхи usage record</p></div><Zap size={20} /></div><div className="settings-row"><span>Requests today</span><strong>{usage?.requests ?? '—'}</strong></div><div className="settings-row"><span>Input tokens</span><strong>{usage?.inputTokens.toLocaleString() ?? '—'}</strong></div><div className="settings-row"><span>Output tokens</span><strong>{usage?.outputTokens.toLocaleString() ?? '—'}</strong></div><div className="settings-row"><span>Remaining requests</span><strong>{usage?.remainingRequests ?? '—'}</strong></div><p className="metric-note">Төлбөрийн нэхэмжлэл, subscription болон бодит мөнгөн дүнгийн billing хараахан холбогдоогүй.</p></section></div></>
}

function PlaceholderPage({ icon, title, description, action, onAction }: { icon: React.ReactNode; title: string; description: string; action: string; onAction: () => void }) {
  return <div className="placeholder-wrap"><div className="placeholder-card"><div className="placeholder-icon">{icon}</div><div className="eyebrow">AGENTGRID WORKSPACE</div><h1>{title}</h1><p>{description}</p><button className="button-primary" onClick={onAction}>{action} <ArrowRight size={15} /></button><span className="placeholder-footnote">This section is scaffolded for the next product milestone.</span></div></div>
}
