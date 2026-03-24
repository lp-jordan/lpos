'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Project } from '@/lib/models/project';

export type { Project };

export interface UseProjectsResult {
  projects: Project[];
  loading: boolean;
  createProject: (input: { name: string; clientName: string; owner?: string }) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const socketRef = useRef<Socket | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json() as { projects: Project[] };
      setProjects(data.projects ?? []);
    } catch {
      // silently fail — empty state is acceptable
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + socket subscription for real-time updates
  useEffect(() => {
    fetchProjects();

    const socket = io('/', { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('projects:changed', (updated: Project[]) => {
      setProjects(updated);
    });

    return () => { socket.disconnect(); };
  }, [fetchProjects]);

  const createProject = useCallback(async (input: { name: string; clientName: string; owner?: string }): Promise<Project> => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json() as { error?: string };
      throw new Error(err.error ?? 'Failed to create project');
    }
    const data = await res.json() as { project: Project };
    return data.project;
  }, []);

  const deleteProject = useCallback(async (projectId: string): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete project');
  }, []);

  return { projects, loading, createProject, deleteProject };
}
