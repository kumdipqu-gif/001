'use client';

import { type CSSProperties, useEffect, useMemo, useState } from 'react';

import { agentService, type AvailableAgentItem } from '@/services/agent';
import {
  type ProjectLaneSnapshot,
  smartWorkbenchLaneManager,
} from '@/features/SmartWorkbench/runtime/IsolatedProjectLaneManager';

const card: CSSProperties = { background: 'rgba(127,127,127,.075)', border: '1px solid rgba(127,127,127,.18)', borderRadius: 16, padding: 16 };
const input: CSSProperties = { background: 'rgba(127,127,127,.05)', border: '1px solid rgba(127,127,127,.25)', borderRadius: 9, boxSizing: 'border-box', color: 'inherit', outline: 'none', padding: '10px 12px', width: '100%' };
const button: CSSProperties = { background: 'rgba(127,127,127,.08)', border: '1px solid rgba(127,127,127,.28)', borderRadius: 9, color: 'inherit', cursor: 'pointer', padding: '9px 13px' };

const statusText: Record<ProjectLaneSnapshot['status'], string> = { cancelled: '已停止', completed: '已完成', failed: '失败', idle: '待命', queued: '排队', running: '运行中' };

const LaneCard = ({ lane }: { lane: ProjectLaneSnapshot }) => {
  const [prompt, setPrompt] = useState('');
  const busy = lane.status === 'running' || lane.status === 'queued';
  return (
    <article style={{ ...card, display: 'grid', gap: 12 }}>
      <header style={{ alignItems: 'flex-start', display: 'flex', gap: 12, justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 16 }}>{lane.name}</strong>
          <div style={{ fontSize: 12, marginTop: 3, opacity: .55, overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.agentId}</div>
        </div>
        <span style={{ border: '1px solid rgba(127,127,127,.2)', borderRadius: 99, fontSize: 12, padding: '4px 9px' }}>{statusText[lane.status]}</span>
      </header>
      <div style={{ display: 'grid', fontSize: 12, gap: 4, opacity: .65 }}>
        <span>独占 Topic：{lane.topicId || '首次运行时自动创建'}</span><span>队列：{lane.pending} · 更新：{new Date(lane.updatedAt).toLocaleString()}</span>
      </div>
      <textarea rows={5} placeholder="给这个项目下达下一项任务。连续提交会在本项目内严格串行；其他项目同时并发。" style={{ ...input, resize: 'vertical' }} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const value = prompt.trim(); if (value) { setPrompt(''); void smartWorkbenchLaneManager.enqueue(lane.id, value).catch(() => undefined); } } }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button style={button} type="button" onClick={() => { const value = prompt.trim(); if (!value) return; setPrompt(''); void smartWorkbenchLaneManager.enqueue(lane.id, value).catch(() => undefined); }}>执行任务</button>
        {busy && <button style={button} type="button" onClick={() => smartWorkbenchLaneManager.cancel(lane.id)}>仅停止此项目</button>}
        <button style={button} type="button" onClick={() => { const next = window.prompt('项目新名称', lane.name); if (next) smartWorkbenchLaneManager.renameLane(lane.id, next); }}>重命名</button>
        <button style={button} type="button" onClick={() => smartWorkbenchLaneManager.clearLogs(lane.id)}>清日志</button>
        {!busy && <button style={button} type="button" onClick={() => { if (window.confirm(`删除项目“${lane.name}”？`)) smartWorkbenchLaneManager.removeLane(lane.id); }}>删除</button>}
      </div>
      <details open={busy}>
        <summary style={{ cursor: 'pointer', fontSize: 13, opacity: .75 }}>运行日志 · {lane.logs.length}</summary>
        <div style={{ background: 'rgba(0,0,0,.2)', borderRadius: 9, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 11, lineHeight: 1.65, marginTop: 8, maxHeight: 220, overflow: 'auto', padding: 10 }}>
          {lane.logs.length === 0 ? <div style={{ opacity: .4 }}>暂无日志</div> : lane.logs.slice(-60).map((log, i) => <div key={`${log.at}-${i}`} style={{ opacity: log.level === 'error' ? 1 : .72 }}>{new Date(log.at).toLocaleTimeString()} · {log.message}</div>)}
        </div>
      </details>
    </article>
  );
};

