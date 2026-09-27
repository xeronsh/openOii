export interface CreationInterviewQuestion {
	label: string;
	question: string;
	placeholder: string;
	suggestions: string[];
}

export type CreationInterviewAnswer = CreationInterviewQuestion & { answer: string };

const STATE_MARKER = "\n\n<!-- openoii-interview-v1 -->\n";
const FINAL_MARKER = "创作访谈补充：";

function isAnswer(value: unknown): value is CreationInterviewAnswer {
	if (!value || typeof value !== "object") return false;
	const answer = value as Partial<CreationInterviewAnswer>;
	return typeof answer.label === "string"
		&& typeof answer.question === "string"
		&& typeof answer.answer === "string"
		&& typeof answer.placeholder === "string"
		&& Array.isArray(answer.suggestions);
}

export function readCreationInterview(story: string | null): {
	story: string;
	answers: CreationInterviewAnswer[];
} {
	const value = story ?? "";
	const stateIndex = value.lastIndexOf(STATE_MARKER);
	if (stateIndex >= 0) {
		try {
			const parsed: unknown = JSON.parse(value.slice(stateIndex + STATE_MARKER.length));
			return {
				story: value.slice(0, stateIndex).trimEnd(),
				answers: Array.isArray(parsed) ? parsed.filter(isAnswer) : [],
			};
		} catch {
			return { story: value.trim(), answers: [] };
		}
	}

	const finalIndex = value.lastIndexOf(FINAL_MARKER);
	if (finalIndex < 0) return { story: value.trim(), answers: [] };
	const answers = value.slice(finalIndex + FINAL_MARKER.length)
		.split(/\n{2,}/)
		.map((entry) => {
			const match = entry.trim().match(/^(.+?)（(.+?)）：([\s\S]+)$/);
			return match
				? {
					label: match[1],
					question: match[2],
					answer: match[3],
					placeholder: "重新输入你的回答…",
					suggestions: [] as string[],
				}
				: null;
		})
		.filter((answer): answer is CreationInterviewAnswer => answer !== null);
	return { story: value.slice(0, finalIndex).trimEnd(), answers };
}

export function saveCreationInterview(
	story: string,
	answers: CreationInterviewAnswer[],
): string {
	return story.trimEnd() + STATE_MARKER + JSON.stringify(answers);
}

export function finalizeCreationInterview(
	story: string,
	answers: CreationInterviewAnswer[],
): string {
	return [
		story.trim(),
		...(answers.length
			? [
				FINAL_MARKER,
				...answers.map(({ label, question, answer }) => label + "（" + question + "）：" + answer),
			]
			: []),
	].filter(Boolean).join("\n\n");
}

export function hasSavedCreationInterview(story: string | null): boolean {
	return Boolean(story && (story.includes(STATE_MARKER) || story.includes(FINAL_MARKER)));
}
