import React, { createContext, useCallback, useContext, useRef } from "react";

export interface BackgroundJob {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'stopped' | 'completed';
  progress?: number;
  messages: string[];
  startTime: number;
}

interface BackgroundTaskContextType {
  listJobs: () => BackgroundJob[];
  startJob: (name: string) => string;
  pauseJob: (id: string) => void;
  resumeJob: (id: string) => void;
  stopJob: (id: string) => void;
  updateJobProgress: (id: string, progress: number) => void;
  addJobMessage: (id: string, message: string) => void;
}

const BackgroundTaskContext = createContext<BackgroundTaskContextType>({
  listJobs: () => [],
  startJob: () => "",
  pauseJob: () => { },
  resumeJob: () => { },
  stopJob: () => { },
  updateJobProgress: () => { },
  addJobMessage: () => { }
});
export const BackgroundTaskProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const jobsRef = useRef<BackgroundJob[]>([]);

  const startJob = useCallback((name: string) => {
    const id = crypto.randomUUID();
    jobsRef.current = [...jobsRef.current, {
      id,
      name,
      status: 'running',
      messages: [],
      startTime: Date.now()
    }];
    return id;
  }, []);

  const pauseJob = useCallback((id: string) => {
    jobsRef.current = jobsRef.current.map(job =>
      job.id === id ? { ...job, status: 'paused' } : job
    );
  }, []);

  const resumeJob = useCallback((id: string) => {
    jobsRef.current = jobsRef.current.map(job =>
      job.id === id ? { ...job, status: 'running' } : job
    );
  }, []);

  const stopJob = useCallback((id: string) => {
    jobsRef.current = jobsRef.current.map(job =>
      job.id === id ? { ...job, status: 'stopped' } : job
    );
  }, []);

  const updateJobProgress = useCallback((id: string, progress: number) => {
    jobsRef.current = jobsRef.current.map(job =>
      job.id === id ? { ...job, progress } : job
    );
  }, []);

  const addJobMessage = useCallback((id: string, message: string) => {
    jobsRef.current = jobsRef.current.map(job =>
      job.id === id ? { ...job, messages: [...job.messages, message] } : job
    );
  }, []);

  const listJobs = useCallback(() => {
    return jobsRef.current;
  }, []);

  return (
    <BackgroundTaskContext.Provider value={{
      listJobs,
      startJob,
      pauseJob,
      resumeJob,
      stopJob,
      updateJobProgress,
      addJobMessage
    }}>
      {children}
    </BackgroundTaskContext.Provider>
  );
};

export const useBackgroundTasks = () => useContext(BackgroundTaskContext);
