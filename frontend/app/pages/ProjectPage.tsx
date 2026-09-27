import { useParams } from "react-router-dom";
import { ProjectWorkbench } from "~/features/workbench/ProjectWorkbench";

export function ProjectPage() {
	const { id } = useParams<{ id: string }>();
	return <ProjectWorkbench projectId={parseInt(id || "0", 10)} />;
}
