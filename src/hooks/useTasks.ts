// src/hooks/useTasks.ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DerivedTask, Metrics, Task } from '@/types';
import {
  computeAverageROI,
  computePerformanceGrade,
  computeRevenuePerHour,
  computeTimeEfficiency,
  computeTotalRevenue,
  withDerived,
} from '@/utils/logic';
// Local storage removed per request; keep everything in memory
import { generateSalesTasks } from '@/utils/seed';

interface UseTasksState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  derivedSorted: DerivedTask[];
  metrics: Metrics;
  lastDeleted: { task: Task; index: number } | null;
  addTask: (task: Omit<Task, 'id'> & { id?: string }) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  undoDelete: () => void;
  dismissUndo: () => void;
}

const INITIAL_METRICS: Metrics = {
  totalRevenue: 0,
  totalTimeTaken: 0,
  timeEfficiencyPct: 0,
  revenuePerHour: 0,
  averageROI: 0,
  performanceGrade: 'Needs Improvement',
};

// helper: priority rank
const priorityRank = (p: Task['priority']) => (p === 'High' ? 3 : p === 'Medium' ? 2 : 1);

// stable sort (ROI desc, priority desc, createdAt desc, title asc, id asc)
function stableSort(tasks: DerivedTask[]): DerivedTask[] {
  return [...tasks].sort((a, b) => {
    if (a.roi !== b.roi) return b.roi - a.roi;
    const pa = priorityRank(a.priority);
    const pb = priorityRank(b.priority);
    if (pa !== pb) return pb - pa;
    // createdAt: newer first
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.title !== b.title) return a.title.localeCompare(b.title);
    return a.id.localeCompare(b.id);
  });
}

