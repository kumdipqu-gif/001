'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  type ProjectLaneSnapshot,
  smartWorkbenchLaneManager,
} from '@/features/SmartWorkbench/runtime/IsolatedProjectLaneManager';

const panel: React.CSSProperties = {
  background: 'rgba(127,127,127,.08)',
  border: '1px solid rgba(127,127,127,.18)',
  borderRadius: 14,
  padding: 16,
};

const inputStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(127,127,127,.28)',
  borderRadius: 8,
  color: 'inherit',
  outline: 'none',
  padding: '9px 10px',
  width: '100%',
};

const buttonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(127,127,127,.35)',
  borderRadius: 8,
  color: 'inherit',
  cursor: 'pointer',
  padding: '8px 12px',
};

const LaneCard = ({ lane }: { lane: ProjectLaneSnapshot }) => {
  const [prompt, setPrompt] = useState('');

  return (
    <section style={{ ...panel, display: 'grid', gap: 12 }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: 10, justifyContent: 'space-between' }}>
        <div>
          <strong>{lane.name}</strong>
          <div style={{ fontSize: 12, opacity: 0.65 }}>{lane.agentId}</div>
        </div>
        <span style={{ fontSize: 12, opacity: 0.8 }}>{lane.status}</span>
      </div>

      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Topic: {lane.topicId || 'new isolated topic'} · Queue: {lane.pending}
      </div>

      <textarea
        rows={4}
        placeholder="输入这个项目下一步要执行的任务"
        style={{ ...inputStyle, resize: 'vertical' }}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          style={buttonStyle}
          type="button"
          onClick={() => {
            const value = prompt.trim();
            if (!value) return;
            setPrompt('');
            void smartWorkbenchLaneManager.enqueue(lane.id, value).catch(() => undefined);
          }}
        >
          加入独占通道
        </button>
        <button style={buttonStyle} type="button" onClick={() => smartWorkbenchLaneManager.cancel(lane.id)}>
          仅停止此项目
        </button>
      </div>

      <div
        style={{
          background: 'rgba(0,0,0,.22)',
          borderRadius: 8,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          maxHeight: 180,
          overflow: 'auto',
          padding: 10,
        }}
      >
        {lane.logs.length === 0 ? (
          <div style={{ opacity: 0.45 }}>暂无运行日志</div>
        ) : (
          lane.logs.slice(-30).map((log) => (
            <div key={`${log.at}-${log.message}`} style={{ opacity: log.level === 'error' ? 1 : 0.72 }}>
              {new Date(log.at).toLocaleTimeString()} · {log.message}
            </div>
          ))
        )}
      </div>
    </section>
  );
};

const SmartWorkbenchRoute = () => {
  const [lanes, setLanes] = useState<ProjectLaneSnapshot[]>([]);
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');

  useEffect(() => smartWorkbenchLaneManager.subscribe(setLanes), []);

  const running = useMemo(
    () => lanes.filter((lane) => lane.status === 'running' || lane.status === 'queued').length,
    [lanes],
  );

  return (
    <main
      style={{
        boxSizing: 'border-box',
        display: 'grid',
        gap: 18,
        margin: '0 auto',
        maxWidth: 1440,
        minHeight: '100dvh',
        padding: 24,
        width: '100%',
      }}
    >
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ fontSize: 26, margin: 0 }}>智能工作台</h1>
        <div style={{ opacity: 0.68 }}>
          项目级独占 ConversationContext；同项目串行，不同项目并行。当前并行通道：{running}
        </div>
      </header>

      <section style={{ ...panel, display: 'grid', gap: 10 }}>
        <strong>创建项目通道</strong>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(180px, 1fr) minmax(260px, 2fr) auto' }}>
          <input placeholder="项目名称" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="LobeHub Agent ID，例如 agt_xxx"
            style={inputStyle}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          />
          <button
            style={buttonStyle}
            type="button"
            onClick={() => {
              const normalizedName = name.trim();
              const normalizedAgentId = agentId.trim();
              if (!normalizedName || !normalizedAgentId) return;
              smartWorkbenchLaneManager.createLane({
                agentId: normalizedAgentId,
                id: crypto.randomUUID(),
                name: normalizedName,
              });
              setName('');
              setAgentId('');
            }}
          >
            新建
          </button>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        {lanes.map((lane) => (
          <LaneCard key={lane.id} lane={lane} />
        ))}
      </section>
    </main>
  );
};

export default SmartWorkbenchRoute;
