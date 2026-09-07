import { Admin } from "@/components/admin";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <Admin id={(await params).id} />;
}
