import {
  Settings,
  Cpu,
  Timer,
  Plug,
  Wifi,
  CreditCard,
  BarChart3,
  Brain,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface SettingsTab {
  id: string;
  icon: LucideIcon;
  labelKey: string;
}

export const SETTINGS_TABS = [
  { id: "general", icon: Settings, labelKey: "tabGeneral" },
  { id: "providers", icon: Cpu, labelKey: "tabProviders" },
  { id: "permissions", icon: ShieldCheck, labelKey: "tabPermissions" },
  { id: "automations", icon: Timer, labelKey: "tabAutomations" },
  { id: "plugins", icon: Plug, labelKey: "tabPlugins" },
  { id: "remote", icon: Wifi, labelKey: "tabRemote" },
  { id: "billing", icon: CreditCard, labelKey: "tabBilling" },
  { id: "usage", icon: BarChart3, labelKey: "tabUsage" },
  { id: "memory", icon: Brain, labelKey: "tabMemory" },
] as const satisfies readonly SettingsTab[];

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];
