import { Link } from "react-router-dom";
import { Card } from "~/components/ui/Card";
import type { Universe } from "~/types";
import { SparklesIcon, UsersIcon, TrashIcon } from "@heroicons/react/24/outline";

interface UniverseCardProps {
	universe: Universe;
	onDelete: (universe: Universe) => void;
}

function formatDate(value: string | null | undefined) {
	if (!value) return "未知";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "未知";
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

export function UniverseCard({ universe, onDelete }: UniverseCardProps) {
	return (
		<div className="group relative" data-shell="universe-card">
			<Link to={`/universes/${universe.id}`} className="block">
				<Card className="h-full !p-3 transition-[box-shadow,transform] duration-fast hover:-translate-y-px hover:shadow-brutal">
					{universe.cover_image_url ? (
						<div className="-mx-1 -mt-1 mb-2 h-20 overflow-hidden rounded-md border border-base-content/10">
							<img
								src={universe.cover_image_url}
								alt={universe.name}
								className="h-full w-full object-cover"
								width={320}
								height={80}
								loading="lazy"
							/>
						</div>
					) : null}

					{/* 无封面时不放装饰占位；顶行给有区分度的更新时间 */}
					<p className="m-0 font-mono text-2xs tracking-wide text-bc-muted">
						更新 {formatDate(universe.updated_at)}
					</p>
					<h2 className="m-0 mt-0.5 font-heading text-md font-bold leading-snug">
						{universe.name}
					</h2>

					{universe.description ? (
						<p className="m-0 mt-1 line-clamp-2 text-xs text-bc-muted">
							{universe.description}
						</p>
					) : (
						<p className="m-0 mt-1 text-2xs text-bc-muted">
							尚未填写简介
						</p>
					)}

					<div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs font-semibold text-bc-muted">
						<span className="inline-flex items-center gap-1 rounded-full border border-base-content/10 bg-base-200 px-1.5 py-0.5 tabular-nums">
							<SparklesIcon className="h-3 w-3" aria-hidden="true" />
							{universe.projects_count} 章节
						</span>
						<span className="inline-flex items-center gap-1 rounded-full border border-base-content/10 bg-base-200 px-1.5 py-0.5 tabular-nums">
							<UsersIcon className="h-3 w-3" aria-hidden="true" />
							{universe.shared_characters_count} 角色
						</span>
					</div>
				</Card>
			</Link>

			<button
				type="button"
				className="absolute right-1.5 top-1.5 rounded-full border border-base-content/10 bg-base-100/95 p-1.5 text-bc-muted opacity-0 transition-[opacity,color,background-color] duration-fast hover:bg-error/15 hover:text-error group-hover:opacity-100 focus-visible:opacity-100"
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onDelete(universe);
				}}
				title="删除宇宙"
				aria-label={`删除宇宙 ${universe.name}`}
			>
				<TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}
