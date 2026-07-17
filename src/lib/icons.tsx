"use client"

/**
 * Phosphor → lucide name aliases.
 *
 * Every icon the app uses is re-exported here under its previous
 * lucide-react name. Components keep their existing import shape
 * (`import { Folder, Plus, ... } from "@/lib/icons"`); switching the
 * underlying library is one file.
 *
 * Default weight is set globally to "duotone" via PhosphorIconProvider
 * in icon-provider.tsx — wrap the React tree once and every icon
 * renders in the duotone style. Individual call sites can still
 * override with weight="bold" / "fill" / etc.
 *
 * Where lucide and Phosphor disagree on names, we pick the closest
 * visual match:
 *
 *   AlertTriangle → Warning            Settings → Gear
 *   ChevronDown → CaretDown            Save → FloppyDisk
 *   Search → MagnifyingGlass           DollarSign → CurrencyDollar
 *   Home → House                       Zap → Lightning
 *   Mail → Envelope                    RefreshCw → ArrowsClockwise
 *   Filter → Funnel                    Wand2 → Wand
 *   Trash2 → Trash                     TerminalSquare → TerminalWindow
 *   Loader2 → CircleNotch (spinning)
 *
 * For PanelLeftClose / PanelLeftOpen we use the same SidebarSimple
 * glyph for both states — the surrounding context (toggle button)
 * already communicates open vs closed via tooltip + position.
 */

export {
  Anchor,
  AppWindow,
  ArrowCounterClockwise as RotateCcw,
  ArrowsClockwise as RefreshCw,
  Bell,
  BookOpen,
  Bookmark,
  Brain,
  Bug,
  Calculator,
  Calendar,
  Camera,
  CaretDown as ChevronDown,
  CaretRight,
  CaretRight as ChevronRight,
  ChartBar as BarChart3,
  ChartLine as LineChart,
  ChartPie as PieChart,
  CheckCircle as CheckCircle2,
  CircleNotch as Loader2,
  Clipboard as ClipboardCopy,
  ClipboardText as ClipboardPaste,
  Clock,
  Coffee,
  Compass,
  CornersOut as Maximize2,
  Cpu,
  Check,
  DotsSix as Grip,
  DotsSixVertical as GripVertical,
  Cube as Box,
  CurrencyDollar as DollarSign,
  Database,
  SquaresFour as LayoutDashboard,
  Download,
  Envelope as Mail,
  Eye,
  Feather,
  FileCode as FileCode2,
  FileCsv,
  FileText,
  Flag,
  FlowArrow,
  FloppyDisk as Save,
  Folder,
  FolderOpen,
  GraphicsCard,
  Funnel as Filter,
  Gear as Settings,
  GitBranch,
  Globe,
  Gift,
  GraduationCap,
  Hammer,
  Hash,
  Heart,
  House as Home,
  Key as KeyRound,
  Lightbulb,
  Lightning as Zap,
  Lock,
  MagicWand as Wand2,
  MagnifyingGlass as Search,
  MagnifyingGlassMinus as ZoomOut,
  MagnifyingGlassPlus as ZoomIn,
  MapTrifold as Map,
  Minus,
  MusicNotes as Music,
  Package,
  Palette,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Pulse as Activity,
  Quotes as Quote,
  Rabbit,
  Rocket,
  Shield,
  ShoppingCart,
  SidebarSimple as PanelLeftClose,
  Sigma,
  SlidersHorizontal as Settings2,
  SortAscending,
  SortDescending,
  Sparkle as Sparkles,
  Stack as Boxes,
  StackSimple as Layers,
  Star,
  Sun,
  Table as Table2,
  Tag,
  Target,
  TerminalWindow as TerminalSquare,
  Trash as Trash2,
  TreeStructure,
  TrendUp as TrendingUp,
  Trophy,
  UploadSimple as Upload,
  Users,
  Warning as AlertTriangle,
  Wrench,
  X,
  XCircle,
} from "@phosphor-icons/react"

export type { Icon as LucideIcon } from "@phosphor-icons/react"

// SidebarSimple covers both open/close states; surrounding tooltip
// disambiguates. Re-export it under the second name separately so we
// don't have a duplicate-binding error in the main export block above.
export { SidebarSimple as PanelLeftOpen } from "@phosphor-icons/react"

// Voice (TTS/STT) aliases.
export {
  Microphone as Mic,
  SpeakerHigh as Volume2,
  SpeakerSlash as VolumeX,
  Waveform as Waveform,
} from "@phosphor-icons/react"
