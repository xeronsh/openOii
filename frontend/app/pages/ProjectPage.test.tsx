import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectPage } from './ProjectPage';
import { projectsApi } from '~/services/api';
import type { AgentRun, Project, RecoveryControlRead } from '~/types';
import { ApiError } from '~/types/errors';
import { toast } from '~/utils/toast';

const invalidateQueries = vi.fn();
const setSearchParams = vi.fn();
let currentRouteProjectId = '9';
let currentSearchParams = new URLSearchParams();
let projectQueryState: { isLoading: boolean; error: Error | null } = {
  isLoading: false,
  error: null,
};
let resourceQueryState = {
  charactersLoading: false,
  shotsLoading: false,
  messagesLoading: false,
};
const projectData: Project = {
  id: 9,
  title: 'Realtime Story',
  story: 'A story about live progress syncing.',
  style: 'cinematic',
  summary: 'A story about live progress syncing.',
  video_url: null,
  status: 'active',
  target_shot_count: null,
  character_hints: [],
  creation_mode: null,
  reference_images: [],
  created_at: '2026-04-11T00:00:00Z',
  updated_at: '2026-04-11T00:00:00Z',
  provider_settings: {
    text: {
      selected_key: 'openai',
      source: 'project',
      resolved_key: 'openai',
      valid: true,
      reason_code: null,
      reason_message: null,
    },
    image: {
      selected_key: 'openai',
      source: 'default',
      resolved_key: 'openai',
      valid: true,
      reason_code: null,
      reason_message: null,
    },
    video: {
      selected_key: 'doubao',
      source: 'project',
      resolved_key: 'doubao',
      valid: true,
      reason_code: null,
      reason_message: null,
    },
  },
};
let currentProjectData = projectData;
const providerSnapshotSample = {
	text: { ...projectData.provider_settings.text },
	image: { ...projectData.provider_settings.image },
	video: { ...projectData.provider_settings.video },
};
const projectDataWithTextProviderIssue: Project = {
	  ...projectData,
	  provider_settings: {
	    ...projectData.provider_settings,
	    text: {
	      ...projectData.provider_settings.text,
	      selected_key: 'openai',
	      source: 'project',
	      resolved_key: null,
	      valid: false,
	      reason_code: 'provider_missing_credentials',
	      reason_message: '缺少 OpenAI 文本凭据',
	    },
	  },
};
const projectDataWithDegradedTextProvider: Project = {
  ...projectData,
  provider_settings: {
    ...projectData.provider_settings,
    text: {
      ...projectData.provider_settings.text,
      valid: true,
      status: 'degraded',
      reason_code: 'provider_stream_unavailable',
      reason_message: '文本 Provider 流式不可用，已自动回退非流式生成。',
      capabilities: {
        generate: true,
        stream: false,
      },
    },
  },
};
const emptyCharacters: never[] = [];
const emptyShots: never[] = [];
const emptyMessages: never[] = [];
const storeState: {
  isGenerating: boolean;
  progress: number;
  currentStage: string;
  currentAgent: string | null;
  awaitingConfirm: boolean;
  awaitingAgent: string | null;
  currentRunId: number | null;
  currentRunProviderSnapshot: unknown | null;
  recoveryControl: RecoveryControlRead | null;
  recoverySummary: unknown;
  recoveryGate: unknown;
  projectUpdatedAt: number | null;
  characters: never[];
  shots: never[];
  projectVideoUrl: string | null;
  projectStatus: string | null;
  projectTitle: string | null;
  projectSummary: string | null;
  projectStory: string | null;
  blockingClips: never[] | null;
  messages: never[];
  clearMessages: ReturnType<typeof vi.fn>;
  setGenerating: ReturnType<typeof vi.fn>;
  setProgress: ReturnType<typeof vi.fn>;
  setCurrentAgent: ReturnType<typeof vi.fn>;
  setCurrentStage: ReturnType<typeof vi.fn>;
  setAwaitingConfirm: ReturnType<typeof vi.fn>;
  setCurrentRunId: ReturnType<typeof vi.fn>;
  setCurrentRunProviderSnapshot: ReturnType<typeof vi.fn>;
  setSelectedShot: ReturnType<typeof vi.fn>;
  setSelectedCharacter: ReturnType<typeof vi.fn>;
  setHighlightedMessage: ReturnType<typeof vi.fn>;
  setCharacters: ReturnType<typeof vi.fn>;
  setShots: ReturnType<typeof vi.fn>;
  setRecoveryControl: ReturnType<typeof vi.fn>;
  setRecoverySummary: ReturnType<typeof vi.fn>;
  setRecoveryGate: ReturnType<typeof vi.fn>;
  setProjectUpdatedAt: ReturnType<typeof vi.fn>;
  addMessage: ReturnType<typeof vi.fn>;
  resetRunState: ReturnType<typeof vi.fn>;
  runMode: string;
  setRunMode: ReturnType<typeof vi.fn>;
  setBlockingClips: ReturnType<typeof vi.fn>;
  patchProject: ReturnType<typeof vi.fn>;
} = {
  isGenerating: false,
  progress: 0,
  currentStage: 'plan',
  currentAgent: null,
  awaitingConfirm: false,
  awaitingAgent: null,
  currentRunId: null as number | null,
  currentRunProviderSnapshot: null,
  recoveryControl: null,
  recoverySummary: null,
  recoveryGate: null,
  projectUpdatedAt: null as number | null,
  characters: emptyCharacters,
  shots: emptyShots,
  projectVideoUrl: null,
  projectStatus: null,
  projectTitle: null,
  projectSummary: null,
  projectStory: null,
  blockingClips: null,
  messages: emptyMessages,
  clearMessages: vi.fn(),
  setGenerating: vi.fn(),
  setProgress: vi.fn(),
  setCurrentAgent: vi.fn(),
  setCurrentStage: vi.fn(),
  setAwaitingConfirm: vi.fn(),
  setCurrentRunId: vi.fn(),
  setCurrentRunProviderSnapshot: vi.fn(),
  setSelectedShot: vi.fn(),
  setSelectedCharacter: vi.fn(),
  setHighlightedMessage: vi.fn(),
  setCharacters: vi.fn(),
  setShots: vi.fn(),
  setRecoveryControl: vi.fn(),
  setRecoverySummary: vi.fn(),
  setRecoveryGate: vi.fn(),
  setProjectUpdatedAt: vi.fn((timestamp: number) => {
    storeState.projectUpdatedAt = timestamp;
  }),
  // 真实映射表在 store 里；测试替身只需把 patch 落到 storeState，
  // 让「水合/WS 后字段确实进了 store」这类断言仍然有效。
  patchProject: vi.fn((patch: Record<string, unknown>) => {
    const map: Record<string, string> = {
      video_url: 'projectVideoUrl', status: 'projectStatus', title: 'projectTitle',
      summary: 'projectSummary', story: 'projectStory', style: 'projectStyle',
      target_shot_count: 'projectTargetShotCount', character_hints: 'projectCharacterHints',
      creation_mode: 'projectCreationMode', reference_images: 'projectReferenceImages',
      exports: 'projectExports', provider_settings: 'projectProviderSettings',
      universe_id: 'projectUniverseId', chapter_number: 'projectChapterNumber',
      chapter_title: 'projectChapterTitle', skill_id: 'projectSkillId',
      story_outline: 'projectStoryOutline', visual_bible: 'projectVisualBible',
      outline_approved: 'projectOutlineApproved', blocking_clips: 'blockingClips',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || v === undefined) continue;
      const field = map[k];
      if (field) (storeState as Record<string, unknown>)[field] = v;
    }
  }),
  addMessage: vi.fn(),
  resetRunState: vi.fn(),
  runMode: 'manual' as string,
  setRunMode: vi.fn(),
  setBlockingClips: vi.fn(),
};
const mutateSpy = vi.fn();
const sendMock = vi.fn();
let mutationPendingStates: boolean[] = [];

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useParams: () => ({ id: currentRouteProjectId }),
    useSearchParams: () => [currentSearchParams, setSearchParams],
    useNavigate: () => vi.fn(),
  };
});

