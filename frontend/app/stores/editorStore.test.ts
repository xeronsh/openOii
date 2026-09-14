import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '~/stores/editorStore';

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

  it('resetRunState clears run fields without touching data', () => {
    const store = useEditorStore.getState();
    store.setGenerating(true);
    store.setCurrentAgent('plan');
    store.setProgress(0.5);
    store.setCurrentRunId(42);
    store.setAwaitingConfirm(true, 'plan', 42);
    store.setHighlightedMessage(3);

    store.resetRunState();

    const s = useEditorStore.getState();
    expect(s.isGenerating).toBe(false);
    expect(s.currentAgent).toBeNull();
    expect(s.progress).toBe(0);
    expect(s.currentRunId).toBeNull();
    expect(s.awaitingConfirm).toBe(false);
    expect(s.awaitingAgent).toBeNull();
    // 画布/消息选中是客户端自有状态，resetRunState 不碰它
    expect(s.highlightedMessageIndex).toBe(3);
    expect(s.currentStage).toBe('plan');
  });
});
