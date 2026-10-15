import {
  Bot,
  Boxes,
  Cpu,
  FileCode2,
  GitCompare,
  Image as ImageIcon,
  MessageSquare,
  MonitorPlay,
  ScrollText,
  Terminal,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import type { Mode, RightPanelTab } from '@/types';

/** Mode → icon, shared by the header switcher and the command palette. */
export const MODE_ICONS: Record<Mode, LucideIcon> = {
  agent: Bot,
  chat: MessageSquare,
  image: ImageIcon,
  embeddings: Boxes,
  audio: Waves,
};

/** Right panel tab → icon. */
export const TAB_ICONS: Record<RightPanelTab, LucideIcon> = {
  editor: FileCode2,
  diff: GitCompare,
  terminal: Terminal,
  preview: MonitorPlay,
  logs: ScrollText,
  model: Cpu,
};