export function useTasks(): UseTasksState {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // store lastDeleted with its original index so undo can restore position
  const [lastDeleted, setLastDeleted] = useState<{ task: Task; index: number } | null>(null);

  // StrictMode-safe guard
  const initRef = useRef(false);

  function normalizeTasks(input: any[]): Task[] {
    const now = Date.now();
    const seen = new Set<string>();
    return (Array.isArray(input) ? input : []).map((t, idx) => {
      const created = t?.createdAt ? new Date(t.createdAt) : new Date(now - (idx + 1) * 24 * 3600 * 1000);
      const completed = t?.completedAt || (t?.status === 'Done' ? new Date(created.getTime() + 24 * 3600 * 1000).toISOString() : undefined);

      // generate/repair id
      let id: string = typeof t?.id === 'string' && t.id ? t.id : (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      if (seen.has(id)) {
        id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
      seen.add(id);

      const revenueRaw = Number(t?.revenue);
      const revenue = Number.isFinite(revenueRaw) && revenueRaw >= 0 ? revenueRaw : 0;
      const timeTaken = Number(t?.timeTaken) > 0 ? Number(t.timeTaken) : 1;
      const title = (typeof t?.title === 'string' && t.title.trim()) ? t.title.trim() : `Untitled ${idx + 1}`;
      const priority = (t?.priority === 'High' || t?.priority === 'Medium' || t?.priority === 'Low') ? t.priority : 'Medium';
      const status = (t?.status === 'Done' || t?.status === 'Todo' || t?.status === 'InProgress') ? t.status : (t?.status ?? 'Todo');

      return {
        id,
        title,
        revenue,
        timeTaken,
        priority,
        status,
        notes: t?.notes ?? '',
        createdAt: created.toISOString(),
        completedAt: completed,
      } as Task;
    });
  }

  // Initial load: run once and sanitize
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    let mounted = true;
    (async () => {
      try {
        const res = await fetch('/tasks.json');
        if (!res.ok) throw new Error(`Failed to load tasks.json (${res.status})`);
        const data = (await res.json()) as any[];
        const normalized = normalizeTasks(data);
        const finalData = normalized.length > 0 ? normalized : generateSalesTasks(50);

        if (!mounted) return;

        setTasks(finalData);
        setError(null);
      } catch (e: any) {
        if (!mounted) return;
        setError(e?.message ?? 'Failed to load tasks');
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, []);

  // derived + stable sort
  const derivedSorted = useMemo<DerivedTask[]>(() => {
    const withRoi = tasks.map(withDerived);
    return stableSort(withRoi);
  }, [tasks]);

  // metrics
  const metrics = useMemo<Metrics>(() => {
    if (tasks.length === 0) return INITIAL_METRICS;
    const totalRevenue = computeTotalRevenue(tasks);
    const totalTimeTaken = tasks.reduce((s, t) => s + t.timeTaken, 0);
    const timeEfficiencyPct = computeTimeEfficiency(tasks);
    const revenuePerHour = computeRevenuePerHour(tasks);
    const averageROI = computeAverageROI(tasks);
    const performanceGrade = computePerformanceGrade(averageROI);
    return { totalRevenue, totalTimeTaken, timeEfficiencyPct, revenuePerHour, averageROI, performanceGrade };
  }, [tasks]);

  // addTask (safe sanitization)
  const addTask = useCallback((task: Omit<Task, 'id'> & { id?: string }) => {
    setTasks(prev => {
      const id = task.id ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const title = (task.title?.toString().trim() || 'Untitled Task');
      const revenue = Number.isFinite(Number(task.revenue)) && Number(task.revenue) >= 0 ? Number(task.revenue) : 0;
      const timeTaken = Number(task.timeTaken) > 0 ? Number(task.timeTaken) : 1;
      const priority = (task.priority === 'High' || task.priority === 'Medium' || task.priority === 'Low') ? task.priority : 'Medium';
      const status = (task.status === 'Done' || task.status === 'Todo' || task.status === 'InProgress') ? task.status : 'Todo';
      const createdAt = new Date().toISOString();
      const completedAt = status === 'Done' ? createdAt : undefined;

      const newTask: Task = { id, title, revenue, timeTaken, priority, status, notes: task.notes ?? '', createdAt, completedAt };
      return [...prev, newTask];
    });
  }, []);

  // updateTask (sanitize patch before applying)
  const updateTask = useCallback((id: string, patch: Partial<Task>) => {
    setTasks(prev => {
      return prev.map(t => {
        if (t.id !== id) return t;
        const merged: Task = { ...t, ...patch };
        merged.revenue = Number.isFinite(Number(merged.revenue)) && Number(merged.revenue) >= 0 ? Number(merged.revenue) : 0;
        merged.timeTaken = Number(merged.timeTaken) > 0 ? Number(merged.timeTaken) : 1;
        if (t.status !== 'Done' && merged.status === 'Done' && !merged.completedAt) {
          merged.completedAt = new Date().toISOString();
        }
        if (!merged.title || !merged.title.trim()) merged.title = t.title || 'Untitled';
        return merged;
      });
    });
  }, []);

  // deleteTask stores deleted task + its index
  const deleteTask = useCallback((id: string) => {
    setTasks(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      // store the deleted task and its index for undo
      setLastDeleted({ task: target, index: idx });
      return next;
    });
  }, []);

  // undoDelete restores at original index if possible
  const undoDelete = useCallback(() => {
    setLastDeleted(prevLast => {
      if (!prevLast) return null;
      setTasks(curr => {
        const idx = Math.min(Math.max(0, prevLast.index), curr.length);
        const copy = [...curr];
        copy.splice(idx, 0, prevLast.task);
        return copy;
      });
      return null;
    });
  }, []);

  // dismissUndo clears the lastDeleted (called by snackbar onExited)
  const dismissUndo = useCallback(() => {
    setLastDeleted(null);
  }, []);

  return {
    tasks,
    loading,
    error,
    derivedSorted,
    metrics,
    lastDeleted,
    addTask,
    updateTask,
    deleteTask,
    undoDelete,
    dismissUndo,
  };
}
