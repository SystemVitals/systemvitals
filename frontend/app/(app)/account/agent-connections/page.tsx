import { redirect } from "next/navigation";

export default function AgentConnectionsRoute() {
  redirect("/account#personal-access-tokens");
}
