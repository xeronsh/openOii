import type {
  ImageProviderKey,
  ProjectProviderOverridesPayload,
  TextProviderKey,
  VideoProviderKey,
} from "~/types";

type ProviderModality = "text" | "image" | "video";
type ProviderKey = TextProviderKey | ImageProviderKey | VideoProviderKey;
type ProviderOption = "inherit-default" | ProviderKey;

interface ProviderFieldConfig {
  modality: ProviderModality;
  title: string;
  description: string;
  overrideKey: keyof ProjectProviderOverridesPayload;
  options: readonly ProviderOption[];
}

type ProviderDefaultKeys = Record<ProviderModality, ProviderKey>;

interface ProviderSelectionFieldsProps {
  value: ProjectProviderOverridesPayload;
  onChange: (next: ProjectProviderOverridesPayload) => void;
  disabled?: boolean;
  defaultKeys?: Partial<ProviderDefaultKeys>;
}

export const TEXT_PROVIDER_OPTIONS = [
  "inherit-default",
  "anthropic",
  "openai",
  "fake",
] as const;
export const IMAGE_PROVIDER_OPTIONS = [
  "inherit-default",
  "openai",
  "modelscope",
  "fake",
] as const;
export const VIDEO_PROVIDER_OPTIONS = [
  "inherit-default",
  "openai",
  "doubao",
  "fake",
] as const;

const PROVIDER_FIELDS: ProviderFieldConfig[] = [
  {
    modality: "text",
    title: "文本",
    description: "用于故事理解、脚本与提示词推导。",
    overrideKey: "text_provider_override",
    options: TEXT_PROVIDER_OPTIONS,
  },
  {
    modality: "image",
    title: "图像",
    description: "用于角色图、分镜首帧与静态视觉资产。",
    overrideKey: "image_provider_override",
    options: IMAGE_PROVIDER_OPTIONS,
  },
  {
    modality: "video",
    title: "视频",
    description: "用于镜头动画与最终片段生成。",
    overrideKey: "video_provider_override",
    options: VIDEO_PROVIDER_OPTIONS,
  },
];

const FALLBACK_DEFAULT_KEYS: ProviderDefaultKeys = {
  text: "anthropic",
  image: "modelscope",
  video: "openai",
};

function getProviderLabel(key: string): string {
  switch (key) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "modelscope":
      return "ModelScope";
    case "doubao":
      return "Doubao";
    case "fake":
      return "Fake（本地测试）";
    default:
      return key;
  }
}

export function ProviderSelectionFields({
  value,
  onChange,
  disabled = false,
  defaultKeys,
}: ProviderSelectionFieldsProps) {
  const resolvedDefaultKeys: ProviderDefaultKeys = {
    ...FALLBACK_DEFAULT_KEYS,
    ...defaultKeys,
  };

  return (
    <div className="space-y-4">
      {PROVIDER_FIELDS.map((field) => {
        const selectedValue = value[field.overrideKey] ?? "inherit-default";

        return (
          <fieldset
            key={field.modality}
            className="rounded-xl border border-base-300 bg-base-200/60 p-4"
          >
            <legend className="px-2 text-sm font-semibold text-base-content">
              {field.title}
            </legend>
            <p className="mb-3 text-sm text-bc-muted">{field.description}</p>

            <div className="space-y-2">
              {field.options.map((option) => {
                const optionId = `${field.modality}-${option}`;
                const isInherit = option === "inherit-default";
                const currentDefaultKey = resolvedDefaultKeys[field.modality];
                const optionLabel = isInherit
                  ? `继承默认（当前：${getProviderLabel(currentDefaultKey)}）`
                  : getProviderLabel(option);

                return (
                  <label
                    key={option}
                    htmlFor={optionId}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-base-300 bg-base-100 px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-base-100"
                  >
                    <input
                      id={optionId}
                      type="radio"
                      name={`${field.modality}-provider`}
                      className="radio radio-sm"
                      checked={selectedValue === option}
                      disabled={disabled}
                      onChange={() =>
                        onChange({
                          ...value,
                          [field.overrideKey]: isInherit ? null : option,
                        })
                      }
                    />
                    <span>{optionLabel}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
