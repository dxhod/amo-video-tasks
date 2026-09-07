import { Task } from "@/components/task";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <Task id={(await params).id} />;
}