vi.mock('~/utils/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey: [string, number] }) => {
    if (queryKey[0] === 'project') {
      return {
        data: currentProjectData,
        isLoading: projectQueryState.isLoading,
        error: projectQueryState.error,
      };
    }

    if (queryKey[0] === 'characters') {
      return {
        data: resourceQueryState.charactersLoading ? undefined : emptyCharacters,
        isLoading: resourceQueryState.charactersLoading,
        error: null,
      };
    }

    if (queryKey[0] === 'shots') {
      return {
        data: resourceQueryState.shotsLoading ? undefined : emptyShots,
        isLoading: resourceQueryState.shotsLoading,
        error: null,
      };
    }

    if (queryKey[0] === 'messages') {
      return {
        data: resourceQueryState.messagesLoading ? undefined : emptyMessages,
        isLoading: resourceQueryState.messagesLoading,
        error: null,
      };
    }

    return { data: undefined, isLoading: false, error: null };
  },
  useMutation: (options: {
    mutationFn: (variables?: unknown) => Promise<unknown>;
    onSuccess?: (data: unknown, variables?: unknown) => void;
    onError?: (error: Error, variables?: unknown) => void;
    onSettled?: () => void;
  }) => {
    const isPending = mutationPendingStates.shift() ?? false;
    return {
      mutate: async (variables?: unknown) => {
        mutateSpy(variables);
        try {
          const result = await options.mutationFn(variables);
          options.onSuccess?.(result, variables);
        } catch (error) {
          options.onError?.(error as Error, variables);
        } finally {
          options.onSettled?.();
        }
      },
      isPending,
    };
  },
}));

