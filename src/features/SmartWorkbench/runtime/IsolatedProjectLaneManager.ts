'use client';

import type { ConversationContext } from '@lobechat/types';

import { agentService } from '@/services/agent';
import { getAgentStoreState } from '@/store/agent';
import { useChatStore } from '@/store/chat';

export type LaneStatus = 'idle' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface LaneLogEntry {
  at: number;
  level: 'info' | 'error';
  message: string;
}

export interface ProjectLaneSnapshot {
  agentId: string;
  createdAt: number;
  id: string;
  logs: LaneLogEntry[];
  name: string;
  pending: number;
  status: LaneStatus;
  topicId?: string | null;
  updatedAt: number;
}

interface LaneTask {
  id: string;
  prompt: string;
  reject: (error: unknown) => void;
  resolve: () => void;
}

interface ProjectLane extends ProjectLaneSnapshot {
  context: ConversationContext;
  draining: boolean;
  queue: LaneTask[];
}

interface PersistedLane {
  agentId: string;
  createdAt: number;
  id: string;
  logs: LaneLogEntry[];
  name: string;
  status: LaneStatus;
  topicId?: string | null;
  updatedAt: number;
}

type Listener = (lanes: ProjectLaneSnapshot[]) => void;

const STORAGE_KEY = 'lobehub-smart-workbench:v1';

const cloneLane = (lane: ProjectLane): ProjectLaneSnapshot => ({
  agentId: lane.agentId,
  createdAt: lane.createdAt,
  id: lane.id,
  logs: [...lane.logs],
  name: lane.name,
  pending: lane.queue.length,
  status: lane.status,
  topicId: lane.context.topicId,
  updatedAt: lane.updatedAt,
});

