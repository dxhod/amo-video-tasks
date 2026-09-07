import { Board } from "@/components/board";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <Board id={(await params).id} />;
}
