import { Card } from "~/components/ui/Card";
import { Button } from "~/components/ui/Button";
import type { SharedCharacterRead } from "~/types";
import { getStaticUrl } from "~/services/api";
import { UserIcon } from "@heroicons/react/24/outline";

interface SharedCharacterCardProps {
	character: SharedCharacterRead;
	onImport?: (character: SharedCharacterRead) => void;
	showImport?: boolean;
}

export function SharedCharacterCard({
	character,
	onImport,
	showImport = false,
}: SharedCharacterCardProps) {
	const imageUrl = getStaticUrl(character.canonical_image_url);
	const tags = character.character_tags
		? character.character_tags.split(",").map((t) => t.trim()).filter(Boolean)
		: [];

	return (
		<Card
			className="flex h-full flex-col !p-2.5 text-left"
			data-shell="shared-character-card"
		>
			<div className="mb-1.5 flex items-center gap-2">
				{imageUrl ? (
					<div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border-2 border-primary/25">
						<img
							src={imageUrl}
							alt={character.name}
							className="h-full w-full object-cover"
							width={40}
							height={40}
							loading="lazy"
						/>
					</div>
				) : (
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border-2 border-base-content/10 bg-base-200">
						<UserIcon className="h-4 w-4 text-base-content/30" aria-hidden="true" />
					</div>
				)}
				<div className="min-w-0 flex-1">
					<p className="m-0 font-mono text-2xs uppercase tracking-wide text-bc-muted">
						cast
					</p>
					<h3 className="m-0 truncate font-heading text-sm font-bold">
						{character.name}
					</h3>
				</div>
				<span className="shrink-0 font-mono text-2xs tabular-nums text-bc-muted">
					v{character.version}
				</span>
			</div>

			{tags.length > 0 ? (
				<div className="mb-1 flex flex-wrap gap-0.5">
					{tags.slice(0, 3).map((tag) => (
						<span
							key={tag}
							className="rounded-full border border-primary/15 bg-primary/10 px-1.5 py-px font-bold text-2xs text-primary-ink"
						>
							{tag}
						</span>
					))}
				</div>
			) : null}

			{character.description ? (
				<p className="m-0 line-clamp-2 flex-1 text-2xs text-bc-muted">
					{character.description}
				</p>
			) : (
				<p className="m-0 flex-1 text-2xs text-bc-muted">
					无描述
				</p>
			)}

			{showImport && onImport ? (
				<Button
					size="sm"
					variant="secondary"
					className="mt-2 w-full !h-7 !min-h-7 text-2xs"
					onClick={() => onImport(character)}
				>
					导入章节
				</Button>
			) : null}
		</Card>
	);
}