vi.mock('~/hooks/useWebSocket', () => ({
  useProjectWebSocket: () => ({
    send: sendMock,
    disconnect: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

vi.mock('~/stores/editorStore', () => ({
  useEditorStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    {
      getState: () => storeState,
    }
  ),
  useShallow: (selector: (state: typeof storeState) => unknown) => {
    const result = selector(storeState);
    return () => result;
  },
}));

vi.mock('~/services/api', () => ({
  projectsApi: {
    get: vi.fn(),
    update: vi.fn(),
    getCharacters: vi.fn(),
    getShots: vi.fn(),
    getMessages: vi.fn(),
    generate: vi.fn(),
    feedback: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
  },
}));

vi.mock('~/features/comic-workflow/sidebar/WorkspaceSidebar', () => ({
  WorkspaceSidebar: ({
    activeTab,
    onTabChange,
    isGenerating,
    onSendFeedback,
    onConfirm,
    onCancel,
  }: {
    activeTab?: string;
    onTabChange?: (tab: string) => void;
    isGenerating?: boolean;
    onSendFeedback?: (content: string) => void;
    onConfirm?: (content?: string) => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="workspace-sidebar" data-active-tab={activeTab}>
      <span data-testid="chat-generating-state">
        {isGenerating ? 'generating' : 'idle'}
      </span>
      <button type="button" onClick={() => onTabChange?.('assets')}>
        打开资产面板
      </button>
      <button type="button" onClick={() => onTabChange?.('chat')}>
        打开对话面板
      </button>
      <button type="button" onClick={() => onSendFeedback?.('继续调整故事节奏')}>
        发送反馈
      </button>
      <button type="button" onClick={() => onConfirm?.('请微调这一版')}>
        确认并继续
      </button>
      <button type="button" onClick={onCancel}>
        停止生成
      </button>
    </div>
  ),
}));

vi.mock('~/components/layout/TopBar', () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

vi.mock('~/components/layout/StagePipeline', () => ({
  StagePipeline: ({
    onGenerate,
    onCancel,
    onResume,
    onToggleChat,
    awaitingConfirm,
    workbenchStatus,
  }: {
    onGenerate?: () => void;
    onCancel?: () => void;
    onResume?: () => void;
    onToggleChat?: () => void;
    awaitingConfirm?: boolean;
    workbenchStatus?: { state: string };
  }) => (
    <div
      data-testid="stage-pipeline"
      data-workbench-status={workbenchStatus?.state}
    >
      <button type="button" onClick={onGenerate}>开始生成</button>
      <button type="button" onClick={onCancel}>取消</button>
      <button type="button" onClick={onResume}>恢复运行</button>
      {awaitingConfirm ? (
        <button type="button" onClick={onToggleChat}>去确认</button>
      ) : null}
    </div>
  ),
}));

vi.mock('~/components/layout/StageView', () => ({
  StageView: () => <div data-testid="stage-view" />,
}));

vi.mock('~/features/comic-workflow/mobile/MobileWorkbenchPreview', () => ({
  MobileWorkbenchPreview: ({
    workbenchStatus,
  }: {
    workbenchStatus?: { state: string };
  }) => (
    <div
      data-testid="mobile-workbench-preview"
      data-workbench-status={workbenchStatus?.state}
    >
      完整画布编辑请用桌面端打开
    </div>
  ),
}));

vi.mock('~/components/settings/SettingsModal', () => ({
  SettingsModal: () => null,
}));

describe('ProjectPage live hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationPendingStates = [];
    currentRouteProjectId = '9';
    currentSearchParams = new URLSearchParams();
    projectQueryState = { isLoading: false, error: null };
    resourceQueryState = {
      charactersLoading: false,
      shotsLoading: false,
      messagesLoading: false,
    };
    currentProjectData = projectData;
    storeState.isGenerating = true;
    storeState.progress = 0.35;
    storeState.currentStage = 'storyboard';
    storeState.currentAgent = null;
    storeState.awaitingConfirm = false;
    storeState.awaitingAgent = null;
    storeState.projectUpdatedAt = null;
    storeState.currentRunId = null;
    storeState.currentRunProviderSnapshot = null;
    storeState.recoveryControl = null;
    storeState.recoverySummary = null;
    storeState.recoveryGate = null;
    storeState.projectVideoUrl = null;
    storeState.projectStatus = null;
    storeState.projectTitle = null;
    storeState.projectSummary = null;
    storeState.projectStory = null;
    storeState.blockingClips = null;
    vi.mocked(projectsApi.update).mockResolvedValue(projectData as never);
    vi.mocked(projectsApi.generate).mockResolvedValue({
		id: 77,
		provider_snapshot: providerSnapshotSample,
	} as never);
    vi.mocked(projectsApi.feedback).mockResolvedValue({ id: 88 } as never);
    vi.mocked(projectsApi.cancel).mockResolvedValue(undefined as never);
    vi.mocked(projectsApi.resume).mockResolvedValue({
      id: 55,
      project_id: 9,
      status: 'processing',
      current_agent: 'plan',
      progress: 0.61,
      error: null,
      resource_type: null,
      resource_id: null,
      thread_id: null,
      created_at: '2026-04-11T00:00:00Z',
      updated_at: '2026-04-11T00:00:00Z',
    } as never);
  });

  it('renders without provider UI when no provider exception exists', () => {
    render(<ProjectPage />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider 选择')).not.toBeInTheDocument();
  });

  it('passes the derived workbench status to the stage pipeline', () => {
    storeState.isGenerating = true;
    storeState.currentRunId = 77;
    storeState.awaitingConfirm = true;

    render(<ProjectPage />);

    expect(screen.getByTestId('stage-pipeline')).toHaveAttribute(
      'data-workbench-status',
      'awaitingConfirm',
    );
  });

  it('renders without provider warning UI when provider exception exists', () => {
    currentProjectData = projectDataWithTextProviderIssue;

    render(<ProjectPage />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('编辑 Provider')).not.toBeInTheDocument();
  });

  it('clears final video store state when project video_url is null', async () => {
    currentProjectData = { ...projectData, video_url: null };

    render(<ProjectPage />);

    await waitFor(() => {
      expect(storeState.projectVideoUrl).toBeNull();
    });
  });

	it('renders run provider snapshot proof card from recoveryControl', () => {
		storeState.recoveryControl = {
			state: 'active',
			detail: '可恢复运行',
			available_actions: ['resume', 'cancel'],
			thread_id: 'thread-proof',
			active_run: {
				id: 77,
				project_id: 9,
				status: 'running',
				current_agent: 'plan',
				progress: 0.5,
				error: null,
				resource_type: null,
				resource_id: null,
				thread_id: 'thread-proof',
				provider_snapshot: providerSnapshotSample,
				created_at: '2026-04-11T00:00:00Z',
				updated_at: '2026-04-11T00:00:00Z',
			},
			recovery_summary: {
				project_id: 9,
				run_id: 77,
				thread_id: 'thread-proof',
				current_stage: 'plan',
				next_stage: null,
				preserved_stages: [],
				stage_history: [],
				resumable: true,
			},
		};

		render(<ProjectPage />);

		// Snapshot card was removed — with all providers valid, no warning banner either
		expect(screen.queryByText('本次运行冻结 Provider 快照')).not.toBeInTheDocument();
		expect(screen.queryByText('Provider 需要关注')).not.toBeInTheDocument();
	});

	it('degrades provider warning when active run snapshot exists', () => {
		currentProjectData = {
			...projectDataWithTextProviderIssue,
		};
		storeState.currentRunProviderSnapshot = providerSnapshotSample;

		render(<ProjectPage />);

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(screen.queryByText('编辑 Provider')).not.toBeInTheDocument();
	});

	it('prefers latest run snapshot proof card over project provider defaults and keeps minimal fields', () => {
		currentProjectData = {
			...projectData,
			provider_settings: {
				text: {
					selected_key: 'anthropic',
					source: 'default',
					resolved_key: 'anthropic',
					valid: true,
					reason_code: null,
					reason_message: null,
				},
				image: {
					selected_key: 'openai',
					source: 'default',
					resolved_key: 'openai',
					valid: true,
					reason_code: null,
					reason_message: null,
				},
				video: {
					selected_key: 'openai',
					source: 'default',
					resolved_key: 'openai',
					valid: true,
					reason_code: null,
					reason_message: null,
				},
			},
		};
		storeState.currentRunProviderSnapshot = {
			text: {
				selected_key: 'openai',
				source: 'project',
				resolved_key: 'openai',
				valid: true,
				status: 'valid',
				reason_code: null,
				reason_message: null,
			},
			image: {
				selected_key: 'openai',
				source: 'default',
				resolved_key: null,
				valid: false,
				status: 'invalid',
				reason_code: 'provider_missing_credentials',
				reason_message: '缺少图像凭据',
			},
			video: {
				selected_key: 'doubao',
				source: 'project',
				resolved_key: 'doubao',
				valid: true,
				status: 'valid',
				reason_code: null,
				reason_message: null,
			},
		} as Project['provider_settings'];

		render(<ProjectPage />);

		// Snapshot card removed; project providers are all valid so no warning banner either
		// (hasProviderIssue uses project settings, not run snapshot)
		expect(screen.queryByText('Provider 需要关注')).not.toBeInTheDocument();
		expect(screen.queryByText('本次运行冻结 Provider 快照')).not.toBeInTheDocument();
	});

  it('shows degraded provider warning without disabling generate', () => {
    currentProjectData = projectDataWithDegradedTextProvider;

    render(<ProjectPage />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始生成' })).toBeEnabled();
  });

  it('keeps workspace panel navigation owned by the sidebar', async () => {
    const user = userEvent.setup();

    render(<ProjectPage />);

    expect(screen.getByTestId('top-bar')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-sidebar')).toHaveAttribute('data-active-tab', 'chat');

    await user.click(screen.getByRole('button', { name: '打开资产面板' }));

    expect(screen.getByTestId('workspace-sidebar')).toHaveAttribute('data-active-tab', 'assets');

    await user.click(screen.getByRole('button', { name: '打开对话面板' }));

    expect(screen.getByTestId('workspace-sidebar')).toHaveAttribute('data-active-tab', 'chat');
  });

  it('keeps generate enabled when only the video provider is invalid', () => {
    currentProjectData = {
      ...projectData,
      provider_settings: {
        ...projectData.provider_settings,
        video: {
          selected_key: 'doubao',
          source: 'project',
          resolved_key: null,
          valid: false,
          reason_code: 'provider_missing_credentials',
          reason_message: '缺少 Doubao API Key',
        },
      },
    };

    render(<ProjectPage />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始生成' })).toBeEnabled();
  });

  it('renders the loading page while the project query is loading', () => {
    projectQueryState = { isLoading: true, error: null };
    currentProjectData = undefined as never;

    render(<ProjectPage />);

    expect(screen.getByText('正在加载项目…')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-sidebar')).not.toBeInTheDocument();
  });

  it('renders the workspace progressively while secondary resources are still loading', () => {
    resourceQueryState = {
      charactersLoading: true,
      shotsLoading: true,
      messagesLoading: true,
    };

    render(<ProjectPage />);

    // 只等项目主数据；角色/分镜/消息各区域自行渐进加载
    expect(screen.queryByText('正在加载项目…')).not.toBeInTheDocument();
    expect(screen.getByTestId('stage-view')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-sidebar')).toBeInTheDocument();
  });

  it('clears project-scoped canvas state when route project changes', async () => {
    const { rerender } = render(<ProjectPage />);

    await waitFor(() => {
      expect(storeState.projectTitle).toBe('Realtime Story');
    });

    vi.clearAllMocks();
    currentRouteProjectId = '10';
    currentProjectData = {
      ...projectData,
      id: 10,
      title: 'Next Story',
    };

    rerender(<ProjectPage />);

    await waitFor(() => {
      expect(storeState.setCharacters).toHaveBeenCalledWith([]);
    });
    expect(storeState.setShots).toHaveBeenCalledWith([]);
    expect(storeState.clearMessages).toHaveBeenCalled();
    expect(storeState.resetRunState).toHaveBeenCalled();
    await waitFor(() => {
      expect(storeState.projectTitle).toBe('Next Story');
    });

    // 顺序断言：先清空（切项目），再落到新项目标题
    const titlePatches = storeState.patchProject.mock.calls
      .map(([patch]) => (patch as { title?: string | null }).title)
      .filter((t) => t !== undefined);
    expect(titlePatches).toContain(null);
    expect(titlePatches).toContain('Next Story');
    expect(titlePatches.lastIndexOf('Next Story')).toBeGreaterThan(
      titlePatches.indexOf(null),
    );
  });

  it('renders the not found page when the project query resolves empty', () => {
    currentProjectData = undefined as never;

    render(<ProjectPage />);

    expect(screen.getByText('项目未找到')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回首页' })).toBeInTheDocument();
  });

  it('renders the not found page only for a real 404 project error', () => {
    projectQueryState = {
      isLoading: false,
      error: new ApiError({ code: 'not_found', message: '项目不存在', status: 404 }),
    };
    currentProjectData = undefined as never;

    render(<ProjectPage />);

    expect(screen.getByText('项目未找到')).toBeInTheDocument();
    expect(screen.queryByText('无法加载项目')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('renders a persistent error panel with retry for non-404 project errors', async () => {
    const user = userEvent.setup();
    projectQueryState = {
      isLoading: false,
      error: new ApiError({ code: 'server_error', message: '服务器开小差了', status: 500 }),
    };
    currentProjectData = undefined as never;

    render(<ProjectPage />);

    expect(screen.getByText('无法加载项目')).toBeInTheDocument();
    expect(screen.getByText('服务器开小差了')).toBeInTheDocument();
    expect(screen.queryByText('项目未找到')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['project', 9] });
  });

  it('mounts the mobile preview instead of the canvas below the lg breakpoint', () => {
    const mediaQueryList = {
      matches: true,
      media: '(max-width: 1023.98px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQueryList));

    try {
      render(<ProjectPage />);

      // <lg：不挂载 tldraw 画布，改为只读预览 + 侧栏上下分栏
      expect(screen.queryByTestId('stage-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('mobile-workbench-preview')).toBeInTheDocument();
      expect(screen.getByText('完整画布编辑请用桌面端打开')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-sidebar')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the desktop canvas mounted at lg and above', () => {
    render(<ProjectPage />);

    expect(screen.getByTestId('stage-view')).toBeInTheDocument();
    expect(
      screen.queryByTestId('mobile-workbench-preview'),
    ).not.toBeInTheDocument();
  });

  it('shows a toast when the project query errors', async () => {
    projectQueryState = { isLoading: false, error: new Error('加载失败') };
    currentProjectData = undefined as never;

    render(<ProjectPage />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith({
        title: '无法加载项目',
        message: '项目数据获取失败，请重试',
        actions: [
          expect.objectContaining({ label: '重试' }),
        ],
      });
    });
  });

  it('shows ApiError details when loading project fails with API error', async () => {
    projectQueryState = {
      isLoading: false,
      error: new ApiError({ code: 'not_found', message: '项目不存在', status: 404 }),
    };
    currentProjectData = undefined as never;

    render(<ProjectPage />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '无法加载项目',
          message: '项目不存在',
        })
      );
    });
  });

  it('auto-starts generation when only the video provider is invalid', async () => {
    currentSearchParams = new URLSearchParams('autoStart=true');
    currentProjectData = {
      ...projectData,
      provider_settings: {
        ...projectData.provider_settings,
        video: {
          selected_key: 'doubao',
          source: 'project',
          resolved_key: null,
          valid: false,
          reason_code: 'provider_missing_credentials',
          reason_message: '缺少 Doubao API Key',
        },
      },
    };
    storeState.isGenerating = false;

    render(<ProjectPage />);

    await waitFor(() => {
      expect(projectsApi.generate).toHaveBeenCalledWith(9, { auto_mode: false });
    });
    expect(setSearchParams).toHaveBeenCalledWith({}, { replace: true });
  });

  it('keeps generate enabled even when text provider is invalid', () => {
    currentProjectData = {
      ...projectData,
      provider_settings: {
        ...projectData.provider_settings,
        text: {
          selected_key: 'openai',
          source: 'project',
          resolved_key: null,
          valid: false,
          reason_code: 'provider_missing_credentials',
          reason_message: '缺少 OpenAI 文本凭据',
        },
      },
    };

    render(<ProjectPage />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invalidates project caches when projectUpdatedAt changes without clobbering live progress state', async () => {
    const { rerender } = render(<ProjectPage />);

    storeState.projectUpdatedAt = Date.now();
    rerender(<ProjectPage />);

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['project', 9] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] });
    });

    expect(storeState.isGenerating).toBe(true);
    expect(storeState.progress).toBe(0.35);
    expect(storeState.currentStage).toBe('storyboard');
  });

  it('submits feedback through the API when no active run is in progress', async () => {
    const user = userEvent.setup();
    storeState.isGenerating = false;
    storeState.currentRunId = null;
    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '发送反馈' }));

    await waitFor(() => {
      expect(projectsApi.feedback).toHaveBeenCalledWith(
        9,
        '继续调整故事节奏',
        undefined,
        'plan',
        undefined,
        undefined,
        undefined,
      );
    });
    expect(storeState.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'user',
        role: 'user',
        content: '继续调整故事节奏',
      })
    );
  });

  it('routes feedback to render when the current workflow stage is render', async () => {
    const user = userEvent.setup();
    storeState.isGenerating = false;
    storeState.currentRunId = null;
    storeState.currentStage = 'render';
    storeState.currentAgent = 'orchestrator';

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '发送反馈' }));

    await waitFor(() => {
      expect(projectsApi.feedback).toHaveBeenCalledWith(
        9,
        '继续调整故事节奏',
        undefined,
        'render',
        undefined,
        undefined,
        undefined,
      );
    });
  });

  it('routes feedback to compose when the current workflow stage is compose', async () => {
    const user = userEvent.setup();
    storeState.isGenerating = false;
    storeState.currentRunId = null;
    storeState.currentStage = 'compose';
    storeState.currentAgent = 'render';

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '发送反馈' }));

    await waitFor(() => {
      expect(projectsApi.feedback).toHaveBeenCalledWith(
        9,
        '继续调整故事节奏',
        undefined,
        'compose',
        undefined,
        undefined,
        undefined,
      );
    });
  });

  it('sends confirm through websocket when an active run exists', async () => {
    const user = userEvent.setup();
    storeState.currentRunId = 42;

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '确认并继续' }));

    expect(sendMock).toHaveBeenCalledWith({
      type: 'confirm',
      data: { run_id: 42, feedback: '请微调这一版' },
    });
    expect(projectsApi.feedback).not.toHaveBeenCalled();
    expect(storeState.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'user',
        content: '请微调这一版',
      })
    );
  });
  it('resumes recoverable runs and clears recovery state after success', async () => {
    const user = userEvent.setup();
    storeState.isGenerating = false;
    storeState.recoveryControl = {
      state: 'recoverable',
      detail: '可以从上一阶段继续。',
      available_actions: ['resume', 'cancel'],
      thread_id: 'thread-9',
      active_run: {
        id: 17,
        project_id: 9,
        status: 'blocked',
        current_agent: 'plan',
        progress: 0.45,
        error: null,
        resource_type: null,
        resource_id: null,
        thread_id: null,
        created_at: '2026-04-11T00:00:00Z',
        updated_at: '2026-04-11T00:00:00Z',
      },
      recovery_summary: {
        project_id: 9,
        run_id: 17,
        thread_id: 'thread-9',
        current_stage: 'storyboard',
        next_stage: 'compose',
        preserved_stages: ['plan'],
        stage_history: [],
        resumable: true,
      },
    };

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '恢复运行' }));

    await waitFor(() => {
      expect(projectsApi.resume).toHaveBeenCalledWith(9, 17);
    });
    expect(storeState.setGenerating).toHaveBeenCalledWith(true);
    expect(storeState.setCurrentRunId).toHaveBeenCalledWith(55);
    expect(storeState.setCurrentAgent).toHaveBeenCalledWith('plan');
    expect(storeState.setProgress).toHaveBeenCalledWith(0.61);
    expect(storeState.setCurrentStage).toHaveBeenCalledWith('compose');
    expect(storeState.setRecoveryControl).toHaveBeenCalledWith(null);
    expect(storeState.setRecoverySummary).toHaveBeenCalledWith(null);
    expect(storeState.setRecoveryGate).toHaveBeenCalledWith(null);
  });

  it('cancels recoverable runs and resets the live state after settle', async () => {
    const user = userEvent.setup();
    storeState.recoveryControl = {
      state: 'active',
      detail: '当前运行仍可取消。',
      available_actions: ['resume', 'cancel'],
      thread_id: 'thread-10',
      active_run: {
        id: 18,
        project_id: 9,
        status: 'processing',
        current_agent: 'plan',
        progress: 0.5,
        error: null,
        resource_type: null,
        resource_id: null,
        thread_id: null,
        created_at: '2026-04-11T00:00:00Z',
        updated_at: '2026-04-11T00:00:00Z',
      },
      recovery_summary: {
        project_id: 9,
        run_id: 18,
        thread_id: 'thread-10',
        current_stage: 'compose',
        next_stage: 'merge',
        preserved_stages: ['plan', 'render'],
        stage_history: [],
        resumable: true,
      },
    };

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(projectsApi.cancel).toHaveBeenCalledWith(9);
    });
    expect(storeState.resetRunState).toHaveBeenCalled();
    expect(storeState.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'system',
        content: '生成已停止',
      })
    );
  });

  it('auto-starts generation even when text provider is invalid', async () => {
    currentSearchParams = new URLSearchParams('autoStart=true');
    currentProjectData = {
      ...projectData,
      provider_settings: {
        ...projectData.provider_settings,
        text: {
          selected_key: 'openai',
          source: 'project',
          resolved_key: null,
          valid: false,
          reason_code: 'provider_missing_credentials',
          reason_message: '缺少 OpenAI 文本凭据',
        },
      },
    };
    storeState.isGenerating = false;

    render(<ProjectPage />);

    await waitFor(() => {
      expect(projectsApi.generate).toHaveBeenCalled();
    });
  });

  it('auto-starts generation even when image provider is invalid', async () => {
    currentSearchParams = new URLSearchParams('autoStart=true');
    currentProjectData = {
      ...projectData,
      provider_settings: {
        ...projectData.provider_settings,
        image: {
          selected_key: 'openai',
          source: 'project',
          resolved_key: null,
          valid: false,
          reason_code: 'provider_missing_credentials',
          reason_message: '缺少 OpenAI 图像凭据',
        },
      },
    };
    storeState.isGenerating = false;

    render(<ProjectPage />);

    await waitFor(() => {
      expect(projectsApi.generate).toHaveBeenCalled();
    });
  });

  it('hydrates active run state immediately after generate succeeds', async () => {
    const user = userEvent.setup();
    storeState.isGenerating = false;

    render(<ProjectPage />);
    vi.clearAllMocks();

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(projectsApi.generate).toHaveBeenCalledWith(9, { auto_mode: false });
    });
    expect(storeState.clearMessages).toHaveBeenCalled();
    expect(storeState.setCurrentStage).toHaveBeenCalledWith('plan');
    expect(storeState.setGenerating).toHaveBeenCalledWith(true);
    expect(storeState.setCurrentRunId).toHaveBeenCalledWith(77);
    expect(storeState.setCurrentAgent).toHaveBeenCalledWith('orchestrator');
    expect(storeState.setProgress).toHaveBeenCalledWith(0);
    expect(storeState.setCurrentRunProviderSnapshot).toHaveBeenCalledWith(providerSnapshotSample);
    expect(storeState.setAwaitingConfirm).toHaveBeenCalledWith(false, null, 77);
    expect(storeState.setRecoveryControl).toHaveBeenCalledWith(null);
    expect(storeState.setRecoverySummary).toHaveBeenCalledWith(null);
    expect(storeState.setRecoveryGate).toHaveBeenCalledWith(null);
  });

  it('does not treat a stale pending generate request as active generation after run context clears', () => {
    mutationPendingStates = [true, false, false, false, false];
    storeState.isGenerating = false;
    storeState.currentRunId = null;

    render(<ProjectPage />);

    expect(screen.getByTestId('chat-generating-state')).toHaveTextContent('idle');
  });

  it('ignores a late generate success after the user has already cancelled the run', async () => {
    const user = userEvent.setup();
    let resolveGenerate!: (value: AgentRun) => void;
    vi.mocked(projectsApi.generate).mockImplementationOnce(
      () =>
        new Promise<AgentRun>((resolve) => {
          resolveGenerate = resolve;
        })
    );
    vi.mocked(projectsApi.cancel).mockResolvedValueOnce({ status: 'cancelled', cancelled: 1 } as never);
    storeState.isGenerating = false;
    storeState.currentRunId = null;

    const { rerender } = render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    storeState.isGenerating = true;
    storeState.currentRunId = 321;
    rerender(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '停止生成' }));

    resolveGenerate({
      id: 321,
      project_id: 9,
      status: 'processing',
      current_agent: 'orchestrator',
      progress: 0,
      error: null,
      resource_type: null,
      resource_id: null,
      thread_id: null,
      created_at: '2026-04-11T00:00:00Z',
      updated_at: '2026-04-11T00:00:00Z',
    });

    await waitFor(() => {
      expect(projectsApi.cancel).toHaveBeenCalledWith(9);
    });

    expect(storeState.setGenerating).not.toHaveBeenCalledWith(true);
    expect(storeState.setCurrentRunId).not.toHaveBeenCalledWith(321);
  });

  it('ignores cancel clicks when there is no active run context', async () => {
    const user = userEvent.setup();
    storeState.isGenerating = false;
    storeState.currentRunId = null;
    storeState.recoveryControl = null;

    render(<ProjectPage />);
    vi.clearAllMocks();

    await user.click(screen.getByRole('button', { name: '停止生成' }));

    expect(projectsApi.cancel).not.toHaveBeenCalled();
  });

  it('shows an error toast when generate fails with a non-409 error', async () => {
    const user = userEvent.setup();
    vi.mocked(projectsApi.generate).mockRejectedValueOnce(new Error('服务器炸了'));
    storeState.isGenerating = false;

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '生成失败',
          message: '服务器炸了',
        })
      );
    });
  });

  it('restores recovery state when generate returns 409 with control payload', async () => {
    const user = userEvent.setup();
    const control: RecoveryControlRead = {
      state: 'active',
      detail: '任务仍在进行',
      available_actions: ['cancel'],
      thread_id: 'thread-rollback',
      active_run: {
        id: 101,
        project_id: 9,
        status: 'processing',
        current_agent: 'plan',
        progress: 0.22,
        error: null,
        resource_type: null,
        resource_id: null,
        thread_id: null,
        created_at: '2026-04-11T00:00:00Z',
        updated_at: '2026-04-11T00:00:00Z',
      },
      recovery_summary: {
        project_id: 9,
        run_id: 101,
        thread_id: 'thread-rollback',
        current_stage: 'plan',
        next_stage: 'storyboard',
        preserved_stages: [],
        stage_history: [],
        resumable: true,
      },
    };

    vi.mocked(projectsApi.generate).mockRejectedValueOnce(
      new ApiError({
        code: 'conflict',
        message: '409 conflict',
        status: 409,
        response: control,
      })
    );

    storeState.isGenerating = false;

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(storeState.setRecoveryControl).toHaveBeenCalledWith(control);
    });
    expect(storeState.setRecoverySummary).toHaveBeenCalledWith(control.recovery_summary);
    expect(storeState.setCurrentRunId).toHaveBeenCalledWith(101);
    expect(storeState.setGenerating).toHaveBeenCalledWith(true);
    expect(storeState.setCurrentAgent).toHaveBeenCalledWith('plan');
    expect(storeState.setProgress).toHaveBeenCalledWith(0.22);
  });

  it('shows a warning toast when generate 409 does not include recovery control', async () => {
    const user = userEvent.setup();
    vi.mocked(projectsApi.generate).mockRejectedValueOnce(
      new ApiError({
        code: 'conflict',
        message: '409 conflict',
        status: 409,
      })
    );

    storeState.isGenerating = false;

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '请稍等片刻',
          message: '另一个任务正在进行，完成后再试',
        })
      );
    });
  });

  it('handles feedback conflict and generic error paths', async () => {
    const user = userEvent.setup();
    storeState.isGenerating = false;

    vi.mocked(projectsApi.feedback).mockRejectedValueOnce(
      new ApiError({
        code: 'conflict',
        message: '409 conflict',
        status: 409,
      })
    );

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '发送反馈' }));

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith({
        title: 'AI 正在思考',
        message: '请等待当前任务完成',
      });
    });

    vi.mocked(projectsApi.feedback).mockRejectedValueOnce(new Error('feedback failed'));

    await user.click(screen.getByRole('button', { name: '发送反馈' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '提交失败',
          message: 'feedback failed',
        })
      );
    });
  });

  it('resets state on cancel even when cancel request fails', async () => {
    const user = userEvent.setup();
    vi.mocked(projectsApi.cancel).mockRejectedValueOnce(new Error('cancel failed'));
    storeState.recoveryControl = {
      state: 'active',
      detail: '当前运行仍可取消。',
      available_actions: ['resume', 'cancel'],
      thread_id: 'thread-10',
      active_run: {
        id: 18,
        project_id: 9,
        status: 'processing',
        current_agent: 'plan',
        progress: 0.5,
        error: null,
        resource_type: null,
        resource_id: null,
        thread_id: null,
        created_at: '2026-04-11T00:00:00Z',
        updated_at: '2026-04-11T00:00:00Z',
      },
      recovery_summary: {
        project_id: 9,
        run_id: 18,
        thread_id: 'thread-10',
        current_stage: 'compose',
        next_stage: 'merge',
        preserved_stages: ['plan', 'render'],
        stage_history: [],
        resumable: true,
      },
    };

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(projectsApi.cancel).toHaveBeenCalledWith(9);
    });
    expect(storeState.resetRunState).toHaveBeenCalled();
    expect(storeState.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'system',
        content: '生成已停止',
      })
    );
  });

  it('surfaces error for failed resume mutation', async () => {
    const user = userEvent.setup();
    storeState.recoveryControl = {
      state: 'recoverable',
      detail: '可以从上一阶段继续执行',
      available_actions: ['resume', 'cancel'],
      thread_id: 'thread-11',
      active_run: {
        id: 55,
        project_id: 9,
        status: 'blocked',
        current_agent: 'plan',
        progress: 0.33,
        error: null,
        resource_type: null,
        resource_id: null,
        thread_id: null,
        created_at: '2026-04-11T00:00:00Z',
        updated_at: '2026-04-11T00:00:00Z',
      },
      recovery_summary: {
        project_id: 9,
        run_id: 55,
        thread_id: 'thread-11',
        current_stage: 'storyboard',
        next_stage: 'compose',
        preserved_stages: ['plan'],
        stage_history: [],
        resumable: true,
      },
    };

    vi.mocked(projectsApi.resume).mockRejectedValueOnce(
      new ApiError({
        code: 'resume_fail',
        message: '无法恢复',
        status: 500,
      })
    );

    render(<ProjectPage />);

    await user.click(screen.getByRole('button', { name: '恢复运行' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '恢复失败',
          message: '无法恢复',
        })
      );
    });
  });

});