/** Project-level execution isolation for Smart Workbench. */
export class IsolatedProjectLaneManager {
  private hydrated = false;
  private readonly lanes = new Map<string, ProjectLane>();
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.hydrate();
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): ProjectLaneSnapshot[] =>
    [...this.lanes.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(cloneLane);

  createLane = ({ id, name, agentId }: { id: string; name: string; agentId: string }) => {
    this.hydrate();
    if (this.lanes.has(id)) throw new Error(`Project lane already exists: ${id}`);
    const now = Date.now();
    const context: ConversationContext = { agentId, isNew: true, isolatedTopic: true, scope: 'main', topicId: null };
    this.lanes.set(id, {
      agentId,
      context,
      createdAt: now,
      draining: false,
      id,
      logs: [{ at: now, level: 'info', message: 'Project lane created' }],
      name,
      pending: 0,
      queue: [],
      status: 'idle',
      updatedAt: now,
    });
    this.emit();
  };

  renameLane = (id: string, name: string) => {
    const lane = this.requireLane(id);
    const next = name.trim();
    if (!next) return;
    lane.name = next;
    lane.updatedAt = Date.now();
    this.log(lane, `Project renamed: ${next}`);
    this.emit();
  };

  removeLane = (id: string) => {
    const lane = this.requireLane(id);
    if (lane.draining || lane.queue.length > 0) throw new Error('Cannot remove a running lane');
    this.lanes.delete(id);
    this.emit();
  };

  clearLogs = (id: string) => {
    const lane = this.requireLane(id);
    lane.logs = [];
    lane.updatedAt = Date.now();
    this.emit();
  };

  enqueue = (id: string, prompt: string): Promise<void> => {
    const lane = this.requireLane(id);
    const text = prompt.trim();
    if (!text) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      lane.queue.push({ id: crypto.randomUUID(), prompt: text, reject, resolve });
      lane.status = lane.draining ? 'running' : 'queued';
      lane.updatedAt = Date.now();
      this.log(lane, `Queued: ${text.slice(0, 120)}`);
      this.emit();
      void this.drain(lane);
    });
  };

  cancel = (id: string) => {
    const lane = this.requireLane(id);
    useChatStore.getState().cancelSendMessageInServer(lane.context);
    const queued = lane.queue.splice(0);
    for (const task of queued) task.reject(new DOMException('Project lane cancelled', 'AbortError'));
    lane.status = 'cancelled';
    lane.updatedAt = Date.now();
    this.log(lane, 'Cancellation requested for this project lane only');
    this.emit();
  };

  private hydrate() {
    if (this.hydrated || typeof window === 'undefined') return;
    this.hydrated = true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as PersistedLane[];
      for (const item of saved) {
        const status: LaneStatus = item.status === 'running' || item.status === 'queued' ? 'idle' : item.status;
        this.lanes.set(item.id, {
          ...item,
          context: {
            agentId: item.agentId,
            isNew: !item.topicId,
            isolatedTopic: true,
            scope: 'main',
            topicId: item.topicId ?? null,
          },
          draining: false,
          logs: item.logs.slice(-200),
          pending: 0,
          queue: [],
          status,
        });
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }

  private persist() {
    if (typeof window === 'undefined') return;
    const data: PersistedLane[] = [...this.lanes.values()].map((lane) => ({
      agentId: lane.agentId,
      createdAt: lane.createdAt,
      id: lane.id,
      logs: lane.logs.slice(-200),
      name: lane.name,
      status: lane.status,
      topicId: lane.context.topicId,
      updatedAt: lane.updatedAt,
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  private async drain(lane: ProjectLane) {
    if (lane.draining) return;
    lane.draining = true;
    try {
      await this.ensureAgentLoaded(lane.agentId);
      while (lane.queue.length > 0) {
        const task = lane.queue.shift()!;
        lane.status = 'running';
        lane.updatedAt = Date.now();
        this.log(lane, `Running: ${task.prompt.slice(0, 120)}`);
        this.emit();
        try {
          const result = await useChatStore.getState().sendMessage({
            context: lane.context,
            message: task.prompt,
            onTopicCreated: (topicId) => {
              lane.context = { ...lane.context, isNew: false, topicId };
              lane.updatedAt = Date.now();
              this.log(lane, `Topic bound: ${topicId}`);
              this.emit();
            },
          });
          if (result?.createdTopicId && lane.context.topicId !== result.createdTopicId) {
            lane.context = { ...lane.context, isNew: false, topicId: result.createdTopicId };
          }
          task.resolve();
          lane.updatedAt = Date.now();
          this.log(lane, 'Task completed');
        } catch (error) {
          const aborted = error instanceof Error && error.name === 'AbortError';
          lane.status = aborted ? 'cancelled' : 'failed';
          lane.updatedAt = Date.now();
          this.log(lane, error instanceof Error ? error.message : String(error), 'error');
          task.reject(error);
          if (!aborted) throw error;
        }
      }
      if (lane.status !== 'cancelled' && lane.status !== 'failed') lane.status = 'completed';
    } finally {
      lane.draining = false;
      lane.pending = lane.queue.length;
      lane.updatedAt = Date.now();
      this.emit();
    }
  }

  private async ensureAgentLoaded(agentId: string) {
    const agentStore = getAgentStoreState();
    if (agentStore.agentMap[agentId]) return;
    const config = await agentService.getAgentConfigById(agentId);
    if (!config) throw new Error(`Agent not found: ${agentId}`);
    getAgentStoreState().internal_dispatchAgentMap(agentId, config);
  }

  private requireLane(id: string) {
    this.hydrate();
    const lane = this.lanes.get(id);
    if (!lane) throw new Error(`Unknown project lane: ${id}`);
    return lane;
  }

  private log(lane: ProjectLane, message: string, level: LaneLogEntry['level'] = 'info') {
    lane.logs.push({ at: Date.now(), level, message });
    if (lane.logs.length > 200) lane.logs.splice(0, lane.logs.length - 200);
    lane.pending = lane.queue.length;
  }

  private emit() {
    this.persist();
    const next = this.snapshot();
    for (const listener of this.listeners) listener(next);
  }
}

export const smartWorkbenchLaneManager = new IsolatedProjectLaneManager();
