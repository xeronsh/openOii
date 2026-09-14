import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '~/stores/editorStore';
import { appQueryClient } from '~/query/client';
import { patchRunState, readRunState, resetRunState } from '~/query/runState';

describe('useEditorStore review contract', () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  it('toggles runMode between manual and yolo', () => {
    expect(useEditorStore.getState().runMode).toBe('manual');
    useEditorStore.getState().setRunMode('yolo');
    expect(useEditorStore.getState().runMode).toBe('yolo');
    useEditorStore.getState().setRunMode('manual');
    expect(useEditorStore.getState().runMode).toBe('manual');
  });
});

describe('run state projection (query cache)', () => {
  beforeEach(() => {
    resetRunState(1);
  });

  it('patches run fields and reads them back', () => {
    patchRunState(1, {
      isGenerating: true,
      currentAgent: 'plan',
      progress: 0.5,
      currentRunId: 42,
      awaitingConfirm: true,
      awaitingAgent: 'plan',
    });

    const s = readRunState(1);
    expect(s.isGenerating).toBe(true);
    expect(s.currentAgent).toBe('plan');
    expect(s.progress).toBe(0.5);
    expect(s.currentRunId).toBe(42);
    expect(s.awaitingConfirm).toBe(true);
    expect(s.awaitingAgent).toBe('plan');
  });

  it('reset clears run fields', () => {
    patchRunState(1, { isGenerating: true, currentRunId: 42, progress: 0.5 });

    resetRunState(1);

    const s = readRunState(1);
    expect(s.isGenerating).toBe(false);
    expect(s.currentRunId).toBeNull();
    expect(s.progress).toBe(0);
  });

  it('keeps the run-state cache scoped per project', () => {
    patchRunState(1, { isGenerating: true, currentRunId: 42 });

    expect(readRunState(2).isGenerating).toBe(false);
    expect(appQueryClient.getQueryData(['run-state', 1])).toMatchObject({
      currentRunId: 42,
    });
  });
});
