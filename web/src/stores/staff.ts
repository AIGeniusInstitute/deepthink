/**
 * Staff collaboration store — digital employees + teams + tasks + blackboard.
 * Zustand store mirroring the collaborations.ts pattern: apiFetch + actions.
 */
import { create } from 'zustand';
import { api } from '../api/client';

// --- Types ---

export interface StaffEmployee {
  id: string;
  owner_user_id: string;
  name: string;
  role: string;
  department: string;
  avatar_emoji: string;
  persona_prompt: string;
  model: string;
  skills_json: string;
  knowledge_bases_json: string;
  tools_json: string;
  agent_definition_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  // helper getters
  skills?: string[];
  knowledgeBases?: string[];
  tools?: string[];
}

export interface StaffTeam {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  memberCount?: number;
  taskStats?: {
    total: number;
    pending: number;
    in_progress: number;
    review: number;
    done: number;
    rework: number;
  };
}

export interface StaffTeamMember {
  team_id: string;
  employee_id: string;
  role: string;
  added_at: string;
  added_by: string;
  employee?: StaffEmployee | null;
}

export interface StaffTeamTask {
  id: string;
  team_id: string;
  title: string;
  description: string;
  assignee_employee_id: string | null;
  status: string;
  priority: string;
  parent_task_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  assignee?: StaffEmployee | null;
  events?: StaffTeamEvent[];
}

export interface StaffBlackboardEntry {
  id: string;
  team_id: string;
  content: string;
  tags_json: string;
  source_employee_id: string | null;
  source_task_id: string | null;
  pinned: number;
  archived: number;
  created_at: string;
  employee?: StaffEmployee | null;
}

export interface StaffTeamEvent {
  id: number;
  team_id: string;
  task_id: string | null;
  employee_id: string | null;
  event_type: string;
  payload_json: string;
  actor_user_id: string;
  created_at: string;
}

export interface StaffDashboard {
  employeeCount: number;
  teamCount: number;
  taskStats: {
    total: number;
    pending: number;
    in_progress: number;
    review: number;
    done: number;
    rework: number;
  };
}

// helpers
export function parseJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// --- Store ---

interface StaffState {
  employees: StaffEmployee[];
  teams: StaffTeam[];
  currentTeam: StaffTeam | null;
  currentTeamMembers: StaffTeamMember[];
  currentTeamTasks: StaffTeamTask[];
  currentTeamBlackboard: StaffBlackboardEntry[];
  dashboard: StaffDashboard | null;
  loading: boolean;
  error: string | null;

  // Employee actions
  loadEmployees: (includeInactive?: boolean) => Promise<void>;
  createEmployee: (input: {
    name: string; role: string; department?: string; avatarEmoji?: string;
    personaPrompt?: string; model?: string; skills?: string[];
    knowledgeBases?: string[]; tools?: string[];
  }) => Promise<StaffEmployee | null>;
  updateEmployee: (id: string, fields: Record<string, unknown>) => Promise<void>;
  deleteEmployee: (id: string) => Promise<void>;

  // Team actions
  loadTeams: () => Promise<void>;
  createTeam: (name: string, description?: string) => Promise<StaffTeam | null>;
  loadTeamDetail: (id: string) => Promise<void>;
  addTeamMember: (teamId: string, employeeId: string, role: string) => Promise<void>;
  removeTeamMember: (teamId: string, employeeId: string) => Promise<void>;

  // Task actions
  createTask: (teamId: string, input: {
    title: string; description?: string; assigneeId?: string | null;
    priority?: string;
  }) => Promise<void>;
  updateTaskStatus: (teamId: string, taskId: string, status: string) => Promise<boolean>;

  // Blackboard actions
  createBlackboardEntry: (teamId: string, content: string, tags?: string[]) => Promise<void>;
  updateBlackboardEntry: (teamId: string, entryId: string, fields: {
    pinned?: boolean; archived?: boolean;
  }) => Promise<void>;

  // Dashboard
  loadDashboard: () => Promise<void>;
}

