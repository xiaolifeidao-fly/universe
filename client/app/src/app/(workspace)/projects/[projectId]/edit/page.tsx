import { redirect } from "next/navigation";

export default function ProjectEditPage({ params }: { params: { projectId: string } }) {
  redirect(`/projects/${params.projectId}`);
}
