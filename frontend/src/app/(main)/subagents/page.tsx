import { Suspense } from "react";
import { SubagentsPage } from "@/components/subagents/subagents-page";

export default function SubagentsRoute() {
  return (
    <Suspense fallback={null}>
      <SubagentsPage />
    </Suspense>
  );
}