export const useStaffStore = create<StaffState>((set, get) => ({
  employees: [],
  teams: [],
  currentTeam: null,
  currentTeamMembers: [],
  currentTeamTasks: [],
  currentTeamBlackboard: [],
  dashboard: null,
  loading: false,
  error: null,

  loadEmployees: async (includeInactive) => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ employees: StaffEmployee[] }>(
        `/api/staff/employees${includeInactive ? '?includeInactive=1' : ''}`,
      );
      set({ employees: data.employees, loading: false });
    } catch (e: unknown) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  createEmployee: async (input) => {
    try {
      const data = await api.post<{ employee: StaffEmployee }>('/api/staff/employees', input);
      set({ employees: [data.employee, ...get().employees] });
      return data.employee;
    } catch (e: unknown) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  updateEmployee: async (id, fields) => {
    try {
      const data = await api.put<{ employee: StaffEmployee }>(`/api/staff/employees/${id}`, fields);
      set({
        employees: get().employees.map((e) => (e.id === id ? data.employee : e)),
      });
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },

  deleteEmployee: async (id) => {
    try {
      await api.delete(`/api/staff/employees/${id}`);
      set({ employees: get().employees.filter((e) => e.id !== id) });
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },

  loadTeams: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ teams: StaffTeam[] }>('/api/staff/teams');
      set({ teams: data.teams, loading: false });
    } catch (e: unknown) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  createTeam: async (name, description) => {
    try {
      const data = await api.post<{ team: StaffTeam }>('/api/staff/teams', { name, description });
      set({ teams: [data.team, ...get().teams] });
      return data.team;
    } catch (e: unknown) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  loadTeamDetail: async (id) => {
    set({ loading: true, error: null });
    try {
      const [teamRes, tasksRes, bbRes] = await Promise.all([
        api.get<{ team: StaffTeam; members: StaffTeamMember[] }>(`/api/staff/teams/${id}`),
        api.get<{ tasks: StaffTeamTask[] }>(`/api/staff/teams/${id}/tasks`),
        api.get<{ entries: StaffBlackboardEntry[] }>(`/api/staff/teams/${id}/blackboard`),
      ]);
      set({
        currentTeam: teamRes.team,
        currentTeamMembers: teamRes.members,
        currentTeamTasks: tasksRes.tasks,
        currentTeamBlackboard: bbRes.entries,
        loading: false,
      });
    } catch (e: unknown) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  addTeamMember: async (teamId, employeeId, role) => {
    try {
      await api.post(`/api/staff/teams/${teamId}/members`, { employeeId, role });
      await get().loadTeamDetail(teamId);
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },

  removeTeamMember: async (teamId, employeeId) => {
    try {
      await api.delete(`/api/staff/teams/${teamId}/members/${employeeId}`);
      await get().loadTeamDetail(teamId);
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },

  createTask: async (teamId, input) => {
    try {
      await api.post(`/api/staff/teams/${teamId}/tasks`, input);
      await get().loadTeamDetail(teamId);
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },

  updateTaskStatus: async (teamId, taskId, status) => {
    try {
      await api.patch(`/api/staff/teams/${teamId}/tasks/${taskId}/status`, { status });
      await get().loadTeamDetail(teamId);
      return true;
    } catch (e: unknown) {
      set({ error: (e as Error).message });
      return false;
    }
  },

  createBlackboardEntry: async (teamId, content, tags) => {
    try {
      await api.post(`/api/staff/teams/${teamId}/blackboard`, { content, tags });
      await get().loadTeamDetail(teamId);
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },

  updateBlackboardEntry: async (teamId, entryId, fields) => {
    try {
      await api.patch(`/api/staff/teams/${teamId}/blackboard/${entryId}`, fields);
      await get().loadTeamDetail(teamId);
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },

  loadDashboard: async () => {
    try {
      const data = await api.get<StaffDashboard>('/api/staff/dashboard');
      set({ dashboard: data });
    } catch (e: unknown) {
      set({ error: (e as Error).message });
    }
  },
}));
