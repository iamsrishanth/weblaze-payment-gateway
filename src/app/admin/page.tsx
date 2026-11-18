import AdminTerminal from "@/app/admin/AdminTerminal";
import LoginForm from "@/app/admin/LoginForm";
import { getAdminTerminalData } from "@/lib/server/admin-data";
import { getAdminSession } from "@/lib/server/auth/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  const session = await getAdminSession();
  if (!session) return <LoginForm />;
  const data = await getAdminTerminalData();
  return <AdminTerminal initialData={data} adminEmail={session.email} />;
}
