export interface TimelineNode {
  id: string;
  kind: 'step' | 'agent' | 'check';
  stage: 'requirements' | 'product' | 'development' | 'testing' | null;
  attempt: number | null;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'waiting' | 'suspended' | 'cancelled';
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  tools: string[];
  files: string[];
  modelSteps?: number;
  check?: { id: string; exitCode: number | null };
}

export interface RunTimelineDocument {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  nodes: TimelineNode[];
  tools: string[];
  files: string[];
}