const SmartWorkbenchRoute = () => {
  const [lanes, setLanes] = useState<ProjectLaneSnapshot[]>([]);
  const [agents, setAgents] = useState<AvailableAgentItem[]>([]);
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [query, setQuery] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(true);

  useEffect(() => smartWorkbenchLaneManager.subscribe(setLanes), []);
  useEffect(() => { let alive = true; setLoadingAgents(true); void agentService.queryAgents({ limit: 100 }).then((items) => { if (alive) setAgents(items); }).catch(() => undefined).finally(() => { if (alive) setLoadingAgents(false); }); return () => { alive = false; }; }, []);

  const stats = useMemo(() => ({ failed: lanes.filter((x) => x.status === 'failed').length, running: lanes.filter((x) => x.status === 'running' || x.status === 'queued').length, total: lanes.length }), [lanes]);
  const visible = useMemo(() => { const q = query.trim().toLowerCase(); return q ? lanes.filter((x) => `${x.name} ${x.agentId} ${x.status}`.toLowerCase().includes(q)) : lanes; }, [lanes, query]);

  const create = () => {
    const n = name.trim(); const a = agentId.trim(); if (!n || !a) return;
    smartWorkbenchLaneManager.createLane({ agentId: a, id: crypto.randomUUID(), name: n }); setName(''); setAgentId('');
  };

  return (
    <main style={{ boxSizing: 'border-box', display: 'grid', gap: 18, margin: '0 auto', maxWidth: 1540, minHeight: '100dvh', padding: 24, width: '100%' }}>
      <header style={{ alignItems: 'end', display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'space-between' }}>
        <div><h1 style={{ fontSize: 28, margin: 0 }}>智能工作台</h1><div style={{ marginTop: 6, opacity: .62 }}>项目全程独占上下文 · 项目内串行 · 项目间真正并发 · 独立停止 · 自动恢复</div></div>
        <div style={{ display: 'flex', gap: 8 }}><span style={card}>项目 {stats.total}</span><span style={card}>并发 {stats.running}</span><span style={card}>异常 {stats.failed}</span></div>
      </header>

      <section style={{ ...card, display: 'grid', gap: 12 }}>
        <strong>新建项目</strong>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(180px,1fr) minmax(260px,1.5fr) auto' }}>
          <input placeholder="项目名称" style={input} value={name} onChange={(e) => setName(e.target.value)} />
          <select style={input} value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">{loadingAgents ? '正在读取 Agent…' : '选择 LobeHub Agent'}</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.title || a.name || a.id}{a.description ? ` — ${a.description.slice(0, 48)}` : ''}</option>)}</select>
          <button style={button} type="button" onClick={create}>创建独占通道</button>
        </div>
        {!loadingAgents && agents.length === 0 && <div style={{ fontSize: 12, opacity: .55 }}>未读取到 Agent。请先在 LobeHub 创建 Agent，再回到工作台。</div>}
      </section>

      <section style={{ display: 'flex', gap: 10 }}><input placeholder="搜索项目 / Agent / 状态" style={{ ...input, maxWidth: 420 }} value={query} onChange={(e) => setQuery(e.target.value)} /><button style={button} type="button" onClick={() => setQuery('')}>清除</button></section>

      {visible.length === 0 ? <section style={{ ...card, padding: 42, textAlign: 'center', opacity: .58 }}>{lanes.length ? '没有匹配的项目' : '还没有项目。选择一个 Agent 创建第一个独占执行通道。'}</section> : <section style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(390px,1fr))' }}>{visible.map((lane) => <LaneCard key={lane.id} lane={lane} />)}</section>}
    </main>
  );
};

export default SmartWorkbenchRoute;
