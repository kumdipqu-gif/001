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
  id: string;
  name: string;
  pending: number;
  status: LaneStatus;
  topicId?: string | null;
  logs: LaneLogEntry[];
}

interface LaneTask {
  id: string;
  prompt: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ProjectLane extends ProjectLaneSnapshot {
  context: ConversationContext;
  draining: boolean;
  queue: LaneTask[];
}

type Listener = (lanes: ProjectLaneSnapshot[]) => void;

const cloneLane = (lane: ProjectLane): ProjectLaneSnapshot => ({
  agentId: lane.agentId,
  id: lane.id,
  logs: [...lane.logs],
  name: lane.name,
  pending: lane.queue.length,
  status: lane.status,
  topicId: lane.context.topicId,
});

/**
 * Project-level execution isolation for Smart Workbench.
 *
 * Invariants:
 * - One project lane owns one ConversationContext for its full lifecycle.
 * - Tasks inside the same lane are strictly serial.
 * - Different lanes drain independently and therefore execute concurrently.
 * - Cancellation is scoped to the lane context, never to global active chat state.
 */
export class IsolatedProjectLaneManager {
  private readonly lanes = new Map<string, ProjectLane>();
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): ProjectLaneSnapshot[] => [...this.lanes.values()].map(cloneLane);

  createLane = ({ id, name, agentId }: { id: string; name: string; agentId: string }) => {
    if (this.lanes.has(id)) throw new Error(`Project lane already exists: ${id}`);

    const context: ConversationContext = {
      agentId,
      isNew: true,
      isolatedTopic: true,
      scope: 'main',
      topicId: null,
    };

    this.lanes.set(id, {
      agentId,
      context,
      draining: false,
      id,
      logs: [],
      name,
      pending: 0,
      queue: [],
      status: 'idle',
    });
    this.emit();
  };

  removeLane = (id: string) => {
    const lane = this.requireLane(id);
    if (lane.draining || lane.queue.length > 0) throw new Error('Cannot remove a running lane');
    this.lanes.delete(id);
    this.emit();
  };

  enqueue = (id: string, prompt: string): Promise<void> => {
    const lane = this.requireLane(id);
    const text = prompt.trim();
    if (!text) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      lane.queue.push({ id: crypto.randomUUID(), prompt: text, reject, resolve });
      lane.status = lane.draining ? 'running' : 'queued';
      this.log(lane, `Queued task (${lane.queue.length})`);
      this.emit();
      void this.drain(lane);
    });
  };

  cancel = (id: string) => {
    const lane = this.requireLane(id);
    const store = useChatStore.getState();

    // Cancel the send root for this exact conversation context. Child runtime
    // operations inherit the same context and cancellation propagates through
    // the operation tree.
    store.cancelSendMessageInServer(lane.context);

    const queued = lane.queue.splice(0);
    for (const task of queued) task.reject(new DOMException('Project lane cancelled', 'AbortError'));

    lane.status = 'cancelled';
    this.log(lane, 'Cancellation requested for this project lane only');
    this.emit();
  };

  private async drain(lane: ProjectLane) {
    if (lane.draining) return;
    lane.draining = true;

    try {
      await this.ensureAgentLoaded(lane.agentId);

      while (lane.queue.length > 0) {
        const task = lane.queue.shift()!;
        lane.status = 'running';
        this.log(lane, `Running: ${task.prompt.slice(0, 80)}`);
        this.emit();

        try {
          const result = await useChatStore.getState().sendMessage({
            context: lane.context,
            message: task.prompt,
            onTopicCreated: (topicId) => {
              lane.context = {
                ...lane.context,
                isNew: false,
                topicId,
              };
              this.log(lane, `Topic bound: ${topicId}`);
              this.emit();
            },
          });

          if (result?.createdTopicId && lane.context.topicId !== result.createdTopicId) {
            lane.context = {
              ...lane.context,
              isNew: false,
              topicId: result.createdTopicId,
            };
          }

          task.resolve();
          this.log(lane, 'Task completed');
        } catch (error) {
          const aborted = error instanceof Error && error.name === 'AbortError';
          lane.status = aborted ? 'cancelled' : 'failed';
          this.log(lane, error instanceof Error ? error.message : String(error), 'error');
          task.reject(error);
          if (!aborted) throw error;
        }
      }

      if (lane.status !== 'cancelled' && lane.status !== 'failed') lane.status = 'completed';
    } finally {
      lane.draining = false;
      lane.pending = lane.queue.length;
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
    const next = this.snapshot();
    for (const listener of this.listeners) listener(next);
  }
}

export const smartWorkbenchLaneManager = new IsolatedProjectLaneManager();
