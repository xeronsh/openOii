import { clsx } from "clsx";
import { useQuery } from "@tanstack/react-query";
import { skillsApi } from "~/services/api";
import { SvgIcon } from "~/components/ui/SvgIcon";
import {
	journeyForSkill,
	SKILL_CATALOG,
	skillFromApi,
	type SkillPreset,
} from "~/features/skills/skillCatalog";

interface SkillWallProps {
	activeSkillId: string | null;
	onSelect: (skill: SkillPreset) => void;
	/** Optional externally-resolved catalog (Home may pass shared list) */
	skills?: SkillPreset[];
	/** 上次使用的工作流：解释「为什么它被预选」 */
	lastUsedId?: string | null;
}

/**
 * 工作流选项卡墙：紧凑选项卡（标题 + 一行描述），不带区块标题——
 * 区块语法由外层 DeskSection 提供。选中态除 primary 边框/底纹外，
 * 必须保留勾选图标作为非颜色的第二通道。
 */
export function SkillWall({
	activeSkillId,
	onSelect,
	skills,
	lastUsedId,
}: SkillWallProps) {
	const { data: apiSkills } = useQuery({
		queryKey: ["skills"],
		queryFn: () => skillsApi.list(),
		staleTime: 60_000,
		enabled: !skills,
	});

	const catalog: SkillPreset[] =
		skills ??
		(apiSkills?.length
			? apiSkills.map((row, i) => skillFromApi(row, i))
			: SKILL_CATALOG);

	return (
		<ul
			className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3"
			data-shell="skill-wall"
			aria-label="选择工作流"
		>
			{catalog.map((skill) => {
				const active = activeSkillId === skill.id;
				const journey = journeyForSkill(skill);
				return (
					<li key={skill.id} className="min-w-0">
						<button
							type="button"
							onClick={() => onSelect(skill)}
							aria-pressed={active}
							className={clsx(
								"flex h-full w-full flex-col gap-0.5 rounded-md border-2 px-2 py-1.5 text-left",
								"transition-[border-color,background-color] duration-fast",
								"",
								active
									? "halftone-bg-accent border-primary bg-primary/5"
									: "border-base-content/10 bg-base-100 hover:border-primary/40",
							)}
						>
							<span className="flex items-center justify-between gap-1">
								<span className="flex min-w-0 items-center gap-1">
									<span className="truncate font-heading text-sm font-bold leading-snug">
										{skill.title}
									</span>
									{/* fallback 目录三张全是 core，逐张标「核心」是噪声——只标 new */}
									{skill.badge === "new" ? (
										<span className="shrink-0 rounded bg-primary/15 px-1 font-mono text-2xs font-bold uppercase leading-tight text-primary-ink">
											NEW
										</span>
									) : null}
									{lastUsedId === skill.id ? (
										<span className="shrink-0 rounded bg-base-content/10 px-1 text-2xs leading-tight text-bc-muted">
											上次使用
										</span>
									) : null}
								</span>
								{active ? (
									<SvgIcon
										name="check"
										size={14}
										className="shrink-0 text-primary-ink"
									/>
								) : null}
							</span>
							<span className="block truncate text-2xs leading-snug text-bc-muted">
								{skill.description}
							</span>
							{/* 旅程线：选这条路会经过哪些阶段、停几次——选择前就该知道 */}
							<span className="mt-0.5 block truncate font-mono text-2xs leading-snug text-bc-muted">
								{journey.stages.join(" → ")}
								<span className="text-bc-subtle"> · </span>
								{journey.pace}
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
