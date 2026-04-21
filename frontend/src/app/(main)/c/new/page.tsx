"use client";

import { Suspense } from "react";
import { Landing } from "@/components/chat/landing";

export default function NewChatPage() {
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  );
}
