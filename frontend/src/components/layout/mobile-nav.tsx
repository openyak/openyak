"use client";

import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarHeader } from "./sidebar-header";
import { SessionList } from "./session-list";
import { SidebarFooter } from "./sidebar-footer";
import { useSidebarStore } from "@/stores/sidebar-store";

export function MobileNav() {
  const { isOpen, setOpen } = useSidebarStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <Sheet open={isOpen} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden fixed top-3 left-3 z-40 h-8 w-8"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle sidebar</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="p-0 w-[260px]">
        <TooltipProvider delayDuration={200}>
          <div className="flex flex-col h-full">
            <SidebarHeader />
            <SessionList />
            <SidebarFooter />
          </div>
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}
